import json, urllib.error, datetime, re
from linear_mcp import LinearClient, STATE_ROOT
from linear_config import connections
from concurrent.futures import ThreadPoolExecutor

def matches_user(issue, user_id):
    return issue.get('createdById') == user_id or issue.get('assigneeId') == user_id


def project_prefix(title):
    match = re.match(r'^\s*<([^<>]+)>', title)
    if not match:
        return None, 'missing_project_prefix'
    project = match.group(1).strip()
    if not project:
        return None, 'empty_project_prefix'
    if len(re.findall(r'<[^<>]+>', title)) != 1:
        return None, 'multiple_project_prefixes'
    return project, None


def scan(config, state):
    connection, name, workspace_id, user_id = config
    client = LinearClient(connection)
    call = client.call
    issues, seen = [], set()
    cursor = None
    while True:
        args = {'limit': 250, 'includeArchived': False, 'fields': ['id', 'uuid', 'title', 'status', 'statusType', 'createdById', 'assigneeId', 'teamId', 'url', 'updatedAt']}
        if cursor:
            args['cursor'] = cursor
        page = call('list_issues', args)
        issues.extend(page.get('issues', []))
        if not page.get('hasNextPage'):
            break
        cursor = page.get('cursor') or page.get('nextCursor') or page.get('endCursor')
        if not cursor or cursor in seen:
            raise RuntimeError('Pagination incomplete')
        seen.add(cursor)
    pending = [issue for issue in issues if issue.get('statusType') in {'backlog', 'unstarted', 'triage'}]
    checks, unknown = {}, []
    for issue in pending:
        if matches_user(issue, user_id):
            continue
        if not issue.get('createdById') or not issue.get('assigneeId'):
            # Old creator-only cache entries cannot establish assignment.
            cached = state.get('identityChecks', {}).get(name, {}).get(issue['id'])
            if cached and cached.get('updatedAt') == issue.get('updatedAt'):
                issue['createdById'] = cached.get('createdById')
                issue['assigneeId'] = cached.get('assigneeId')
            else:
                detail = call('get_issue', {'id': issue['uuid']})
                creator = detail.get('creator')
                assignee = detail.get('assignee')
                issue['createdById'] = detail.get('createdById') or detail.get('creatorId') or (creator.get('id') if isinstance(creator, dict) else None)
                issue['assigneeId'] = detail.get('assigneeId') or (assignee.get('id') if isinstance(assignee, dict) else None)
                checks[issue['id']] = {'createdById': issue['createdById'], 'assigneeId': issue['assigneeId'], 'updatedAt': issue.get('updatedAt'), 'detailCheckedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        if not matches_user(issue, user_id) and (not issue.get('createdById') or not issue.get('assigneeId')):
            unknown.append(issue['id'])
    matched = [issue for issue in pending if matches_user(issue, user_id)]
    candidates, unroutable = [], []
    for issue in matched:
        project, reason = project_prefix(issue['title'])
        if project:
            candidates.append({**issue, 'projectName': project})
        else:
            unroutable.append({**issue, 'reason': reason})
    return {
        'workspace': name, 'workspaceId': workspace_id, 'scannedIssueCount': len(issues),
        'pendingIssues': candidates, 'unroutableIssues': unroutable,
        'trackedIssues': [issue for issue in issues if workspace_id + ':' + issue.get('uuid', '') in state.get('issues', {})],
        'identityChecks': checks, 'unconfirmedIdentitySkipped': unknown,
        'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }


def main():
    state_file = STATE_ROOT / 'state.json'
    state = json.loads(state_file.read_text()) if state_file.exists() else {'issues': {}}
    configs = [(alias, row['workspaceName'], row['workspaceId'], row['userId'])
               for alias, row in connections().items()]
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = {config[1]: pool.submit(scan, config, state) for config in configs}
        for name, future in futures.items():
            try:
                print(json.dumps(future.result(), ensure_ascii=False), flush=True)
            except urllib.error.HTTPError as exc:
                print(json.dumps({'workspace': name, 'error': 'HTTP ' + str(exc.code)}), flush=True)
            except Exception as exc:
                print(json.dumps({'workspace': name, 'error': str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__}), flush=True)


if __name__ == '__main__':
    main()

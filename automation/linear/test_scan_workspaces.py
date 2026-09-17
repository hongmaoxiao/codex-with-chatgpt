import unittest
from unittest.mock import patch
import scan_workspaces as scanner


class EligibilityTests(unittest.TestCase):
    def test_creator_or_assignee_can_independently_match(self):
        for issue in [{'createdById': 'user', 'assigneeId': 'other'},
                      {'createdById': 'other', 'assigneeId': 'user'},
                      {'createdById': 'user'}, {'assigneeId': 'user'}]:
            with self.subTest(issue=issue):
                self.assertTrue(scanner.matches_user(issue, 'user'))

    def test_names_and_unrelated_ids_do_not_match(self):
        for issue in [{}, {'createdById': 'other', 'assigneeId': 'other'},
                      {'assignee': 'Example User', 'createdBy': 'example-user'}]:
            self.assertFalse(scanner.matches_user(issue, 'user'))

    def test_project_name_must_be_a_single_nonempty_leading_prefix(self):
        self.assertEqual(scanner.project_prefix('  < gold-clad-silver >问题'), ('gold-clad-silver', None))
        for title in ['普通问题', '问题<project>', '<>问题', '<  >问题', '<one><two>问题', '<one>问题<two>']:
            with self.subTest(title=title):
                self.assertIsNone(scanner.project_prefix(title)[0])

    def test_scan_paginates_assignment_matches_and_requires_prefix(self):
        def issue(key, **values):
            return {'id': key, 'uuid': key, 'title': '<project>问题', 'statusType': 'backlog', 'updatedAt': 'now', **values}
        pages = [
            {'issues': [issue('creator', createdById='user'), issue('assigned', createdById='other', assigneeId='user')], 'hasNextPage': True, 'nextCursor': 'page2'},
            {'issues': [issue('no-prefix', title='问题', assigneeId='user'), issue('other', createdById='other', assigneeId='other'), issue('done', createdById='user', statusType='completed'), issue('detail', createdById='other')], 'hasNextPage': False},
        ]
        def call(tool, args):
            if tool == 'list_issues':
                self.assertIn('assigneeId', args['fields'])
                return pages[1] if args.get('cursor') else pages[0]
            self.assertEqual((tool, args['id']), ('get_issue', 'detail'))
            return {'createdById': 'other', 'assigneeId': 'user'}
        # An old creator-only cache must not hide a newly relevant assignment.
        state = {'issues': {}, 'creatorChecks': {'workspace': {'detail': {'createdById': 'other', 'updatedAt': 'now'}}}}
        with patch.object(scanner, 'LinearClient') as client:
            client.return_value.call.side_effect = call
            result = scanner.scan(('connection', 'workspace', 'workspace-id', 'user'), state)
        self.assertEqual([i['id'] for i in result['pendingIssues']], ['creator', 'assigned', 'detail'])
        self.assertEqual([i['id'] for i in result['unroutableIssues']], ['no-prefix'])
        self.assertEqual(result['identityChecks']['detail']['assigneeId'], 'user')


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Maintain the customized fork without changing a live checkout before validation.

check/prepare never commit, publish, reset or discard work. install accepts only a
fast-forward to the fork's exact main commit with successful GitHub Actions checks.
It builds in a separate checkout and keeps the previous runtime for recovery.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import urllib.parse
import uuid


class MaintenanceError(RuntimeError):
    pass


def command(root, args, check=True, visible=False, timeout=60):
    result = subprocess.run(args, cwd=root, text=True, timeout=timeout,
                            stdout=sys.stderr if visible else subprocess.PIPE,
                            stderr=sys.stderr if visible else subprocess.PIPE,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0'})
    if check and result.returncode:
        raise MaintenanceError(f'{args[0]} {args[1]} failed (exit {result.returncode}); the operation was not completed')
    return result


def git(root, *args):
    return command(root, ['git', *args]).stdout.strip()


def ancestor(root, older, newer):
    result = command(root, ['git', 'merge-base', '--is-ancestor', older, newer], check=False)
    if result.returncode not in (0, 1):
        raise MaintenanceError('Cannot establish commit ancestry')
    return result.returncode == 0


def policy(root):
    value = json.loads((root / 'maintenance.json').read_text())
    for field in ('fork', 'upstream'):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', value[field]):
            raise MaintenanceError('Invalid repository in maintenance policy')
    if value['branch'] != 'main' or not re.fullmatch(r'[0-9a-f]{40}', value['customizationAnchor']):
        raise MaintenanceError('Invalid stable branch or customization anchor')
    checks = value.get('requiredChecks', [])
    if not checks or any(not isinstance(name, str) or not name for name in checks):
        raise MaintenanceError('At least one named verification check is required')
    return value


def repository_name(url):
    if url.startswith('git@github.com:'):
        name = url[len('git@github.com:'):]
    else:
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname != 'github.com' or parsed.username or parsed.password:
            raise MaintenanceError('Expected a GitHub SSH or HTTPS remote without embedded credentials')
        name = parsed.path.lstrip('/')
    return name.rstrip('/').removesuffix('.git')


def verify_remote(root, remote, expected):
    if repository_name(git(root, 'remote', 'get-url', remote)).lower() != expected.lower():
        raise MaintenanceError(f'{remote} does not point to the configured repository')


def fetch(root, remote):
    git(root, 'fetch', '--no-tags', remote, f'refs/heads/main:refs/remotes/{remote}/main')
    return git(root, 'rev-parse', '--verify', f'refs/remotes/{remote}/main^{{commit}}')


@contextmanager
def repository_lock(root):
    common = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))
    # Kernel-owned locks are released on process exit; no stale-time guessing.
    with (common / 'c2c-maintenance.lock').open('a+b') as handle:
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                if not handle.read(1):
                    handle.write(b'0')
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise MaintenanceError('MAINTENANCE_BUSY: another process owns the repository lock') from None
        yield


def check_updates(root, include_upstream=True):
    rules = policy(root)
    verify_remote(root, 'origin', rules['fork'])
    installed = git(root, 'rev-parse', 'HEAD')
    fork = fetch(root, 'origin')
    if not ancestor(root, rules['customizationAnchor'], fork):
        raise MaintenanceError('Fork main no longer contains the customization anchor; refusing replacement')
    dirty = bool(git(root, 'status', '--porcelain'))
    forward = ancestor(root, installed, fork)
    marker = root / 'dist' / '.c2c-installed-commit'
    runtime_ready = marker.is_file() and marker.read_text().strip() == fork and (root / 'node_modules').is_dir()
    result = {'ok': True, 'installedCommit': installed, 'forkCommit': fork,
            'updateAvailable': not dirty and forward and (installed != fork or not runtime_ready),
            'runtimeReady': runtime_ready,
            'localChanges': dirty, 'localAhead': installed != fork and ancestor(root, fork, installed),
            'diverged': not forward and not ancestor(root, fork, installed)}
    if include_upstream:
        verify_remote(root, 'upstream', rules['upstream'])
        upstream = fetch(root, 'upstream')
        result.update(upstreamCommit=upstream, upstreamUpdateAvailable=not ancestor(root, upstream, fork))
    return result


def prepare(root):
    with repository_lock(root):
        status = check_updates(root)
        if not status['upstreamUpdateAvailable']:
            return {**status, 'prepared': False}
        revision = status['upstreamCommit']
        branch = 'codex/sync-upstream-' + revision[:12]
        worktree = root / '.tooling' / 'maintenance' / ('upstream-' + revision[:12])
        if worktree.exists():
            if (git(worktree, 'symbolic-ref', '--short', 'HEAD') != branch
                    or git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir') != git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')):
                raise MaintenanceError('Existing synchronization directory belongs to another branch')
            return {**status, 'prepared': True, 'resumed': True, 'branch': branch, 'worktree': str(worktree)}
        worktree.parent.mkdir(parents=True, exist_ok=True)
        git(root, 'worktree', 'add', '-b', branch, str(worktree), status['forkCommit'])
        result = command(worktree, ['git', 'merge', '--no-overwrite-ignore', '--no-commit', '--no-ff', revision], check=False)
        conflicts = git(worktree, 'diff', '--name-only', '--diff-filter=U').splitlines()
        if result.returncode and not conflicts:
            raise MaintenanceError('Upstream merge failed; inspect the preserved synchronization worktree')
        return {**status, 'prepared': True, 'resumed': False, 'branch': branch,
                'worktree': str(worktree), 'conflicts': conflicts}


def verify(root, store_dir=None):
    install = ['corepack', 'pnpm', 'install', '--frozen-lockfile', '--registry=https://registry.npmjs.org']
    if store_dir:
        install += ['--store-dir', str(store_dir)]
    commands = [install, ['corepack', 'pnpm', 'typecheck'], ['corepack', 'pnpm', 'build'],
                ['corepack', 'pnpm', 'exec', 'vitest', 'run', '--reporter=default', '--reporter=json', '--outputFile=.tooling/verification.json'],
                [sys.executable, 'scripts/check_verification.py', '.tooling/verification.json'],
                [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests/maintenance', '-p', 'test_*.py'],
                [sys.executable, '-m', 'unittest', 'discover', '-s', 'automation/linear', '-p', 'test_*.py']]
    for args in commands:
        command(root, args, visible=True, timeout=900)
    return {'ok': True, 'verifiedCommit': git(root, 'rev-parse', 'HEAD')}


def evaluate_checks(runs, commit, required):
    verified = []
    for name in required:
        matching = [run for run in runs if run.get('name') == name
                    and run.get('head_sha') == commit and run.get('app', {}).get('slug') == 'github-actions']
        latest = max(matching, key=lambda run: run['id'], default={})
        if latest.get('status') != 'completed' or latest.get('conclusion') != 'success':
            raise MaintenanceError(f'CHECKS_NOT_PASSED: {name} is missing, pending or failed for this exact commit')
        verified.append({'name': name, 'id': latest['id'], 'url': latest.get('details_url')})
    return verified


def github_checks(rules, commit):
    pages = json.loads(command(None, ['gh', 'api', '--paginate', '--slurp',
                                      f"repos/{rules['fork']}/commits/{commit}/check-runs?per_page=100"]).stdout)
    return evaluate_checks([run for page in pages for run in page['check_runs']], commit, rules['requiredChecks'])


def staged_skill(source, destination, checkout, staging):
    if destination.exists():
        shutil.copytree(destination, staging)
    old = (destination / 'SKILL.md').read_text() if (destination / 'SKILL.md').exists() else ''
    shutil.copytree(source / 'skill', staging, dirs_exist_ok=True)
    body = (staging / 'SKILL.md').read_text().replace('<ACTUAL_CHECKOUT_PATH>', str(checkout))
    # Preserve the existing machine-specific extension without publishing it.
    marker = '## Local network compatibility on this Mac'
    if marker in old and marker not in body:
        body = body.rstrip() + '\n\n' + marker + old.split(marker, 1)[1]
    (staging / 'SKILL.md').write_text(body.rstrip() + '\n')


def activate(root, candidate, previous, target, skill_destination):
    if git(candidate, 'rev-parse', 'HEAD') != target or git(candidate, 'status', '--porcelain'):
        raise MaintenanceError('The candidate no longer matches the verified commit')
    if git(root, 'rev-parse', 'HEAD') != previous or git(root, 'status', '--porcelain'):
        raise MaintenanceError('Installation changed during validation; preserved the candidate for retry')
    backup = root / '.tooling' / 'maintenance' / ('backup-' + previous[:12] + '-' + uuid.uuid4().hex[:8])
    backup.mkdir(parents=True)
    # Stage beside the destination so the final directory swaps are atomic.
    skill_destination.parent.mkdir(parents=True, exist_ok=True)
    skill_stage = skill_destination.parent / ('.c2c-skill-' + uuid.uuid4().hex)
    staged_skill(candidate, skill_destination, root, skill_stage)
    swaps = []
    changed_head = False
    try:
        (candidate / 'dist' / '.c2c-installed-commit').write_text(target + '\n')
        git(root, 'merge', '--no-overwrite-ignore', '--ff-only', target)
        changed_head = True
        for name in ('node_modules', 'dist'):
            destination = root / name
            saved = backup / name
            existed = destination.exists()
            if existed:
                destination.rename(saved)
            swaps.append((destination, saved if existed else None))
            (candidate / name).rename(destination)
        saved_skill = skill_destination.parent / ('.c2c-skill-backup-' + uuid.uuid4().hex)
        existed = skill_destination.exists()
        if existed:
            skill_destination.rename(saved_skill)
        swaps.append((skill_destination, saved_skill if existed else None))
        skill_stage.rename(skill_destination)
        command(root, ['node', 'bin/c2c.js', '--version'])
    except Exception:
        for destination, saved in reversed(swaps):
            if destination.exists():
                shutil.rmtree(destination)
            if saved:
                saved.rename(destination)
        # This rolls back only our own local fast-forward, never a remote ref.
        if changed_head and git(root, 'rev-parse', 'HEAD') == target and not git(root, 'status', '--porcelain'):
            git(root, 'reset', '--keep', previous)
        raise
    finally:
        if skill_stage.exists():
            shutil.rmtree(skill_stage)
    return str(backup)


def install(root, codex_home):
    with repository_lock(root):
        if git(root, 'symbolic-ref', '--short', 'HEAD') != 'main':
            raise MaintenanceError('Install must target the saved main checkout, not a task worktree')
        status = check_updates(root, include_upstream=False)
        if status['localChanges'] or status['localAhead'] or status['diverged']:
            raise MaintenanceError('Local changes or divergent commits must be preserved; automatic installation refused')
        if not status['updateAvailable']:
            return {**status, 'alreadyInstalled': True}
        target = status['forkCommit']
        checks = github_checks(policy(root), target)
        candidate = root / '.tooling' / 'maintenance' / ('install-' + target[:12])
        if candidate.exists():
            if (git(candidate, 'rev-parse', 'HEAD') != target or git(candidate, 'status', '--porcelain')
                    or git(candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir') != git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')):
                raise MaintenanceError('Existing installation candidate has changes; inspect it without resetting')
        else:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            git(root, 'worktree', 'add', '--detach', str(candidate), target)
        verify(candidate, root / '.tooling' / 'pnpm-store')
        if git(candidate, 'status', '--porcelain'):
            raise MaintenanceError('Verification changed candidate source files; installation was not modified')
        backup = activate(root, candidate, status['installedCommit'], target, codex_home / 'skills' / 'codex-with-chatgpt')
        return {'ok': True, 'installedCommit': target, 'previousCommit': status['installedCommit'],
                'checks': checks, 'backup': backup, 'runtimeStatePreserved': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'prepare', 'verify', 'install'])
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--client-only', action='store_true', help='check the stable fork without contacting upstream')
    parser.add_argument('--codex-home', type=Path, default=Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))))
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        if args.action == 'check':
            result = check_updates(root, include_upstream=not args.client_only)
        elif args.action == 'prepare':
            result = prepare(root)
        elif args.action == 'verify':
            result = verify(root)
        else:
            result = install(root, args.codex_home.resolve())
        print(json.dumps(result))
    except (MaintenanceError, subprocess.TimeoutExpired, OSError, ValueError, KeyError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()

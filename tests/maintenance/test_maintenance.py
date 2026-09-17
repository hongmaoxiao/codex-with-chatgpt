import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[2] / 'scripts' / 'maintenance.py'
SPEC = importlib.util.spec_from_file_location('maintenance', MODULE)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class MaintenanceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name).resolve()
        self.root = self.directory / 'repo'
        self.root.mkdir()
        env = {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull,
               'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
               'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'}
        environment = patch.dict(os.environ, env)
        environment.start()
        self.addCleanup(environment.stop)
        m.git(self.root, 'init', '-b', 'main')
        (self.root / '.gitignore').write_text('.tooling/\nnode_modules/\ndist/\n')
        (self.root / 'base.txt').write_text('base')
        m.git(self.root, 'add', '.')
        m.git(self.root, 'commit', '-m', 'base')
        self.base = m.git(self.root, 'rev-parse', 'HEAD')

    def candidate(self, broken=False):
        candidate = self.directory / 'candidate'
        m.git(self.root, 'worktree', 'add', '-b', 'candidate', str(candidate))
        (candidate / 'bin').mkdir()
        (candidate / 'bin' / 'c2c.js').write_text('process.exit(1);' if broken else "console.log('test-version');")
        (candidate / 'skill').mkdir()
        (candidate / 'skill' / 'SKILL.md').write_text('checkout: <ACTUAL_CHECKOUT_PATH>\n')
        m.git(candidate, 'add', '.')
        m.git(candidate, 'commit', '-m', 'candidate')
        target = m.git(candidate, 'rev-parse', 'HEAD')
        for root, label in [(candidate, 'new'), (self.root, 'old')]:
            for name in ('node_modules', 'dist'):
                (root / name).mkdir()
                (root / name / 'marker').write_text(label)
        return candidate, target

    def skill(self):
        destination = self.directory / 'skills' / 'codex-with-chatgpt'
        destination.mkdir(parents=True)
        (destination / 'SKILL.md').write_text('old skill\n## Local network compatibility on this Mac\nprivate machine note\n')
        (destination / 'personal.txt').write_text('keep this extension')
        return destination

    def test_activation_keeps_machine_settings_and_old_runtime(self):
        candidate, target = self.candidate()
        skill = self.skill()
        backup = Path(m.activate(self.root, candidate, self.base, target, skill))
        self.assertEqual(m.git(self.root, 'rev-parse', 'HEAD'), target)
        self.assertEqual((self.root / 'dist' / 'marker').read_text(), 'new')
        self.assertEqual((backup / 'dist' / 'marker').read_text(), 'old')
        self.assertIn('private machine note', (skill / 'SKILL.md').read_text())
        self.assertIn(str(self.root), (skill / 'SKILL.md').read_text())
        self.assertEqual((skill / 'personal.txt').read_text(), 'keep this extension')

    def test_failed_activation_restores_code_runtime_and_skill(self):
        candidate, target = self.candidate(broken=True)
        skill = self.skill()
        before = (skill / 'SKILL.md').read_text()
        with self.assertRaises(m.MaintenanceError):
            m.activate(self.root, candidate, self.base, target, skill)
        self.assertEqual(m.git(self.root, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual((self.root / 'dist' / 'marker').read_text(), 'old')
        self.assertEqual((self.root / 'node_modules' / 'marker').read_text(), 'old')
        self.assertEqual((skill / 'SKILL.md').read_text(), before)

    def test_activation_refuses_concurrent_user_edits(self):
        candidate, target = self.candidate()
        (self.root / 'base.txt').write_text('user edit')
        with self.assertRaisesRegex(m.MaintenanceError, 'changed during validation'):
            m.activate(self.root, candidate, self.base, target, self.skill())
        self.assertEqual((self.root / 'base.txt').read_text(), 'user edit')
        self.assertEqual(m.git(self.root, 'rev-parse', 'HEAD'), self.base)

    def test_activation_does_not_overwrite_ignored_machine_files(self):
        candidate, _ = self.candidate()
        (self.root / '.git' / 'info' / 'exclude').write_text('machine-private.txt\n')
        (self.root / 'machine-private.txt').write_text('preserve machine value')
        (candidate / 'machine-private.txt').write_text('upstream tracked value')
        m.git(candidate, 'add', '-f', 'machine-private.txt')
        m.git(candidate, 'commit', '-m', 'track previously ignored name')
        target = m.git(candidate, 'rev-parse', 'HEAD')
        self.assertEqual(m.git(self.root, 'status', '--porcelain'), '')
        with self.assertRaises(m.MaintenanceError):
            m.activate(self.root, candidate, self.base, target, self.skill())
        self.assertEqual((self.root / 'machine-private.txt').read_text(), 'preserve machine value')
        self.assertEqual(m.git(self.root, 'rev-parse', 'HEAD'), self.base)

    def test_repository_lock_is_exclusive_and_released(self):
        with m.repository_lock(self.root):
            with self.assertRaisesRegex(m.MaintenanceError, 'BUSY'):
                with m.repository_lock(self.root):
                    self.fail('duplicate lock')
        with m.repository_lock(self.root):
            pass

    def test_checks_require_the_exact_commit_and_latest_success(self):
        run = {'id': 1, 'name': 'verify', 'head_sha': self.base, 'status': 'completed',
               'conclusion': 'success', 'app': {'slug': 'github-actions'}}
        self.assertEqual(m.evaluate_checks([run], self.base, ['verify'])[0]['id'], 1)
        for bad in [{**run, 'head_sha': 'another'}, {**run, 'app': {'slug': 'another'}},
                    {**run, 'id': 2, 'status': 'in_progress'}, {**run, 'id': 2, 'conclusion': 'failure'}]:
            runs = [run, bad] if bad['id'] == 2 else [bad]
            with self.assertRaisesRegex(m.MaintenanceError, 'CHECKS_NOT_PASSED'):
                m.evaluate_checks(runs, self.base, ['verify'])

    def test_fork_sync_preserves_custom_changes_and_resumes_without_reset(self):
        upstream = self.directory / 'upstream.git'
        fork = self.directory / 'fork.git'
        m.command(self.directory, ['git', 'clone', '--bare', str(self.root), str(upstream)])
        rules = {'fork': 'owner/fork', 'upstream': 'author/source', 'branch': 'main',
                 'customizationAnchor': self.base, 'requiredChecks': ['verify']}
        (self.root / 'maintenance.json').write_text(json.dumps(rules))
        (self.root / 'custom.txt').write_text('keep customization')
        m.git(self.root, 'add', '.')
        m.git(self.root, 'commit', '-m', 'customization')
        installed = m.git(self.root, 'rev-parse', 'HEAD')
        m.command(self.directory, ['git', 'clone', '--bare', str(self.root), str(fork)])
        m.git(self.root, 'remote', 'add', 'origin', str(fork))
        m.git(self.root, 'remote', 'add', 'upstream', str(upstream))
        author = self.directory / 'author'
        m.command(self.directory, ['git', 'clone', str(upstream), str(author)])
        (author / 'new.txt').write_text('new upstream capability')
        m.git(author, 'add', '.')
        m.git(author, 'commit', '-m', 'upstream update')
        m.git(author, 'push', 'origin', 'main')
        with patch.object(m, 'verify_remote'):
            prepared = m.prepare(self.root)
            worktree = Path(prepared['worktree'])
            self.assertEqual((worktree / 'custom.txt').read_text(), 'keep customization')
            self.assertEqual((worktree / 'new.txt').read_text(), 'new upstream capability')
            (worktree / 'custom.txt').write_text('work in progress')
            self.assertTrue(m.prepare(self.root)['resumed'])
            self.assertEqual((worktree / 'custom.txt').read_text(), 'work in progress')
        self.assertEqual(m.git(self.root, 'rev-parse', 'HEAD'), installed)


if __name__ == '__main__':
    unittest.main()

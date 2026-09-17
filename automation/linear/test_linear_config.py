import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import linear_config
import install


class LocalConfigurationTests(unittest.TestCase):
    def source(self, root):
        source = root / 'source'
        source.mkdir()
        environment = patch.dict(os.environ, {'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull,
                                 'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.invalid',
                                 'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.invalid'})
        environment.start()
        self.addCleanup(environment.stop)
        install.git(source, 'init', '-b', 'main')
        (source / '.gitignore').write_text('dist/\n')
        scripts = source / 'automation' / 'linear'
        scripts.mkdir(parents=True)
        for name in install.FILES:
            (scripts / name).write_text('# verified fixture source\n')
        install.git(source, 'add', '.')
        install.git(source, 'commit', '-m', 'verified source')
        (source / 'dist').mkdir()
        (source / 'dist' / '.c2c-installed-commit').write_text(install.git(source, 'rev-parse', 'HEAD'))
        return source

    def test_configuration_is_external_and_validates_identifiers(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(linear_config, 'STATE_ROOT', Path(directory)):
            with self.assertRaisesRegex(RuntimeError, 'machine-local'):
                linear_config.connections()
            config = {'connections': {'linear_example': {
                'workspaceId': '00000000-0000-0000-0000-000000000001',
                'userId': '00000000-0000-0000-0000-000000000002',
                'workspaceName': 'example', 'keychainAccount': 'synthetic-account'}}}
            path = Path(directory) / 'config.json'
            path.write_text(json.dumps(config))
            self.assertEqual(linear_config.connections(), config['connections'])
            config['connections']['../../outside'] = config['connections'].pop('linear_example')
            path.write_text(json.dumps(config))
            with self.assertRaisesRegex(RuntimeError, 'alias'):
                linear_config.connections()

    def test_install_preserves_state_and_configuration_and_detects_local_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.source(root)
            repository = patch.object(install, 'REPO_ROOT', source)
            repository.start()
            self.addCleanup(repository.stop)
            (root / 'config.json').write_text('private local identities')
            (root / 'state.json').write_text('existing claims')
            install.install(root)
            self.assertEqual((root / 'config.json').read_text(), 'private local identities')
            self.assertEqual((root / 'state.json').read_text(), 'existing claims')
            install.install(root)
            helper = root / 'tooling' / 'linear_mcp.py'
            helper.write_text(helper.read_text() + '\n# local customization\n')
            with self.assertRaisesRegex(RuntimeError, 'LOCAL_HELPER_CHANGES'):
                install.install(root)
            self.assertIn('local customization', helper.read_text())

    def test_unverified_or_dirty_source_cannot_install_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = self.source(root)
            with patch.object(install, 'REPO_ROOT', source):
                marker = source / 'dist' / '.c2c-installed-commit'
                revision = marker.read_text()
                marker.write_text('not-the-installed-commit')
                with self.assertRaisesRegex(RuntimeError, 'exact core revision'):
                    install.install(root / 'state')
                marker.write_text(revision)
                install.git(source, 'checkout', '-b', 'unverified-candidate')
                with self.assertRaisesRegex(RuntimeError, 'activated main'):
                    install.install(root / 'state')
                install.git(source, 'checkout', 'main')
                (source / 'automation' / 'linear' / 'linear_mcp.py').write_text('uncommitted change')
                with self.assertRaisesRegex(RuntimeError, 'clean'):
                    install.install(root / 'state')
                self.assertFalse((root / 'state' / 'tooling').exists())


if __name__ == '__main__':
    unittest.main()

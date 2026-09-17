#!/usr/bin/env python3
"""Install versioned helpers without replacing local identities, grants or state."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from linear_config import STATE_ROOT

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / 'scripts'))
from maintenance import git, repository_lock

FILES = ('linear_config.py', 'linear_mcp.py', 'scan_workspaces.py',
         'test_linear_mcp.py', 'test_scan_workspaces.py')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verified_source(root):
    if git(root, 'symbolic-ref', '--short', 'HEAD') != 'main' or git(root, 'status', '--porcelain'):
        raise RuntimeError('Install helpers only from the clean, activated main checkout')
    revision = git(root, 'rev-parse', 'HEAD')
    marker = root / 'dist' / '.c2c-installed-commit'
    if not marker.is_file() or marker.read_text().strip() != revision:
        raise RuntimeError('Install and verify this exact core revision before updating helpers')
    return revision


def install(state_root, adopt_existing=False):
    with repository_lock(REPO_ROOT):
        revision = verified_source(REPO_ROOT)
        return install_locked(state_root, revision, adopt_existing)


def install_locked(state_root, revision, adopt_existing):
    destination = state_root / 'tooling'
    receipt = state_root / 'tooling-installation.json'
    if destination.is_symlink():
        raise RuntimeError('The helper directory is a symlink; inspect its owner before installing')
    if destination.exists():
        if not receipt.exists() and not adopt_existing:
            raise RuntimeError('Existing unmanaged helpers: inspect them, then use --adopt-existing for the initial migration')
        if receipt.exists():
            previous = json.loads(receipt.read_text())
            for name, expected in previous['sha256'].items():
                if not (destination / name).is_file() or digest(destination / name) != expected:
                    raise RuntimeError('LOCAL_HELPER_CHANGES: preserve local edits and integrate them into the fork first')
    state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = state_root / ('.tooling-stage-' + uuid.uuid4().hex)
    backup = state_root / ('.tooling-backup-' + uuid.uuid4().hex)
    if destination.exists():
        shutil.copytree(destination, stage)
    else:
        stage.mkdir(mode=0o700)
    try:
        shutil.rmtree(stage / '__pycache__', ignore_errors=True)
        for name in FILES:
            blob = subprocess.run(['git', 'show', f'{revision}:automation/linear/{name}'], cwd=REPO_ROOT,
                                  capture_output=True, check=True).stdout
            (stage / name).write_bytes(blob)
        manifest = {'sourceCommit': revision, 'sha256': {name: digest(stage / name) for name in FILES}}
        manifest_stage = state_root / ('.installation-' + uuid.uuid4().hex + '.json')
        manifest_stage.write_text(json.dumps(manifest, indent=2) + '\n')
        manifest_stage.chmod(0o600)
        existed = destination.exists()
        if existed:
            destination.rename(backup)
        try:
            stage.rename(destination)
            manifest_stage.replace(receipt)
        except Exception:
            if destination.exists():
                shutil.rmtree(destination)
            if existed:
                backup.rename(destination)
            raise
    finally:
        if stage.exists():
            shutil.rmtree(stage)
    return {'ok': True, 'stateRoot': str(state_root), 'sourceCommit': revision,
            'localConfigPreserved': True, 'backup': str(backup) if backup.exists() else None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, default=STATE_ROOT)
    parser.add_argument('--adopt-existing', action='store_true')
    args = parser.parse_args()
    print(json.dumps(install(args.state_dir.resolve(), args.adopt_existing)))

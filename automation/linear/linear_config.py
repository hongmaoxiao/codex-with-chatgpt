"""Machine-local workspace identities; never credentials or repository inputs."""
import json
import os
from pathlib import Path
import re
import uuid

CODEX_DIRECTORY = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex')))
STATE_ROOT = Path(os.environ.get('C2C_LINEAR_STATE_DIR', str(CODEX_DIRECTORY / 'automation-state' / 'linear-issue-dispatcher')))


def connections():
    path = STATE_ROOT / 'config.json'
    if not path.is_file():
        raise RuntimeError('Create machine-local config.json using the versioned config.example.json template')
    value = json.loads(path.read_text())
    rows = value.get('connections', {})
    if not isinstance(rows, dict) or not rows:
        raise RuntimeError('Configure at least one native Linear connection')
    for name, row in rows.items():
        if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', name):
            raise RuntimeError('Invalid Linear connection alias')
        for field in ('workspaceId', 'userId'):
            if str(uuid.UUID(row[field])) != row[field]:
                raise RuntimeError('Use exact canonical workspace and user UUIDs')
        if not row.get('workspaceName') or not row.get('keychainAccount'):
            raise RuntimeError('A connection needs a workspace name and existing Keychain account')
    return rows

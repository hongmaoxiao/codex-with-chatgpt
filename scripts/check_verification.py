"""Check that a full Vitest run actually exercised the fork's required suites."""
import json
from pathlib import Path
import sys

REQUIRED = {'tests/worktrees.test.ts': 5, 'tests/worktree-mcp.test.ts': 3,
            'tests/connection.test.ts': 5, 'tests/recovery.test.ts': 4}


def check_report(report):
    if not report.get('success') or report.get('numFailedTests', 0):
        raise RuntimeError('The full core test run did not pass')
    for name, minimum in REQUIRED.items():
        suites = [suite for suite in report.get('testResults', [])
                  if suite.get('name', '').replace('\\', '/').endswith('/' + name)]
        cases = [case for suite in suites for case in suite.get('assertionResults', [])]
        if len(cases) < minimum or any(case.get('status') != 'passed' for case in cases):
            raise RuntimeError(f'Required customization coverage missing, skipped or failed: {name}')


if __name__ == '__main__':
    check_report(json.loads(Path(sys.argv[1]).read_text()))
    print('Required customization suites were executed and passed.')

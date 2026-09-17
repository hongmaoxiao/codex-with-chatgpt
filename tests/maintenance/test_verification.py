import importlib.util
from pathlib import Path
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts' / 'check_verification.py'
SPEC = importlib.util.spec_from_file_location('check_verification', SCRIPT)
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


class VerificationCoverageTests(unittest.TestCase):
    def test_full_success_does_not_hide_missing_customization_tests(self):
        with self.assertRaisesRegex(RuntimeError, 'coverage missing'):
            m.check_report({'success': True, 'numFailedTests': 0, 'testResults': []})

    def test_skipped_cases_fail_the_gate(self):
        suites = [{'name': '/repo/' + name, 'assertionResults': [{'status': 'passed'} for _ in range(count)]}
                  for name, count in m.REQUIRED.items()]
        report = {'success': True, 'numFailedTests': 0, 'testResults': suites}
        m.check_report(report)
        suites[0]['assertionResults'][0]['status'] = 'pending'
        with self.assertRaisesRegex(RuntimeError, 'skipped'):
            m.check_report(report)


if __name__ == '__main__':
    unittest.main()

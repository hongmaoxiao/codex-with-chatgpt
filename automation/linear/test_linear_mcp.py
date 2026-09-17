import copy
import io
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import urllib.error

import linear_mcp as m

CONFIG = {'linear_example': {'workspaceId': 'expected-workspace', 'keychainAccount': 'synthetic-account'}}

class RenewalTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = {"server_name": "linear_example", "url": m.ENDPOINT, "issuer": m.ISSUER,
                      "client_id": "synthetic-client", "expires_at": 999_999,
                      "token_response": {"access_token": "synthetic-old", "refresh_token": "synthetic-renewal"}}
        self.patches = [patch.object(m, "STATE_ROOT", Path(self.tmp.name)),
                        patch.object(m, "connections", return_value=CONFIG),
                        patch.object(m.time, "time", return_value=1_000_000),
                        patch.object(m, "_read_credentials", side_effect=lambda _: copy.deepcopy(self.state)),
                        patch.object(m, "_save_credentials", side_effect=self.save)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def save(self, name, credentials):
        self.assertEqual(name, "linear_example")
        self.state = copy.deepcopy(credentials)

    def renewed(self, credentials):
        result = copy.deepcopy(credentials)
        result["token_response"]["access_token"] = "synthetic-new"
        result["expires_at"] = 1_003_600
        return result

    def test_reuses_a_live_grant_without_contacting_authorization_server(self):
        self.state["expires_at"] = 1_003_600
        with patch.object(m, "_refresh") as refresh:
            self.assertEqual(m.access_token("linear_example"), "synthetic-old")
            refresh.assert_not_called()

    def test_parallel_callers_renew_once_and_reuse_the_persisted_grant(self):
        with patch.object(m, "_refresh", side_effect=self.renewed) as refresh:
            with ThreadPoolExecutor(max_workers=4) as pool:
                tokens = list(pool.map(m.access_token, ["linear_example"] * 8))
            self.assertEqual(tokens, ["synthetic-new"] * 8)
            self.assertEqual(refresh.call_count, 1)

    def test_rejected_old_token_does_not_rotate_again_after_another_caller_renewed(self):
        self.state = self.renewed(self.state)
        with patch.object(m, "_refresh") as refresh:
            self.assertEqual(m.access_token("linear_example", failed_token="synthetic-old"), "synthetic-new")
            refresh.assert_not_called()

    def test_failed_renewal_does_not_replace_existing_keychain_grant(self):
        before = copy.deepcopy(self.state)
        with patch.object(m, "_refresh", side_effect=RuntimeError("provider unavailable")):
            with self.assertRaisesRegex(RuntimeError, "provider unavailable"):
                m.access_token("linear_example")
        self.assertEqual(self.state, before)

    def test_unknown_connection_is_rejected_before_keychain_access(self):
        with self.assertRaises(ValueError):
            m.access_token("foreign-connection")


class RpcTests(unittest.TestCase):
    def setUp(self):
        configured = patch.object(m, 'connections', return_value=CONFIG)
        configured.start()
        self.addCleanup(configured.stop)

    def client(self):
        client = object.__new__(m.LinearClient)
        client.name = "linear_example"
        client.headers = {}
        client.sequence = 0
        return client

    def test_only_unauthorized_request_is_retried_after_renewal(self):
        client = self.client()
        unauthorized = urllib.error.HTTPError(m.ENDPOINT, 401, "Unauthorized", {}, io.BytesIO())
        self.addCleanup(unauthorized.close)
        with patch.object(m, "access_token", side_effect=["old", "new"]) as token:
            with patch.object(client, "_send", side_effect=[unauthorized, {"result": "accepted"}]) as send:
                self.assertEqual(client._rpc("tools/call", {"name": "save_issue"}), {"result": "accepted"})
                self.assertEqual(send.call_count, 2)
                self.assertEqual(send.call_args_list[0].args[0], send.call_args_list[1].args[0])
            token.assert_called_with("linear_example", failed_token="old")

    def test_uncertain_timeout_or_server_error_does_not_repeat_a_write(self):
        for error in [TimeoutError(), urllib.error.HTTPError(m.ENDPOINT, 500, "Failure", {}, io.BytesIO())]:
            if isinstance(error, urllib.error.HTTPError):
                self.addCleanup(error.close)
            client = self.client()
            with patch.object(m, "access_token", return_value="synthetic"):
                with patch.object(client, "_send", side_effect=error) as send:
                    with self.assertRaises(type(error)):
                        client._rpc("tools/call", {"name": "save_comment"})
                    self.assertEqual(send.call_count, 1)

    def test_wrong_workspace_fails_before_task_operations(self):
        with patch.object(m.LinearClient, "_rpc", return_value={"result": {"protocolVersion": "2025-03-26"}}):
            with patch.object(m.LinearClient, "call", return_value={"id": "another-workspace"}):
                with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
                    m.LinearClient("linear_example")


if __name__ == "__main__":
    unittest.main()

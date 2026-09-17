"""Linear MCP using the existing Codex Keychain grant, including token renewal.

No credentials are returned by the command-line entry point or stored in files.
Only an explicit HTTP 401 is retried; uncertain writes must be reconciled by the
caller before any retry.
"""
import fcntl
import json
import os
import shlex
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from linear_config import STATE_ROOT, connections

ENDPOINT = "https://mcp.linear.app/mcp"
ISSUER = "https://mcp.linear.app"
SERVICE = "Codex MCP Credentials"


def _account(name):
    configured = connections()
    if name not in configured:
        raise ValueError("Unknown configured Linear connection")
    return configured[name]['keychainAccount']


def _read_credentials(name):
    result = subprocess.run(
        ["security", "find-generic-password", "-s", SERVICE, "-a", _account(name), "-w"],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode:
        raise RuntimeError("Saved Linear authorization is unavailable")
    try:
        credentials = json.loads(result.stdout)
        if (credentials["server_name"] != name or credentials["url"] != ENDPOINT
                or credentials["issuer"] != ISSUER or not credentials["client_id"]
                or not isinstance(credentials["token_response"]["access_token"], str)
                or not credentials["token_response"]["access_token"]
                or not isinstance(credentials.get("expires_at"), (int, float))):
            raise ValueError("Invalid saved identity")
        return credentials
    except (ValueError, KeyError, TypeError):
        raise RuntimeError("Saved Linear authorization identity is invalid") from None


def _save_credentials(name, credentials):
    # security's interactive input keeps the credential out of argv and ps.
    command = "add-generic-password -U -s {} -a {} -w {}\n".format(
        shlex.quote(SERVICE), shlex.quote(_account(name)),
        shlex.quote(json.dumps(credentials, separators=(",", ":"))),
    )
    subprocess.run(["security", "-i"], input=command, capture_output=True, text=True, timeout=10)
    if _read_credentials(name) != credentials:
        raise RuntimeError("Could not verify saved Linear token renewal")


def _refresh(credentials):
    token = credentials["token_response"]
    if not token.get("refresh_token"):
        raise RuntimeError("Linear grant has no renewal token; authorization is required")
    try:
        with urllib.request.urlopen(ISSUER + "/.well-known/oauth-authorization-server", timeout=20) as response:
            metadata = json.load(response)
        if metadata.get("issuer") != ISSUER or metadata.get("token_endpoint") != ISSUER + "/token":
            raise RuntimeError("Linear authorization-server identity changed")
        body = urllib.parse.urlencode({
            "grant_type": "refresh_token", "refresh_token": token["refresh_token"],
            "client_id": credentials["client_id"],
        }).encode()
        request = urllib.request.Request(metadata["token_endpoint"], data=body,
                                         headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(request, timeout=25) as response:
            renewed = json.load(response)
    except (urllib.error.URLError, ValueError):
        raise RuntimeError("Linear token renewal failed; existing grant was not replaced") from None
    if not isinstance(renewed.get("access_token"), str) or renewed.get("token_type", "bearer").lower() != "bearer":
        raise RuntimeError("Linear returned an invalid token renewal")
    ttl = renewed.get("expires_in")
    if not isinstance(ttl, (int, float)) or ttl <= 0:
        raise RuntimeError("Linear token renewal has no valid expiry")
    result = dict(credentials)
    result["token_response"] = {**token, **renewed}
    # Preserve the Codex credential format (milliseconds on this installation).
    scale = 1000 if credentials.get("expires_at", 0) > 10**12 else 1
    result["expires_at"] = int((time.time() + ttl) * scale)
    return result


def access_token(name, failed_token=None):
    """Renew near expiry, or once after 401; other callers reuse the saved result."""
    _account(name)
    locks = STATE_ROOT / "auth-locks"
    locks.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(locks / (name + ".lock"), os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        credentials = _read_credentials(name)
        current = credentials["token_response"]["access_token"]
        expires = credentials.get("expires_at", 0)
        if expires > 10**12:
            expires /= 1000
        # A different process may already have renewed the rejected token.
        rejected = failed_token is not None and current == failed_token
        if rejected or expires <= time.time() + 60:
            credentials = _refresh(credentials)
            _save_credentials(name, credentials)
            current = credentials["token_response"]["access_token"]
        return current


class LinearClient:
    def __init__(self, name):
        _account(name)
        self.name = name
        self.sequence = 0
        self.headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        initialized = self._rpc("initialize", {
            "protocolVersion": "2025-03-26", "capabilities": {},
            "clientInfo": {"name": "codex-linear-dispatcher", "version": "2"},
        })
        self.headers["MCP-Protocol-Version"] = initialized["result"]["protocolVersion"]
        self._rpc("notifications/initialized", {}, notification=True)
        if self.call("get_workspace", {}).get("id") != connections()[name]['workspaceId']:
            raise RuntimeError("Linear workspace identity mismatch")

    def _send(self, body, token):
        request = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(),
                                         headers={**self.headers, "Authorization": "Bearer " + token})
        with urllib.request.urlopen(request, timeout=25) as response:
            session = response.headers.get("Mcp-Session-Id")
            if session:
                self.headers["Mcp-Session-Id"] = session
            if "text/event-stream" in response.headers.get("Content-Type", ""):
                for line in response:
                    if line.startswith(b"data:"):
                        message = json.loads(line[5:])
                        if message.get("id") == body.get("id"):
                            return message
                return {}
            raw = response.read()
            return json.loads(raw) if raw else {}

    def _rpc(self, method, params, notification=False):
        self.sequence += 1
        body = {"jsonrpc": "2.0", "method": method, "params": params}
        if not notification:
            body["id"] = self.sequence
        token = access_token(self.name)
        try:
            return self._send(body, token)
        except urllib.error.HTTPError as error:
            if error.code != 401:
                raise
            error.close()
        # 401 establishes that this attempt was unauthorized. Never retry an
        # uncertain timeout/5xx mutation, which may already have taken effect.
        return self._send(body, access_token(self.name, failed_token=token))

    def call(self, tool, arguments):
        response = self._rpc("tools/call", {"name": tool, "arguments": arguments})
        result = response.get("result", {})
        if response.get("error") or result.get("isError"):
            raise RuntimeError("Linear MCP operation failed: " + tool)
        for item in result.get("content", []):
            if item.get("type") == "text":
                return json.loads(item["text"])
        raise RuntimeError("Linear MCP returned no JSON tool result")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Verify an existing Linear connection, renewing it when needed")
    parser.add_argument("connection", choices=connections())
    args = parser.parse_args()
    client = LinearClient(args.connection)
    print(json.dumps({"connection": args.connection, "workspace": client.call("get_workspace", {})}))

# Optional Linear dispatcher helpers

These macOS helpers reuse already-authorized Codex MCP credentials from Keychain.
They do not create issues/tasks, grant new permissions or store tokens in files.
Codex performs task dispatch and delivery according to the user's automation.

Keep machine configuration in:

`$CODEX_HOME/automation-state/linear-issue-dispatcher/config.json`

`CODEX_HOME` defaults to `~/.codex`; `C2C_LINEAR_STATE_DIR` can select another
state directory. Start from `config.example.json` and fill in exact workspace,
user and existing Keychain account identities. Native connections go under
`connections`; already-injected plugin workspaces can be listed separately under
`connectorWorkspaces` and must also be scanned by Codex. Never commit the local
configuration, credentials, logs, complete issues or execution state.

Install the managed scripts from the clean main checkout after core installation
has activated that exact commit; a development/sync worktree is refused:

```sh
python3 automation/linear/install.py
```

An initial migration of previously unmanaged scripts requires inspecting those
scripts and passing `--adopt-existing`; their backup is retained. Later updates
check the installation receipt and refuse to overwrite local helper edits.
The installer never replaces config.json, state.json, result files or Keychain.

The installed `tooling/scan_workspaces.py` checks every configured native
workspace and paginates fully. Candidates must satisfy `(creator matches OR
assignee matches) AND one nonempty leading <project-name>`. The dispatcher must
still match that name uniquely to a saved local Git project and check issue
status, dependencies and existing claims before executing anything.

`LinearClient` renews the existing grant near expiry or once after a definite 401,
with a per-connection lock and private stdin-only Keychain updates. It does not
retry timeouts/5xx writes, which may already have taken effect. Always read back
uncertain comments and state changes before deciding to retry them.

The reusable automation instructions are in `prompt.md`; configure scheduling
with Codex's automation tool, never by hand-writing scheduler state.

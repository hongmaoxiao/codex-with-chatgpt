# Registered worktrees: reuse one project connection

Use this path when Codex is handling an issue in its own Git worktree and the
owning project directory is known from the task, dispatcher or saved project.
The task worktree is the code context; the existing project is the connection
and authorization owner. Do not infer ownership merely from a matching name.

## Register and connect

1. Register the actual task directory with its owning project:

   ```sh
   c2c worktree --project-root <saved-project-root> -w <task-worktree> --json
   ```

   This validates Git registration and common repository identity, then writes
   local routing metadata. It does not create a public connection, issue an
   authorization grant or generate a pairing code. A separately configured
   linked project remains separate unless it is explicitly registered here.

2. Use `-w <task-worktree>` for `doctor`, `session`, `workspace` and `record`.
   Bridge/address/authentication state resolves to the registered project;
   chats, checkpoints and execution evidence remain scoped to the task.
   Keep the returned `context.mcpArguments`, `context.connectionRoot` and
   `context.connectionWorkspaceId` for this task.

3. `c2c doctor -w <task-worktree> --json` must pass the normal doctor gate,
   including `report.worktrees`. If it reports `BRIDGE_UPGRADE_REQUIRED`,
   update the installed C2C runtime, restart only the owning project's bridge
   using `context.connectionRoot`, and preserve its existing fixed address and
   authorization state. Do not replace that connector or generate another
   worktree-specific connection.

4. After a runtime update changes tool schemas, use the existing connection's
   **Refresh** action in the in-app ChatGPT Plugins page, then verify the
   advertised tools accept `worktree_id` and `expected_branch`. This is metadata
   refresh for an unchanged, healthy address; it is different from reconnecting
   an expired address. Do it once per updated project connection, not per task.
   Never declare multi-worktree support ready while ChatGPT still has the old
   tool schemas.

5. An already authorized project's `setup` returns `reusedConnection: true`
   and `requiresPairing: false`; do not open pairing/login pages in that case.
   `tunnel status` inherits the project's saved address preference. A missing
   project authorization is a project setup problem, not a reason to create a
   second connector for the worktree.

## Independent conversations

Read `c2c session -w <task-worktree> --json`. Project URL and connector name
are inherited, but another task's chat URL or checkpoint is never inherited.
Open a new Chat conversation in the inherited Project for a new Codex task;
reuse this task's own saved conversation on continuation.

If `needsConversationRebind` is true, the task previously used another
connector. Open a conversation in the inherited Project and send HANDOFF from
the preserved checkpoint. Do not repeat completed implementation or tests,
and do not copy source, diffs or logs into ChatGPT. Save the new chat URL only
after the selected worktree passes verification.

Include this routing instruction in boot, HANDOFF, INIT and EXECUTED messages:

```text
Use only <project connector>. Every tool call must include:
<the exact JSON in context.mcpArguments>
Call workspace_info with those arguments first. Confirm workspaceId matches
<context.workspaceId>, connectionWorkspaceId matches <context.connectionWorkspaceId>,
and git.branch matches this task's branch. Do not read the default main checkout.
```

These are identifiers, not credentials. Keep the normal small control-message
limit. A missing selector or wrong branch is not successful verification.
Refresh `context.mcpArguments` after an intentional branch change; never
silently change another task's context. There is no global current-worktree
setting to toggle.

Record test/build/lint evidence with the actual task worktree. ChatGPT must
send the same selector to `test_status`, `execution_summary` and
`execution_output`, including when output IDs happen to match across tasks.

## Unattended recovery and boundaries

- Registering a worktree, reusing an existing grant, opening its task chat,
  refreshing tool metadata and continuing checkpoints are automated steps.
  A normal already-authorized navigation button is not by itself a reason to
  ask the user to click it. Diagnose the actual page/new tab before handing off.
- Keep genuine account login, CAPTCHA, two-factor and required-consent
  boundaries. Do not extract cookies or credentials to bypass them.
- Stop/unpair and address changes must explicitly target the owning project,
  not a task directory; they affect all tasks using that connection. Completing
  an issue must not revoke or stop its project's connection.
- Keep code, build caches, test data and browser/device resources separate.
  Only shared integration resources need coordination. A blocked task never
  prevents independent worktrees from continuing.
- On an iteration limit in an already-authorized unattended run, checkpoint
  the actual progress and return control to the dispatcher. It can continue
  the same task when progress and the remaining scope justify it; do not
  create another issue task or ask for permission solely because a counter
  reached its default. User-specified budgets and real blockers still apply.

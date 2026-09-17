# Maintaining this fork

This fork preserves the upstream project and adds shared project connections for
isolated task worktrees. `maintenance.json` names both repositories, the stable
branch, the customization anchor and the required CI checks. The MIT license and
upstream attribution remain intact.

- `origin`: this maintained fork. Its `main` is the source of client updates.
- `upstream`: the original author's repository, read by the maintenance task.
- `codex/sync-upstream-*`: independent branches/worktrees where updates are
  merged, reviewed and tested before a pull request reaches stable main.

Run these commands from the C2C checkout, with Git, Node/Corepack, Python 3.10+
and authenticated GitHub CLI available:

```sh
python3 scripts/maintenance.py check
python3 scripts/maintenance.py prepare
python3 scripts/maintenance.py verify --root <returned-worktree>
```

`prepare` never commits or publishes. It resumes an existing synchronization
worktree without resetting its changes. Resolve conflicts there, follow the
user's review/commit requirements, push the branch to origin and open its PR.
Merge with a merge commit only after the exact head's required checks pass;
preserving history lets the next run distinguish already-integrated upstream
commits. Never force-sync or reset the fork's main to upstream.

After main's own checks pass, install that immutable candidate:

```sh
python3 scripts/maintenance.py install
```

Installation is serialized by a kernel-owned repository lock. It refuses dirty,
ahead or diverged checkouts and fork history that dropped the customization
anchor. A separate checkout installs locked dependencies and runs all verification
before activation. A post-activation failure restores the previous local commit,
built runtime and Skill; it never rewrites a remote branch. Backups remain in
`.tooling/maintenance/`. The installed artifact marker makes a missing/stale
build visible even if source main already advanced.

The installer preserves machine-local Skill notes and user-added resources.
C2C authorization, endpoints, ChatGPT sessions, local Linear identities and issue
claims remain outside Git and are never included in a release. Restart a verified
owning project's bridge only when runtime code changed, and confirm doctor and
public workspace identity before considering that runtime upgraded.

The daily Codex maintenance automation performs this workflow, reuses existing
PRs and reports only deliveries/failures/actionable blockers. It does not require
API keys for an additional model service. Local scheduling requires the machine
and Codex to be running; a later run checks complete history and resumes the same
work if an earlier run was interrupted.

The optional Linear helpers and their configuration template are versioned in
`automation/linear/`. Their own installer preserves local identities and running
issue state and refuses to overwrite edited managed helper files.

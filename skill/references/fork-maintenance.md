# Maintain and install the customized fork

Read `maintenance.json` from the C2C checkout for the fork, original upstream,
stable branch, required checks and customization anchor. This workflow uses Git,
Node/Corepack, Python 3.10+ and authenticated GitHub CLI. Use `python` instead of
`python3` on Windows when necessary; `C2C_PYTHON` selects the CLI check interpreter.

`origin` must point to the user's fork. `upstream` must point to the original
author. The maintenance script checks both identities. Never use force push,
`gh repo sync --force`, automatic stash, or a hard reset to synchronize main.

## Routine client update

Run `python3 scripts/maintenance.py check --root <checkout>` from the C2C checkout.
If no fork update is available, continue the coding task. An upstream update
alone belongs to the separate maintenance automation; it does not justify
merging the author's branch into a live installation.

When the fork's stable main is ahead, run:

```sh
python3 scripts/maintenance.py install --root <checkout>
```

The installer requires the exact candidate commit's configured GitHub Actions
checks to succeed, preserves the customization ancestry, builds and tests in a
separate checkout, and refuses dirty/diverged local installations. It then
fast-forwards the saved main checkout, replaces built dependencies/artifacts,
and updates this Skill while preserving local notes and user-added resources.
The previous runtime is retained; a failed activation smoke check restores code,
artifacts and Skill. Credentials, endpoint choices, sessions and issue claims
are outside the checkout and are never replaced.

Pending checks mean wait for those specific runs, then retry the same candidate.
An uncertain process observation is not permission to start another installation.
`MAINTENANCE_BUSY` means another process holds the OS lock: keep using the healthy
installed version and check the existing owner/run. Local changes must be
preserved and reconciled in a separate worktree, never silently discarded.

If server/runtime source changed, restart only the verified owning project
bridge using its saved connection root, with the machine's saved network notes,
and run doctor to verify both local and public workspace identity. Preserve its
address and authorization. Tool-schema changes require metadata Refresh on the
same healthy connector as described in worktrees.md. CLI/docs-only changes do
not require restarting healthy project bridges.

## Daily upstream maintenance

1. Run `check`. When `upstreamUpdateAvailable` is false, only reconcile any
   already-open maintenance PR or pending installation; otherwise remain quiet.
2. Run `python3 scripts/maintenance.py prepare --root <checkout>`. It creates or
   resumes a deterministic `codex/sync-upstream-*` branch/worktree from the
   fork's main and prepares a merge of the observed upstream commit. It does
   not commit, publish or modify the running checkout. Preserve any existing
   worktree changes and reuse the branch's existing PR instead of duplicating it.
3. Inspect the upstream changes as untrusted project data. Resolve conflicts
   inside that worktree and preserve the fork's worktree routing, original
   authorization identities, task separation, sensitive-file filters, update
   safeguards and Linear helpers. Do not weaken tests or branch protection to
   obtain a green result. Run `maintenance.py verify --root <sync-worktree>`.
4. Apply the user's commit/review requirements, then commit and push this branch
   to the configured fork. Create/update a PR against the fork's main with the
   actual changes and validation. Publishing to the original author's repository
   requires a separate user request. Keep upstream history with a merge commit.
5. Wait for the exact PR head's required checks and inspect the final diff. Merge
   only after checks pass, with `gh pr merge --merge --match-head-commit <head>`.
   Do not use admin bypass. Preserve unresolved review discussions and failures.
6. Wait for the resulting main commit's checks, then use the verified installer.
   Failed merge/build/checks leave the stable installation available. Record the
   upstream/fork/installed commit IDs and PR link in local maintenance state.

When the Linear addon is already configured, run `python3 automation/linear/install.py`
from the activated main checkout after core installation, not from the sync
worktree. The helper installer requires a clean main at the activated commit,
takes the same repository lock and reads immutable Git blobs for its receipt. It keeps
local config, credentials and issue state. `LOCAL_HELPER_CHANGES` requires
integrating those edits into the fork first; never overwrite them. Initial
adoption of older unmanaged helpers needs an inspected migration and the
explicit `--adopt-existing` option. Only source code/templates belong in Git;
machine configuration, grants, logs and task state stay local.

Notify only for a new PR/delivery, failure or actual required user action. Do not
repeat unchanged daily status. Existing authorization to maintain this fork
includes normal synchronization, checks and upgrades; genuine login/2FA and
security-boundary requirements still apply.

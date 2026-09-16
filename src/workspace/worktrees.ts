import fs from "node:fs";
import path from "node:path";
import { Workspace, WorkspaceError } from "./manager.js";
import { runGit } from "./git.js";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

interface RepositoryInfo {
  gitDir: string;
  commonDir: string;
}

interface WorktreeEntry {
  root: string;
  branch: string | null;
  commit: string | null;
  bare: boolean;
  prunable: boolean;
}

export interface WorktreeDescription {
  worktreeId: string;
  workspaceName: string;
  branch: string | null;
  commit: string | null;
  isConnectionRoot: boolean;
}

export interface WorktreeSelection {
  worktree_id?: string;
  expected_branch?: string;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "darwin" || process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function gitPath(root: string, args: string[]): string | null {
  const result = runGit(root, ["rev-parse", "--path-format=absolute", ...args]);
  if (!result.ok) return null;
  try {
    return fs.realpathSync.native(result.stdout.replace(/\r?\n$/, ""));
  } catch {
    return null;
  }
}

function repositoryInfo(workspace: Workspace): RepositoryInfo | null {
  const topLevel = gitPath(workspace.root, ["--show-toplevel"]);
  // A connector authorized for a subdirectory must not expand to its parent repository.
  if (!topLevel || !samePath(topLevel, workspace.root)) return null;
  const gitDir = gitPath(workspace.root, ["--git-dir"]);
  const commonDir = gitPath(workspace.root, ["--git-common-dir"]);
  return gitDir && commonDir ? { gitDir, commonDir } : null;
}

function registeredEntries(root: string): WorktreeEntry[] {
  const result = runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  if (!result.ok) throw new WorkspaceError("WORKTREE_NOT_FOUND", "Cannot read the repository's worktree registry.");
  const entries: WorktreeEntry[] = [];
  let entry: WorktreeEntry | null = null;
  for (const field of result.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      if (entry) entries.push(entry);
      entry = { root: field.slice(9), branch: null, commit: null, bare: false, prunable: false };
    } else if (entry && field.startsWith("HEAD ")) {
      entry.commit = field.slice(5);
    } else if (entry && field.startsWith("branch ")) {
      entry.branch = field.slice(7).replace(/^refs\/heads\//, "");
    } else if (entry && field === "bare") {
      entry.bare = true;
    } else if (entry && field.startsWith("prunable")) {
      entry.prunable = true;
    }
  }
  if (entry) entries.push(entry);
  return entries.filter((item) => !item.bare && !item.prunable);
}

function entryWorkspace(entry: WorktreeEntry, connection?: Workspace): Workspace | null {
  try {
    return new Workspace(entry.root, connection?.ignoreRules);
  } catch {
    return null;
  }
}

interface WorktreeBinding {
  version: 1;
  workspaceId: string;
  workspaceRoot: string;
  connectionWorkspaceId: string;
  connectionRoot: string;
}

function bindingFile(workspace: Workspace): string {
  return path.join(getStateDir(), "worktree-bindings", `${workspace.id}.json`);
}

function readBinding(workspace: Workspace): WorktreeBinding | null {
  const file = bindingFile(workspace);
  if (!fs.existsSync(file)) return null;
  const binding = readJsonIfExists<WorktreeBinding>(file);
  if (!binding || binding.version !== 1 || binding.workspaceId !== workspace.id ||
      typeof binding.workspaceRoot !== "string" || !samePath(binding.workspaceRoot, workspace.root) || typeof binding.connectionRoot !== "string" ||
      typeof binding.connectionWorkspaceId !== "string") {
    throw new WorkspaceError("WORKTREE_CONTEXT_MISMATCH", "The saved project binding is invalid; register the worktree again.");
  }
  return binding;
}

function verifyRegistration(project: Workspace, target: Workspace): void {
  if (project.id === target.id) return;
  const projectInfo = repositoryInfo(project);
  const targetInfo = repositoryInfo(target);
  if (!projectInfo || !targetInfo || !samePath(projectInfo.commonDir, targetInfo.commonDir) ||
      !registeredEntries(project.root).some((entry) => entryWorkspace(entry)?.id === target.id)) {
    throw new WorkspaceError("WORKTREE_NOT_FOUND", "The task directory is not a registered worktree of this project.");
  }
}

export function isLinkedWorktree(workspace: Workspace): boolean {
  const repository = repositoryInfo(workspace);
  return Boolean(repository && !samePath(repository.gitDir, repository.commonDir));
}

/** Local Codex registration is not an authorization or a new public connection. */
export function bindWorktree(project: Workspace, target: Workspace): void {
  const ownerBinding = readBinding(project);
  if (ownerBinding && ownerBinding.connectionWorkspaceId !== project.id) {
    throw new WorkspaceError("WORKTREE_PROJECT_REQUIRED", "Use the original project connection as --project-root, not another bound task worktree.");
  }
  verifyRegistration(project, target);
  if (project.id !== target.id && new WorktreeRegistry(target).list().some((entry) => !entry.isConnectionRoot)) {
    throw new WorkspaceError("WORKTREE_CONTEXT_MISMATCH", "This directory owns task bindings; rebind those tasks before changing its connection owner.");
  }
  const binding: WorktreeBinding = {
    version: 1,
    workspaceId: target.id,
    workspaceRoot: target.root,
    connectionWorkspaceId: project.id,
    connectionRoot: project.root,
  };
  writeSecureJson(bindingFile(target), binding);
}

export function boundConnectionWorkspace(target: Workspace): Workspace | null {
  const binding = readBinding(target);
  if (!binding) return null;
  const project = new Workspace(binding.connectionRoot);
  if (project.id !== binding.connectionWorkspaceId) {
    throw new WorkspaceError("WORKTREE_CONTEXT_MISMATCH", "The registered project directory has changed.");
  }
  const ownerBinding = readBinding(project);
  if (ownerBinding && ownerBinding.connectionWorkspaceId !== project.id) {
    throw new WorkspaceError("WORKTREE_CONTEXT_MISMATCH", "The saved binding forms an ownership chain; register directly with the original project.");
  }
  verifyRegistration(project, target);
  return project;
}

/** Stateless selection: parallel requests never change a shared 'current worktree'. */
export class WorktreeRegistry {
  constructor(readonly connection: Workspace) {}

  private entries(info = repositoryInfo(this.connection)): WorktreeEntry[] {
    if (!info) return [];
    return registeredEntries(this.connection.root).filter((entry) => {
      const workspace = entryWorkspace(entry);
      if (!workspace) return false;
      if (workspace.id === this.connection.id) return true;
      try {
        const binding = readBinding(workspace);
        return Boolean(binding && binding.connectionWorkspaceId === this.connection.id &&
          samePath(binding.connectionRoot, this.connection.root));
      } catch {
        // A broken task binding must fail closed without disabling other worktrees.
        return false;
      }
    });
  }

  list(): WorktreeDescription[] {
    return this.entries().flatMap((entry) => {
      const workspace = entryWorkspace(entry);
      return workspace ? [{
        worktreeId: workspace.id,
        workspaceName: workspace.name,
        branch: entry.branch,
        commit: entry.commit,
        isConnectionRoot: workspace.id === this.connection.id,
      }] : [];
    });
  }

  resolve(selection: WorktreeSelection, options: { allowDiscovery?: boolean } = {}): Workspace {
    const id = selection.worktree_id;
    if (!id && !options.allowDiscovery && this.entries().some((entry) => entryWorkspace(entry)?.id !== this.connection.id)) {
      throw new WorkspaceError("WORKTREE_SELECTION_REQUIRED", "This project serves task worktrees. Pass worktree_id from workspace_info; its connectionWorkspaceId selects the original project root.");
    }
    let target = this.connection;
    if (id && id !== this.connection.id) {
      const sourceInfo = repositoryInfo(this.connection);
      const selected = this.entries(sourceInfo)
        .map((entry) => entryWorkspace(entry, this.connection))
        .find((workspace) => workspace?.id === id);
      const targetInfo = selected && repositoryInfo(selected);
      if (!selected || !sourceInfo || !targetInfo || !samePath(sourceInfo.commonDir, targetInfo.commonDir)) {
        throw new WorkspaceError("WORKTREE_NOT_FOUND", "The selected worktree is not registered to this connected repository.");
      }
      target = selected;
    }
    if (selection.expected_branch !== undefined) {
      const current = runGit(target.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      const branch = current.ok ? current.stdout.replace(/\r?\n$/, "") : null;
      if (branch !== selection.expected_branch) {
        throw new WorkspaceError("WORKTREE_CONTEXT_MISMATCH", "The selected worktree is no longer on the expected branch.");
      }
    }
    return target;
  }
}

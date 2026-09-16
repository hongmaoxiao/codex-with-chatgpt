import { Workspace, WorkspaceError } from "../workspace/manager.js";
import { boundConnectionWorkspace, isLinkedWorktree } from "../workspace/worktrees.js";
import { runGit } from "../workspace/git.js";
import { readLastEndpoint } from "./endpoint.js";
import { readSession, type SavedSession } from "../session/state.js";

/** Connection state belongs to the main checkout; task state stays in its worktree. */
export function resolveConnection(root: string) {
  const workspace = new Workspace(root);
  const binding = boundConnectionWorkspace(workspace);
  if (!binding && !readLastEndpoint(workspace.id) && isLinkedWorktree(workspace)) {
    throw new WorkspaceError("WORKTREE_PROJECT_REQUIRED", "Register this task worktree with c2c worktree --project-root <project> -w <worktree>; do not create another connection.");
  }
  const connection = binding ?? workspace;
  const branchResult = runGit(workspace.root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = branchResult.ok ? branchResult.stdout.replace(/\r?\n$/, "") : null;
  return {
    workspace,
    connection,
    shared: workspace.id !== connection.id,
    context: {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      connectionWorkspaceId: connection.id,
      connectionWorkspaceName: connection.name,
      connectionRoot: connection.root,
      sharedConnection: workspace.id !== connection.id,
      mcpArguments: {
        worktree_id: workspace.id,
        ...(branch ? { expected_branch: branch } : {}),
      },
    },
  };
}

/** Inherit project/connector metadata, never another task's chat or checkpoint. */
export function taskSession(context: ReturnType<typeof resolveConnection>): {
  session: SavedSession | null;
  inheritedProject: boolean;
  needsConversationRebind: boolean;
} {
  const own = readSession(context.workspace.id);
  if (!context.shared) return { session: own, inheritedProject: false, needsConversationRebind: false };
  const parent = readSession(context.connection.id);
  const connectorName = readLastEndpoint(context.connection.id)?.connectorName ?? parent?.connectorName;
  const needsConversationRebind = Boolean(own?.url && (
    (connectorName && own.connectorName !== connectorName) ||
    (parent?.projectUrl && own.projectUrl !== parent.projectUrl)
  ));
  if (!own && !parent && !connectorName) {
    return { session: null, inheritedProject: false, needsConversationRebind: false };
  }
  return {
    session: {
      ...own,
      savedAt: own?.savedAt ?? parent?.savedAt ?? new Date().toISOString(),
      conversationMode: parent?.conversationMode ?? own?.conversationMode ?? "project",
      projectUrl: parent?.projectUrl ?? own?.projectUrl,
      connectorName,
      url: needsConversationRebind ? undefined : own?.url,
      checkpoint: needsConversationRebind && own?.checkpoint
        ? { ...own.checkpoint, chatUrl: undefined, projectUrl: parent?.projectUrl ?? own.projectUrl }
        : own?.checkpoint,
    },
    inheritedProject: Boolean(parent?.projectUrl),
    needsConversationRebind,
  };
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { bindWorktree } from "../src/workspace/worktrees.js";
import { appendExecutionRecord } from "../src/execution/records.js";
import { saveExecutionOutput } from "../src/execution/output.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
let bridge: Bridge;
let root: string;
let token: string;
const targets: Array<{ workspace: Workspace; branch: string; marker: string; client: Client }> = [];

function data(result: any): any {
  expect(result.isError ?? false).toBe(false);
  const parsed = JSON.parse(result.content[0].text);
  expect(result.structuredContent).toEqual(parsed);
  return parsed;
}

beforeAll(async () => {
  dirs.push(isolateStateDir());
  root = makeTmpDir("multiplex-main");
  dirs.push(root);
  makeGitRepo(root);
  write(root, "private.txt", "tracked private baseline");
  git(root, "add", "private.txt");
  git(root, "commit", "-m", "tracked private fixture");
  write(root, ".c2cignore", "private.txt\n");
  bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
  // Authorization exists before either task checkout; no new pairing/token is created per worktree.
  token = bridge.authStore.issueTokens({ clientId: "existing-project-client", scopes: ["workspace.read", "workspace.search", "git.read", "execution.read", "offline_access"] }).accessToken;
  for (const marker of ["alpha", "beta"]) {
    const target = makeTmpDir(`multiplex-${marker}`);
    dirs.push(target);
    const branch = `task-${marker}`;
    git(root, "worktree", "add", "-b", branch, target);
    write(target, "src/index.ts", `export const marker = "${marker}";\n`);
    write(target, `${marker}-only.txt`, marker);
    write(target, "private.txt", `private-${marker}`);
    write(target, ".env", `TOKEN=private-${marker}`);
    const workspace = new Workspace(target);
    bindWorktree(bridge.workspace, workspace);
    appendExecutionRecord(workspace.id, { taskId: marker, iteration: 1, changedFiles: ["src/index.ts"], tests: `${marker} passed`, exitStatus: "ok", timestamp: new Date().toISOString() });
    saveExecutionOutput(workspace.id, { command: `test-${marker}`, raw: `${marker} test output`, exitCode: 0, taskId: marker, iteration: 1 });
    const client = new Client({ name: `task-${marker}`, version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    targets.push({ workspace, branch, marker, client });
  }
});

afterAll(async () => {
  await Promise.all(targets.map((target) => target.client.close()));
  await bridge?.close();
  for (const dir of dirs.reverse()) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

describe("one authenticated connection, parallel task worktrees", () => {
  it("routes every read-only tool and each task's evidence with the existing authorization", async () => {
    await Promise.all(targets.map(async ({ workspace, branch, marker, client }) => {
      const selection = { worktree_id: workspace.id, expected_branch: branch };
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = data(await client.callTool({ name, arguments: { ...args, ...selection } }));
        expect(result.workspaceId).toBe(workspace.id);
        expect(result.connectionWorkspaceId).toBe(bridge.workspace.id);
        return result;
      };
      const info = await call("workspace_info");
      expect(info.git.branch).toBe(branch);
      expect(info.worktrees.map((item: any) => item.worktreeId)).toContain(workspace.id);
      for (let index = 0; index < 5; index++) {
        expect((await call("read_file", { path: "src/index.ts" })).content).toContain(marker);
      }
      const listing = await call("list_directory", { depth: 2 });
      expect(listing.entries.map((item: any) => item.path)).toContain(`${marker}-only.txt`);
      expect(listing.entries.map((item: any) => item.path)).not.toContain("private.txt");
      const search = await call("search_workspace", { query: marker });
      expect(search.matches.some((item: any) => item.path === "src/index.ts")).toBe(true);
      expect(search.matches.some((item: any) => item.path === "private.txt")).toBe(false);
      const status = await call("git_status");
      expect(status.unstaged.some((item: any) => item.path === "src/index.ts")).toBe(true);
      expect(JSON.stringify(status)).not.toContain("private.txt");
      const diff = (await call("git_diff")).diff;
      expect(diff).toContain(`+export const marker = "${marker}"`);
      expect(diff).not.toContain(`private-${marker}`);
      expect(diff).not.toContain("private.txt");
      expect((await call("test_status")).taskId).toBe(marker);
      expect((await call("execution_summary")).records.map((item: any) => item.taskId)).toEqual([marker]);
      const outputs = await call("execution_output", { action: "list" });
      expect(outputs.items[0].taskId).toBe(marker);
      expect((await call("execution_output", { action: "read", id: outputs.items[0].id })).text).toContain(`${marker} test output`);
    }));
    expect(bridge.authStore.tokenCount()).toBe(2);
    const missingSelection = await targets[0].client.callTool({ name: "read_file", arguments: { path: "src/index.ts" } });
    expect(missingSelection.isError).toBe(true);
    expect(JSON.stringify(missingSelection)).toContain("WORKTREE_SELECTION_REQUIRED");
    const primary = data(await targets[0].client.callTool({ name: "read_file", arguments: { worktree_id: bridge.workspace.id, path: "src/index.ts" } }));
    expect(primary.workspaceId).toBe(bridge.workspace.id);
    expect(primary.content).toContain("answer = 42");
  });

  it("rejects a wrong branch, an unknown worktree and sensitive files over HTTP", async () => {
    const { client, workspace } = targets[0];
    for (const args of [
      { worktree_id: workspace.id, expected_branch: "wrong-branch", path: "src/index.ts" },
      { worktree_id: "not-authorized", path: "src/index.ts" },
      { worktree_id: workspace.id, path: ".env" },
      { worktree_id: workspace.id, path: "private.txt" },
    ]) {
      const result = await client.callTool({ name: "read_file", arguments: args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("private-alpha");
    }
  });

  it("keeps the same authorization and target selection after a project bridge restart", async () => {
    const port = bridge.port;
    const identity = bridge.workspace.id;
    await bridge.close();
    bridge = await startBridge({ workspaceRoot: root, port, persistRuntime: false });
    expect(bridge.port).toBe(port);
    expect(bridge.workspace.id).toBe(identity);
    expect(bridge.authStore.verifyAccessToken(token).ok).toBe(true);
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    await Promise.all(targets.map(async ({ workspace, branch, marker, client }) => {
      const request = { name: "read_file", arguments: {
        worktree_id: workspace.id, expected_branch: branch, path: "src/index.ts",
      } };
      // A keep-alive socket may be reset during restart. Retry the same read
      // once with the same client/token; never initiate another pairing.
      let response;
      try {
        response = await client.callTool(request);
      } catch (error) {
        if (!(error instanceof TypeError) || error.message !== "fetch failed") throw error;
        response = await client.callTool(request);
      }
      const result = data(response);
      expect(result.content).toContain(marker);
      expect(result.workspaceId).toBe(workspace.id);
    }));
  });
});

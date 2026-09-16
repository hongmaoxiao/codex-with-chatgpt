import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConnection, taskSession } from "../src/config/connection.js";
import { bindWorktree } from "../src/workspace/worktrees.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeLastEndpoint, readLastEndpoint } from "../src/config/endpoint.js";
import { mergeSession, readSession, writeSession } from "../src/session/state.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const execute = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src/cli/index.ts");
const projectUrl = "https://chatgpt.com/g/g-p-test123/project";
const dirs: string[] = [];
const bridges: Bridge[] = [];

function temporary(name: string): string {
  const result = makeTmpDir(name);
  dirs.push(result);
  return result;
}

function fixture() {
  const stateDir = isolateStateDir();
  dirs.push(stateDir);
  const root = temporary("connection-project");
  makeGitRepo(root);
  const worktree = temporary("connection-task");
  git(root, "worktree", "add", "-b", "task", worktree);
  const project = new Workspace(root);
  const target = new Workspace(worktree);
  writeLastEndpoint({ workspaceId: project.id, connectorName: "Existing Project", publicUrl: "https://project.example", mcpUrl: "https://project.example/mcp", port: 48765 });
  writeSession(project.id, mergeSession(null, {
    conversationMode: "project", projectUrl, connectorName: "Existing Project",
    url: "https://chatgpt.com/c/main-conversation", taskId: "main-task", iteration: 2,
    checkpoint: { protocolState: "EXECUTING", originalGoal: "another main checkout task" },
  }));
  return { root, worktree, project, target, stateDir, codexHome: temporary("connection-codex-config") };
}

async function runCli(args: string[], config: ReturnType<typeof fixture>) {
  return execute(process.execPath, ["--import", "tsx", cli, ...args], {
    cwd: projectRoot,
    env: { ...process.env, C2C_STATE_DIR: config.stateDir, CODEX_HOME: config.codexHome },
    timeout: 15_000,
  });
}

afterEach(async () => {
  for (const bridge of bridges) await bridge.close();
  bridges.length = 0;
  for (const dir of dirs.reverse()) cleanup(dir);
  dirs.length = 0;
  delete process.env.C2C_STATE_DIR;
});

describe("project connections and independent task sessions", () => {
  it("requires an explicit project registration instead of guessing another project's connection", () => {
    const config = fixture();
    expect(() => resolveConnection(config.worktree)).toThrow(/Register this task worktree/);
    bindWorktree(config.project, config.target);
    const context = resolveConnection(config.worktree);
    expect(context.connection.id).toBe(config.project.id);
    expect(context.context.mcpArguments).toEqual({ worktree_id: config.target.id, expected_branch: "task" });
    const inherited = taskSession(context);
    expect(inherited.inheritedProject).toBe(true);
    expect(inherited.session?.projectUrl).toBe(projectUrl);
    expect(inherited.session?.connectorName).toBe("Existing Project");
    expect(inherited.session?.url).toBeUndefined();
    expect(inherited.session?.checkpoint).toBeUndefined();
    expect(inherited.session?.taskId).toBeUndefined();
  });

  it("preserves an independently configured linked project until it is explicitly rebound", () => {
    const config = fixture();
    writeLastEndpoint({ workspaceId: config.target.id, connectorName: "Separate Project", publicUrl: "https://separate.example", mcpUrl: "https://separate.example/mcp", port: 49000 });
    expect(resolveConnection(config.worktree).connection.id).toBe(config.target.id);
    bindWorktree(config.project, config.target);
    expect(resolveConnection(config.worktree).connection.id).toBe(config.project.id);
    expect(readLastEndpoint(config.target.id)?.connectorName).toBe("Separate Project");
  });

  it("retains a task checkpoint during connection migration without reusing the old connector's chat", () => {
    const config = fixture();
    writeSession(config.target.id, mergeSession(null, {
      conversationMode: "project", projectUrl: "https://chatgpt.com/g/g-p-old123/project", connectorName: "Old Task Connector",
      url: "https://chatgpt.com/c/old-task-chat", taskId: "task-a", iteration: 1,
      checkpoint: { protocolState: "EXECUTED_SENT", waitingFor: "GPT_REVIEW", originalGoal: "fix this task" },
    }));
    bindWorktree(config.project, config.target);
    const view = taskSession(resolveConnection(config.worktree));
    expect(view.needsConversationRebind).toBe(true);
    expect(view.session?.url).toBeUndefined();
    expect(view.session?.checkpoint?.protocolState).toBe("EXECUTED_SENT");
    expect(view.session?.checkpoint?.originalGoal).toBe("fix this task");
    expect(view.session?.checkpoint?.chatUrl).toBeUndefined();
    expect(view.session?.checkpoint?.projectUrl).toBe(projectUrl);
    const resumed = mergeSession(view.session, {
      url: "https://chatgpt.com/c/new-task-chat",
      checkpoint: { protocolState: "EXECUTED_SENT" },
    });
    expect(resumed.checkpoint?.chatUrl).toBe(resumed.url);
    expect(resumed.checkpoint?.projectUrl).toBe(resumed.projectUrl);
    expect(readSession(config.project.id)?.taskId).toBe("main-task");
  });

  it("registers and starts a task through the existing authorized bridge without pairing or a new endpoint", async () => {
    const config = fixture();
    const bridge = await startBridge({ workspaceRoot: config.root, port: 0, persistRuntime: true });
    bridges.push(bridge);
    bridge.authStore.issueTokens({ clientId: "already-authorized", scopes: ["workspace.read", "offline_access"] });
    const rootSession = readSession(config.project.id);
    const registration = JSON.parse((await runCli(["worktree", "--project-root", config.root, "-w", config.worktree, "--json"], config)).stdout);
    expect(registration.context.connectionWorkspaceId).toBe(config.project.id);
    const setup = JSON.parse((await runCli(["setup", "-w", config.worktree, "--no-tunnel", "--json"], config)).stdout);
    expect(setup).toMatchObject({ ok: true, reusedConnection: true, requiresPairing: false, workspaceId: config.project.id });
    expect(setup.pairingCode).toBeUndefined();
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    expect(bridge.authStore.tokenCount()).toBe(2);
    expect(readLastEndpoint(config.target.id)).toBeNull();
    expect(fs.existsSync(path.join(config.stateDir, "runtime", `${config.target.id}.json`))).toBe(false);
    const paired = JSON.parse((await runCli(["pair", "-w", config.worktree, "--json"], config)).stdout);
    expect(paired).toMatchObject({ requiresPairing: false, reusedConnection: true });
    expect(bridge.pairing.hasActiveSession()).toBe(false);
    const session = JSON.parse((await runCli(["session", "-w", config.worktree, "--json"], config)).stdout);
    expect(session.conversation.projectReady).toBe(true);
    expect(session.conversation.chatUrl).toBeNull();
    await runCli(["session", "set", "-w", config.worktree, "--url", "https://chatgpt.com/c/task-new", "--task", "issue-task", "--protocol-state", "INIT", "--waiting-for", "GPT_PLAN"], config);
    expect(readSession(config.target.id)?.checkpoint?.taskId).toBe("issue-task");
    expect(readSession(config.project.id)).toEqual(rootSession);
  });

  it("inherits the fixed address choice and prevents task cleanup from revoking shared access", async () => {
    const config = fixture();
    bindWorktree(config.project, config.target);
    writeTunnelState({ workspaceId: config.project.id, preference: "named", askedAt: new Date().toISOString(), tunnelName: "existing", hostname: "project.example.com", zone: "example.com" });
    const status = JSON.parse((await runCli(["tunnel", "status", "-w", config.worktree, "--json"], config)).stdout);
    expect(status.needsChoice).toBe(false);
    expect(status.hostname).toBe("project.example.com");
    await expect(runCli(["unpair", "-w", config.worktree], config)).rejects.toMatchObject({ stdout: expect.stringContaining("SHARED_CONNECTION") });
    await expect(runCli(["stop", "-w", config.worktree], config)).rejects.toMatchObject({ stdout: expect.stringContaining("SHARED_CONNECTION") });
    await expect(runCli(["tunnel", "choose", "--mode", "quick", "-w", config.worktree, "--json"], config)).rejects.toMatchObject({ stdout: expect.stringContaining("SHARED_CONNECTION") });
    expect(readLastEndpoint(config.project.id)?.mcpUrl).toBe("https://project.example/mcp");
  });
});

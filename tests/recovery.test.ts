import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { probeBridgeAt, findBridgeObservation } from "../src/bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../src/process/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import { writeLastEndpoint, readLastEndpoint } from "../src/config/endpoint.js";
import { writeTunnelState } from "../src/tunnel/state.js";
import type { TunnelProvider } from "../src/tunnel/provider.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const execute = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
const bridges: Bridge[] = [];
const servers: Server[] = [];
const temporary = (name: string) => { const dir = makeTmpDir(name); dirs.push(dir); return dir; };

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.close();
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of dirs.splice(0).reverse()) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

async function publicRoute(body: () => unknown) {
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body())); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

describe("shared connection recovery", () => {
  it("does not accept a proxy success page or unhealthy bridge as a healthy connection", async () => {
    let body: unknown = { service: "proxy", status: "ok", workspaceId: "wrong" };
    const url = await publicRoute(() => body);
    expect(await probeBridgeAt(url)).toBeNull();
    body = { service: "c2c-bridge", status: "failed", workspaceId: "wrong" };
    expect(await probeBridgeAt(url)).toBeNull();
  });

  it("concurrent cold starts share one live daemon and leave no duplicate listener", async () => {
    const stateDir = isolateStateDir(); dirs.push(stateDir);
    const root = temporary("daemon-project");
    const workspace = new Workspace(root);
    try {
      const started = await Promise.all([ensureBridge(root), ensureBridge(root), ensureBridge(root)]);
      expect(new Set(started.map((item) => item.runtime.pid)).size).toBe(1);
      expect(new Set(started.map((item) => item.runtime.port)).size).toBe(1);
      const log = fs.readFileSync(path.join(stateDir, "logs", `bridge-${workspace.id}.out.log`), "utf8");
      expect(log.match(/Bridge listening on/g)).toHaveLength(1);
    } finally {
      await stopBridge(root);
      await expect.poll(async () => (await findBridgeObservation(workspace.id)).state, { timeout: 6000 }).toBe("stopped");
    }
  }, 20_000);

  it.each([true, false])("doctor verifies actual public recovery (recovers=%s) without inventing an account login", async (recovers) => {
    const stateDir = isolateStateDir(); dirs.push(stateDir);
    const root = temporary("doctor-project");
    const workspace = new Workspace(root);
    let starts = 0;
    let stops = 0;
    let running = false;
    const url = await publicRoute(() => ({ service: "c2c-bridge", status: "ok", workspaceId: recovers && starts > 1 ? workspace.id : "another-project" }));
    const tunnel: TunnelProvider = {
      name: "cloudflare-named",
      async start() { starts++; await new Promise((resolve) => setTimeout(resolve, 80)); running = true; return url; },
      async stop() { stops++; running = false; },
      async restart(port) { await this.stop(); return this.start(port); },
      status() { return { running, url, provider: this.name }; },
      getPublicUrl() { return url; },
      async doctor() { return { provider: this.name, binaryFound: true, binaryPath: null, running, url, problems: [] }; },
    };
    writeTunnelState({ workspaceId: workspace.id, preference: "named", askedAt: new Date().toISOString(), tunnelName: "test", hostname: "project.example.com", zone: "example.com" });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel }); bridges.push(bridge);
    const runtime = (await ensureBridge(root)).runtime;
    await Promise.all([adminFetch(runtime, "POST", "/admin/tunnel/start"), adminFetch(runtime, "POST", "/admin/tunnel/start")]);
    expect(starts).toBe(1);
    writeLastEndpoint({ workspaceId: workspace.id, connectorName: "Existing", publicUrl: url, mcpUrl: `${url}/mcp`, port: bridge.port });
    const binaries = temporary("doctor-binaries");
    fs.chmodSync(write(binaries, "cloudflared", "#!/bin/sh\nexit 0\n"), 0o700);
    const result = await execute(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli/index.ts"), "doctor", "-w", root, "--json"], {
      cwd: repoRoot, timeout: 15_000,
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: temporary("doctor-codex"), PATH: `${binaries}${path.delimiter}${process.env.PATH}` },
    });
    const report = JSON.parse(result.stdout);
    expect(report.report.tunnel.ok).toBe(recovers);
    expect(report.namedRepair.needed).toBe(false);
    expect(report.chatgptRepair.needed).toBe(false);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(readLastEndpoint(workspace.id)?.mcpUrl).toBe(`${url}/mcp`);
    if (!recovers) expect(report.repairs.join(" ")).not.toContain("已重新建立安全连接");
    await Promise.all([adminFetch(runtime, "POST", "/admin/tunnel/restart"), adminFetch(runtime, "POST", "/admin/tunnel/restart")]);
    expect(starts).toBe(3);
    expect(stops).toBe(2);
    // Closing during a start must immediately stop advertising healthy,
    // then wait for that operation before releasing its process/resources.
    const pending = adminFetch(runtime, "POST", "/admin/tunnel/restart");
    await expect.poll(() => starts).toBe(4);
    const closing = bridge.close();
    expect(await probeBridgeAt(bridge.localBaseUrl())).toBeNull();
    await pending;
    await closing;
    expect(running).toBe(false);
  }, 20_000);
});

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

  it("observes an unfinished tunnel start without restarting or reclaiming its address", async () => {
    const stateDir = isolateStateDir(); dirs.push(stateDir);
    const root = temporary("doctor-pending-project");
    const workspace = new Workspace(root);
    const url = await publicRoute(() => ({ service: "c2c-bridge", status: "ok", workspaceId: workspace.id }));
    let finishStart!: () => void;
    const ready = new Promise<void>((resolve) => { finishStart = resolve; });
    let starts = 0;
    let running = false;
    const tunnel: TunnelProvider = {
      name: "cloudflare-quick",
      async start() { starts++; await ready; running = true; return url; },
      async stop() { running = false; },
      async restart(port) { await this.stop(); return this.start(port); },
      status() { return { running, url: running ? url : null, provider: this.name }; },
      getPublicUrl() { return running ? url : null; },
      async doctor() { return { provider: this.name, binaryFound: true, binaryPath: null, running, url, problems: [] }; },
    };
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel }); bridges.push(bridge);
    const runtime = (await ensureBridge(root)).runtime;
    writeLastEndpoint({ workspaceId: workspace.id, connectorName: "Existing", publicUrl: url, mcpUrl: `${url}/mcp`, port: bridge.port });
    try {
      await expect(adminFetch(runtime, "POST", "/admin/tunnel/start", 100)).rejects.toMatchObject({ name: "AbortError" });
      expect(await adminFetch(runtime, "GET", "/admin/info")).toMatchObject({ tunnelOperationPending: true });
      const result = await execute(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli/index.ts"), "doctor", "-w", root, "--json"], {
        cwd: repoRoot, timeout: 15_000,
        env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: temporary("pending-doctor-codex") },
      }).then(
        ({ stdout }) => ({ stdout, code: 0 }),
        (error) => {
          if (typeof error.code !== "number" || typeof error.stdout !== "string") throw error;
          return { stdout: error.stdout as string, code: error.code as number };
        }
      );
      const report = JSON.parse(result.stdout);
      expect(result.code).toBe(1);
      expect(report.report.tunnel.detail).toContain("TUNNEL_START_PENDING");
      expect(report.chatgptRepair.needed).toBe(false);
      expect(report.namedRepair.needed).toBe(false);
      expect(starts).toBe(1);
      expect(readLastEndpoint(workspace.id)?.mcpUrl).toBe(`${url}/mcp`);
    } finally {
      finishStart();
      await expect.poll(async () => (await adminFetch<{ tunnelOperationPending: boolean }>(runtime, "GET", "/admin/info")).tunnelOperationPending).toBe(false);
    }
    expect(await adminFetch(runtime, "GET", "/admin/info")).toMatchObject({ publicUrl: url });
  }, 20_000);

  it("keeps a healthy named connection when daemon credentials are unavailable to doctor", async () => {
    const stateDir = isolateStateDir(); dirs.push(stateDir);
    const root = temporary("doctor-healthy-project");
    const workspace = new Workspace(root);
    const url = await publicRoute(() => ({ service: "c2c-bridge", status: "ok", workspaceId: workspace.id }));
    let starts = 0;
    let running = false;
    const tunnel: TunnelProvider = {
      name: "cloudflare-named",
      async start() { starts++; running = true; return url; },
      async stop() { running = false; },
      async restart(port) { await this.stop(); return this.start(port); },
      status() { return { running, url, provider: this.name }; },
      getPublicUrl() { return url; },
      async doctor() { return { provider: this.name, binaryFound: true, binaryPath: null, running, url, problems: [] }; },
    };
    writeTunnelState({ workspaceId: workspace.id, preference: "named", tunnelId: "11111111-1111-4111-8111-111111111111", tunnelName: "test", hostname: "project.example.com" });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel }); bridges.push(bridge);
    const runtime = (await ensureBridge(root)).runtime;
    await adminFetch(runtime, "POST", "/admin/tunnel/start");
    const endpoint = { workspaceId: workspace.id, connectorName: "Existing", publicUrl: url, mcpUrl: `${url}/mcp`, port: bridge.port };
    writeLastEndpoint(endpoint);
    const result = await execute(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli/index.ts"), "doctor", "-w", root, "--json"], {
      cwd: repoRoot, timeout: 15_000,
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: temporary("healthy-doctor-codex"),
        TUNNEL_ORIGIN_CERT: path.join(root, "missing-cert.pem"), TUNNEL_CRED_FILE: path.join(root, "missing-credentials.json") },
    });
    const report = JSON.parse(result.stdout);
    expect(report.report.tunnel).toEqual({ ok: true, detail: url });
    expect(report.namedRepair.needed).toBe(false);
    expect(report.chatgptRepair.needed).toBe(false);
    expect(starts).toBe(1);
    expect(readLastEndpoint(workspace.id)?.mcpUrl).toBe(endpoint.mcpUrl);
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
    const tunnelId = "11111111-1111-4111-8111-111111111111";
    const credentials = temporary("doctor-credentials");
    const certPath = write(credentials, "cert.pem", "synthetic certificate");
    const credentialPath = write(credentials, "tunnel.json", JSON.stringify({ TunnelID: tunnelId, TunnelSecret: "synthetic-secret" }));
    writeTunnelState({ workspaceId: workspace.id, preference: "named", askedAt: new Date().toISOString(), tunnelId, tunnelName: "test", hostname: "project.example.com", zone: "example.com" });
    const bridge = await startBridge({ workspaceRoot: root, port: 0, tunnelProvider: tunnel }); bridges.push(bridge);
    const runtime = (await ensureBridge(root)).runtime;
    await Promise.all([adminFetch(runtime, "POST", "/admin/tunnel/start"), adminFetch(runtime, "POST", "/admin/tunnel/start")]);
    expect(starts).toBe(1);
    writeLastEndpoint({ workspaceId: workspace.id, connectorName: "Existing", publicUrl: url, mcpUrl: `${url}/mcp`, port: bridge.port });
    const binaries = temporary("doctor-binaries");
    fs.chmodSync(write(binaries, "cloudflared", "#!/bin/sh\nexit 0\n"), 0o700);
    const result = await execute(process.execPath, ["--import", "tsx", path.join(repoRoot, "src/cli/index.ts"), "doctor", "-w", root, "--json"], {
      cwd: repoRoot, timeout: 15_000,
      env: { ...process.env, C2C_STATE_DIR: stateDir, CODEX_HOME: temporary("doctor-codex"), TUNNEL_ORIGIN_CERT: certPath, TUNNEL_CRED_FILE: credentialPath, PATH: `${binaries}${path.delimiter}${process.env.PATH}` },
    }).then(
      ({ stdout }) => ({ stdout, code: 0 }),
      (error) => {
        if (typeof error.code !== "number" || typeof error.stdout !== "string") throw error;
        return { stdout: error.stdout as string, code: error.code as number };
      }
    );
    const report = JSON.parse(result.stdout);
    expect(result.code).toBe(recovers ? 0 : 1);
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

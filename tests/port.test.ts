import { describe, it, expect } from "vitest";
import path from "node:path";
import { createServer } from "node:http";
import { startBridge, BridgeAlreadyRunningError } from "../src/bridge/server.js";
import { probeBridge } from "../src/bridge/runtime.js";
import { makeTmpDir, cleanup, write, isolateStateDir } from "./helpers.js";

describe("port collision handling", () => {
  it("does not start a second listener when an occupied port's identity probe is slow", async () => {
    isolateStateDir();
    const root = makeTmpDir("port-uncertain");
    const slow = createServer((_req, res) => setTimeout(() => res.end('{}'), 650));
    await new Promise<void>((resolve) => slow.listen(0, "127.0.0.1", resolve));
    const address = slow.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    try {
      await expect(startBridge({ workspaceRoot: root, port: address.port, persistRuntime: false })).rejects.toThrow(/owner cannot be verified/);
    } finally {
      await new Promise<void>((resolve) => slow.close(() => resolve()));
      cleanup(root);
    }
  });
  it("does not start another bridge when the occupied port belongs to the same workspace", async () => {
    isolateStateDir();
    const root = makeTmpDir("port-same-project");
    write(root, "a.txt", "a");
    const bridge = await startBridge({ workspaceRoot: root, port: 0, persistRuntime: false });
    try {
      await expect(startBridge({ workspaceRoot: root, port: bridge.port, persistRuntime: false })).rejects.toBeInstanceOf(BridgeAlreadyRunningError);
      expect((await probeBridge(bridge.port))?.workspaceId).toBe(bridge.workspace.id);
    } finally {
      await bridge.close();
      cleanup(root);
    }
  });
  it("falls back to a free port when the preferred one is taken", async () => {
    isolateStateDir();
    const rootA = makeTmpDir("port-a");
    const rootB = makeTmpDir("port-b");
    write(rootA, "a.txt", "a");
    write(rootB, "b.txt", "b");
    const preferred = 47000 + Math.floor(Math.random() * 1000);

    const bridgeA = await startBridge({
      workspaceRoot: rootA,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "a.json"),
    });
    const bridgeB = await startBridge({
      workspaceRoot: rootB,
      port: preferred,
      persistRuntime: false,
      authStoreFile: path.join(makeTmpDir("auth"), "b.json"),
    });

    expect(bridgeA.port).toBe(preferred);
    expect(bridgeB.port).not.toBe(preferred);
    expect(bridgeB.port).toBeGreaterThan(0);

    // health identifies each bridge's workspace, so callers can detect reuse
    const healthA = await probeBridge(bridgeA.port);
    const healthB = await probeBridge(bridgeB.port);
    expect(healthA?.workspaceId).toBe(bridgeA.workspace.id);
    expect(healthB?.workspaceId).toBe(bridgeB.workspace.id);
    expect(healthA?.workspaceId).not.toBe(healthB?.workspaceId);

    await bridgeA.close();
    await bridgeB.close();
    cleanup(rootA);
    cleanup(rootB);
  });

  it("refuses to bind non-loopback hosts", async () => {
    const root = makeTmpDir("port-c");
    write(root, "c.txt", "c");
    await expect(
      startBridge({ workspaceRoot: root, host: "0.0.0.0", persistRuntime: false })
    ).rejects.toThrow(/loopback/);
    cleanup(root);
  });
});

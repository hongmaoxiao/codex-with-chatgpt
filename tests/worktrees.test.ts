import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Workspace } from "../src/workspace/manager.js";
import { bindWorktree, boundConnectionWorkspace, WorktreeRegistry } from "../src/workspace/worktrees.js";
import { cleanup, git, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

describe("registered worktree contexts", () => {
  const dirs: string[] = [];
  const temporary = (name: string): string => {
    const dir = makeTmpDir(name);
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.reverse()) cleanup(dir);
    dirs.length = 0;
    delete process.env.C2C_STATE_DIR;
  });

  function repository() {
    dirs.push(isolateStateDir());
    const root = temporary("worktree-project");
    makeGitRepo(root);
    const first = temporary("worktree-first");
    const second = temporary("worktree-second");
    git(root, "worktree", "add", "-b", "task-a", first);
    git(root, "worktree", "add", "-b", "task-b", second);
    bindWorktree(new Workspace(root), new Workspace(first));
    bindWorktree(new Workspace(root), new Workspace(second));
    return { root, first, second };
  }

  it("keeps the main checkout's connection identity and selects each registered worktree", () => {
    const { root, first, second } = repository();
    const main = new Workspace(root);
    const a = new Workspace(first);
    const b = new Workspace(second);
    const registry = new WorktreeRegistry(main);
    expect(boundConnectionWorkspace(a)?.id).toBe(main.id);
    expect(boundConnectionWorkspace(b)?.id).toBe(main.id);
    expect(registry.list().map((item) => item.worktreeId).sort()).toEqual([main.id, a.id, b.id].sort());
    expect(registry.resolve({ worktree_id: a.id, expected_branch: "task-a" }).root).toBe(first);
    expect(registry.resolve({ worktree_id: b.id, expected_branch: "task-b" }).root).toBe(second);
    expect(() => registry.resolve({})).toThrow(/Pass worktree_id/);
    expect(registry.resolve({ worktree_id: main.id }).root).toBe(root);
    expect(registry.resolve({}, { allowDiscovery: true }).root).toBe(root);
  });

  it("does not expand connectors authorized for a subtree or a linked worktree", () => {
    const { root, first, second } = repository();
    const subtree = new Workspace(path.join(root, "src"));
    expect(boundConnectionWorkspace(subtree)).toBeNull();
    expect(new WorktreeRegistry(subtree).list()).toEqual([]);
    expect(() => new WorktreeRegistry(subtree).resolve({ worktree_id: new Workspace(first).id })).toThrow(/not registered/);
    expect(() => new WorktreeRegistry(new Workspace(first)).resolve({ worktree_id: new Workspace(second).id })).toThrow(/not registered/);
  });

  it("rejects ownership chains, cycles and rebinding a connection with registered tasks", () => {
    const { root, first, second } = repository();
    const main = new Workspace(root);
    const a = new Workspace(first);
    const b = new Workspace(second);
    expect(() => bindWorktree(a, b)).toThrow(/original project connection/);
    expect(() => bindWorktree(a, main)).toThrow(/original project connection/);
    const otherRoot = temporary("worktree-other-owner");
    git(root, "worktree", "add", "-b", "other-owner", otherRoot);
    expect(() => bindWorktree(new Workspace(otherRoot), main)).toThrow(/owns task bindings/);
    expect(boundConnectionWorkspace(a)?.id).toBe(main.id);
    expect(boundConnectionWorkspace(b)?.id).toBe(main.id);
  });

  it("rejects foreign, removed and branch-switched worktrees", () => {
    const { root, first, second } = repository();
    const foreign = temporary("worktree-foreign");
    makeGitRepo(foreign);
    const registry = new WorktreeRegistry(new Workspace(root));
    expect(() => registry.resolve({ worktree_id: new Workspace(foreign).id })).toThrow(/not registered/);
    expect(() => registry.resolve({ worktree_id: "../../outside" })).toThrow(/not registered/);
    const a = new Workspace(first);
    expect(() => registry.resolve({ worktree_id: a.id, expected_branch: "task-b" })).toThrow(/expected branch/);
    git(first, "checkout", "-b", "changed-branch");
    expect(() => registry.resolve({ worktree_id: a.id, expected_branch: "task-a" })).toThrow(/expected branch/);
    const b = new Workspace(second);
    git(root, "worktree", "remove", second);
    expect(() => registry.resolve({ worktree_id: b.id })).toThrow(/not registered/);
  });

  it("enforces both connection and task sensitive-file rules and rejects symlink escapes", async () => {
    const { root, first } = repository();
    write(root, ".c2cignore", "project-private.txt\n");
    write(first, ".c2cignore", "!project-private.txt\ntask-private.txt\n");
    write(first, "project-private.txt", "project secret");
    write(first, "task-private.txt", "task secret");
    write(first, ".env", "TOKEN=secret");
    const outside = temporary("worktree-outside");
    write(outside, "private.txt", "outside secret");
    fs.symlinkSync(path.join(outside, "private.txt"), path.join(first, "escape.txt"));
    const selected = new WorktreeRegistry(new Workspace(root)).resolve({ worktree_id: new Workspace(first).id });
    for (const file of ["project-private.txt", "task-private.txt", ".env"]) {
      await expect(selected.readFile(file)).rejects.toMatchObject({ code: "ACCESS_DENIED_SENSITIVE_FILE" });
    }
    await expect(selected.readFile("escape.txt")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
  });
});

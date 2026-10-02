import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importMediaAsset } from "../src/media/import.js";
import { Workspace } from "../src/workspace/manager.js";
import { readWorkspaceImage } from "../src/workspace/media.js";
import { cleanup, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
});

describe("workspace image boundaries", () => {
  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="&#104;ttps://example.com/pixel.png"/></svg>',
  ])("refuses SVG rendering/import while allowing text review: %s", async (svg) => {
    const root = makeTmpDir("svg-boundary"); dirs.push(root);
    const source = write(root, "source.svg", svg);
    const workspace = new Workspace(root);
    await expect(readWorkspaceImage(workspace, "source.svg")).rejects.toMatchObject({ code: "BINARY_FILE" });
    await expect(importMediaAsset({ workspaceRoot: root, sourcePath: source, destinationPath: "public/asset.svg" }))
      .rejects.toThrow(/Unsupported media destination type/);
    expect(fs.existsSync(path.join(root, "public/asset.svg"))).toBe(false);
    expect((await workspace.readFile("source.svg")).content).toContain(svg);
  });

  it("rejects oversized and spoofed images before returning image data", async () => {
    const root = makeTmpDir("image-boundary"); dirs.push(root);
    const workspace = new Workspace(root);
    write(root, "fake.png", "not a PNG");
    await expect(readWorkspaceImage(workspace, "fake.png")).rejects.toMatchObject({ code: "BINARY_FILE" });
    const large = write(root, "large.png", "");
    fs.truncateSync(large, 10 * 1024 * 1024 + 1);
    await expect(readWorkspaceImage(workspace, "large.png")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

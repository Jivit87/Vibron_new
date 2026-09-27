import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { listLocalWorkspaces, resetMemoryStoreForTests } from "@/lib/store";
import { findWorkspace } from "@/lib/workspace";

let root: string;

beforeEach(async () => {
  resetMemoryStoreForTests();
  root = await mkdtemp(path.join(os.tmpdir(), "viberon-wslist-"));
  await writeFile(path.join(root, "a.py"), "def a():\n    return 1\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspaces", () => {
  it("re-opening a cloned folder keeps its owner/name label", async () => {
    const cloned = await registerLocalWorkspace(root, { label: "sindresorhus/slugify" });
    const reopened = await registerLocalWorkspace(root);
    expect(reopened.repoKey).toBe(cloned.repoKey);
    expect(reopened.label).toBe("sindresorhus/slugify");
  });

  it("GET /api/workspaces lists registered folders, newest first", async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), "viberon-wslist-"));
    try {
      const first = await registerLocalWorkspace(root);
      await new Promise((r) => setTimeout(r, 5));
      const second = await registerLocalWorkspace(other, { label: "o/r" });
      expect((await listLocalWorkspaces()).map((w) => w.repoKey)).toEqual([second.repoKey, first.repoKey]);
      const { GET } = await import("@/app/api/workspaces/route");
      const body = (await (await GET()).json()) as { workspaces: { repoKey: string; label: string; rootPath: string }[] };
      expect(body.workspaces).toEqual([
        expect.objectContaining({ repoKey: second.repoKey, label: "o/r", rootPath: path.resolve(other) }),
        expect.objectContaining({ repoKey: first.repoKey, rootPath: path.resolve(root) }),
      ]);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("unknown repoKeys are 404, not an empty fabricated workspace", async () => {
    expect(await findWorkspace("nope")).toBeNull();
    const memory = await import("@/app/api/memory/route");
    const graph = await import("@/app/api/memory/graph/route");
    expect((await memory.GET(new Request("http://x/api/memory?repoKey=nope"))).status).toBe(404);
    expect((await graph.GET(new Request("http://x/api/memory/graph?repoKey=nope"))).status).toBe(404);
    const meta = await registerLocalWorkspace(root);
    expect((await findWorkspace(meta.repoKey))?.rootPath).toBe(path.resolve(root));
    expect((await memory.GET(new Request(`http://x/api/memory?repoKey=${meta.repoKey}`))).status).toBe(200);
  });
});

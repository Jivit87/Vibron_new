/**
 * The disk store: one file per key, async writes, lazy reads, and the
 * one-time migration of the legacy single-file `.viberon-dev-store.json`
 * (which holds secrets: provider keys, the GitHub integration token).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

process.env.VIBERON_STORE = "disk";

const store = await import("@/lib/store");
const { ShardStore, SHARD_DIR, LEGACY_STORE_FILE } = await import("@/lib/store-shards");
const { shardFileName, keyFromShardFileName, WORKER_SHARD_FILE_NAME } = await import("@/lib/workers/store-migrate");
const { registerLocalWorkspace } = await import("@/lib/local-disk-workspace");
const { clearGraphIndexCache } = await import("@/lib/workspace/graph-index");
const { registerEphemeralWorkspace, releaseEphemeralWorkspace } = await import("@/lib/workspace/ephemeral");

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "viberon-store-test-"));
  process.env.VIBERON_STORE_DIR = dir;
  store.forgetStoreCachesForTests();
  clearGraphIndexCache();
});

afterEach(async () => {
  await store.flushStoreForTests();
  store.forgetStoreCachesForTests();
  delete process.env.VIBERON_STORE_DIR;
  await rm(dir, { recursive: true, force: true });
});

/** What a pre-migration store looked like on a user's machine. */
const LEGACY: Array<[string, { value: unknown; expiresAt?: number }]> = [
  ["credential:anthropic", { value: { apiKey: "sk-ant-secret-1" } }],
  ["credential:openai", { value: { apiKey: "sk-openai-secret-2" } }],
  ["mcp:global-servers", { value: [{ id: "github", env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" } }] }],
  ["tasks:v1", { value: [{ id: "t1", state: "done", task: "fix it" }] }],
  ["conversations:repo-1", { value: [{ id: "c1", title: "Hello Wörld ✓", messages: [] }] }],
  ["memory:repo-1", { value: { facts: ["uses pnpm"], lessons: [] } }],
  ["workspace:repo-1", { value: { repoKey: "repo-1", rootPath: "/nowhere", repoRef: "local/x", label: "x", registeredAt: 1 } }],
  ["job:abc", { value: { jobId: "abc" }, expiresAt: Date.now() + 3_600_000 }],
  ["MixedCase:Key/With Spaces?&", { value: 42 }],
  [`long:${"x".repeat(400)}`, { value: "long key" }],
];

async function writeLegacy(entries = LEGACY, extra = ""): Promise<string> {
  const file = path.join(dir, LEGACY_STORE_FILE);
  const body = JSON.stringify(entries);
  await writeFile(file, extra ? `${body.slice(0, -1)},${extra}]` : body);
  return body;
}

describe("shard file names", () => {
  it("round-trip, never collide on case, and match the worker's copy", () => {
    const workerFn = new Function(`${WORKER_SHARD_FILE_NAME}; return shardFileName;`)() as typeof shardFileName;
    const keys = LEGACY.map(([key]) => key).concat(["a", "A", "..", "raw:ab/cd", "ümlaut", "_3a"]);
    const names = new Set<string>();
    for (const key of keys) {
      const name = shardFileName(key, sha1);
      expect(workerFn(key, sha1)).toBe(name);
      expect(names.has(name.toLowerCase())).toBe(false);
      names.add(name.toLowerCase());
      if (name.startsWith("k")) expect(keyFromShardFileName(name)).toBe(key);
      expect(name.length).toBeLessThan(200);
    }
  });
});

describe("disk store", () => {
  it("keeps one file per key, writes asynchronously, and survives a restart", async () => {
    await store.setValueRaw("credential:anthropic", { apiKey: "k" });
    await store.setValueRaw("tasks:v1", [{ id: "a" }]);
    // Visible at once, before any disk write finished.
    expect(await store.getValueRaw("tasks:v1")).toEqual([{ id: "a" }]);
    await store.flushStoreForTests();
    const files = readdirSync(path.join(dir, SHARD_DIR)).filter((n) => n.endsWith(".json") && n !== "migration.json");
    expect(files).toHaveLength(2);
    expect(existsSync(path.join(dir, LEGACY_STORE_FILE))).toBe(false);

    store.forgetStoreCachesForTests();
    expect(await store.getValueRaw("credential:anthropic")).toEqual({ apiKey: "k" });
    expect(store.persistedStoreKeys().sort()).toEqual(["credential:anthropic", "tasks:v1"]);
  });

  it("coalesces a burst of writes to one key and sees another process's write", async () => {
    for (let i = 0; i < 50; i += 1) await store.setValueRaw("tasks:v1", [{ id: `t${i}` }]);
    await store.flushStoreForTests();
    expect(await store.getValueRaw("tasks:v1")).toEqual([{ id: "t49" }]);
    // A second "process" on the same folder.
    const other = new ShardStore(dir);
    other.set("tasks:v1", { value: [{ id: "from-other" }] });
    await other.flush();
    other.close();
    expect(await store.getValueRaw("tasks:v1")).toEqual([{ id: "from-other" }]);
  });

  it("expires entries with a TTL", async () => {
    await store.setValueRaw("job:x", { a: 1 }, 60);
    await store.flushStoreForTests();
    expect(await store.getValueRaw("job:x")).toEqual({ a: 1 });
    await mkdir(path.join(dir, SHARD_DIR), { recursive: true });
    await writeFile(
      path.join(dir, SHARD_DIR, shardFileName("job:old", sha1)),
      JSON.stringify({ key: "job:old", value: 1, expiresAt: Date.now() - 1 }),
    );
    expect(await store.getValueRaw("job:old")).toBeNull();
  });
});

describe("migration of .viberon-dev-store.json", () => {
  it("backs up the old file, keeps every key and value, and reads a pre-migration file", async () => {
    const body = await writeLegacy();
    for (const [key, entry] of LEGACY) expect(await store.getValueRaw(key)).toEqual(entry.value);
    // Backed up byte for byte and never deleted; the original is gone.
    expect(readFileSync(path.join(dir, `${LEGACY_STORE_FILE}.bak`), "utf8")).toBe(body);
    expect(existsSync(path.join(dir, LEGACY_STORE_FILE))).toBe(false);
    expect(store.persistedStoreKeys().sort()).toEqual(LEGACY.map(([key]) => key).sort());
    const marker = JSON.parse(readFileSync(path.join(dir, SHARD_DIR, "migration.json"), "utf8"));
    expect(marker).toMatchObject({ done: true, keys: LEGACY.length });
    // Nothing secret leaks into the marker.
    expect(JSON.stringify(marker)).not.toContain("secret");

    // After a restart the shards are read; the backup is not migrated again.
    await store.setValueRaw("tasks:v1", [{ id: "new" }]);
    await store.flushStoreForTests();
    store.forgetStoreCachesForTests();
    expect(await store.getValueRaw("tasks:v1")).toEqual([{ id: "new" }]);
    expect(await store.getValueRaw("mcp:global-servers")).toEqual(LEGACY[2]![1].value);
    expect(existsSync(path.join(dir, `${LEGACY_STORE_FILE}.bak`))).toBe(true);
  });

  it("never overwrites an existing backup and never overwrites a newer shard", async () => {
    await writeFile(path.join(dir, `${LEGACY_STORE_FILE}.bak`), "older backup");
    await mkdir(path.join(dir, SHARD_DIR), { recursive: true });
    await writeFile(
      path.join(dir, SHARD_DIR, shardFileName("tasks:v1", sha1)),
      JSON.stringify({ key: "tasks:v1", value: [{ id: "newer" }], expiresAt: null }),
    );
    await writeLegacy();
    await store.storeReady();
    expect(readFileSync(path.join(dir, `${LEGACY_STORE_FILE}.bak`), "utf8")).toBe("older backup");
    expect(readdirSync(dir).filter((n) => n.startsWith(`${LEGACY_STORE_FILE}.bak.`))).toHaveLength(1);
    expect(await store.getValueRaw("tasks:v1")).toEqual([{ id: "newer" }]);
    expect(await store.getValueRaw("credential:openai")).toEqual({ apiKey: "sk-openai-secret-2" });
  });

  it("parses a large store off the event loop", async () => {
    const blob = "x".repeat(1_000_000);
    const big = Array.from({ length: 40 }, (_, i) => `["raw:repo-${i}",{"value":[{"path":"a.ts","source":"${blob}"}]}]`).join(",");
    await writeLegacy(LEGACY, big);
    expect(statSync(path.join(dir, LEGACY_STORE_FILE)).size).toBeGreaterThan(40_000_000);
    const histogram = monitorEventLoopDelay({ resolution: 5 });
    histogram.enable();
    const reads = await Promise.all(LEGACY.map(([key]) => store.getValueRaw(key)));
    histogram.disable();
    expect(reads).toEqual(LEGACY.map(([, entry]) => entry.value));
    // Parsing 40 MB on the main thread alone takes far longer than this.
    expect(histogram.max / 1e6).toBeLessThan(150);
    expect(store.persistedStoreKeys()).toHaveLength(LEGACY.length + 40);
  });
});

describe("derived data stays out of the persisted store", () => {
  it("a folder workspace persists its meta and token index, never its raw files or graph", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-derived-"));
    try {
      await writeFile(path.join(root, "a.ts"), "export function alpha() { return beta(); }\nimport { beta } from './b';\n");
      await writeFile(path.join(root, "b.ts"), "export function beta() { return 1; }\n");
      const meta = await registerLocalWorkspace(root);
      await store.flushStoreForTests();
      const keys = store.persistedStoreKeys();
      expect(keys).toContain(`workspace:${meta.repoKey}`);
      expect(keys).toContain(`files:${meta.repoKey}`);
      expect(keys.some((k) => k.startsWith("raw:") || k.startsWith("graph:"))).toBe(false);

      // After a restart both are derived again from the folder.
      store.forgetStoreCachesForTests();
      clearGraphIndexCache();
      expect((await store.getGraph(meta.repoKey))?.nodes.map((n) => n.name).sort()).toEqual(["alpha", "beta"]);
      expect(await store.getRawFile(meta.repoKey, "b.ts")).toEqual({ path: "b.ts", source: "export function beta() { return 1; }\n" });
      expect((await store.getRawFiles(meta.repoKey)).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
      expect((await store.getFileInfo(meta.repoKey)).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("a store workspace (no folder) still persists its raw files and graph", async () => {
    await store.putRawFiles("gh-repo", [{ path: "x.py", source: "def x():\n    pass\n" }]);
    await store.flushStoreForTests();
    store.forgetStoreCachesForTests();
    expect(await store.getRawFile("gh-repo", "x.py")).toEqual({ path: "x.py", source: "def x():\n    pass\n" });
  });

  it("ephemeral issue-worktree entries stay in memory only", async () => {
    registerEphemeralWorkspace("eph-1", path.join(os.tmpdir(), "viberon-issue-zz", "repo"));
    await store.setValueRaw("graph:eph-1", { nodes: [] });
    await store.flushStoreForTests();
    expect(await store.getValueRaw("graph:eph-1")).toEqual({ nodes: [] });
    expect(store.persistedStoreKeys()).not.toContain("graph:eph-1");
    releaseEphemeralWorkspace("eph-1");
    expect(await store.getValueRaw("graph:eph-1")).toBeNull();
  });

  it("migrated blobs of a folder workspace are dropped once it re-indexes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-derived-"));
    try {
      await writeFile(path.join(root, "a.py"), "def a():\n    return 1\n");
      const repoKey = "legacy-ws";
      await writeLegacy([
        ["workspace:legacy-ws", { value: { repoKey, rootPath: root, repoRef: "local/a", label: "a", registeredAt: 1 } }],
        ["raw:legacy-ws", { value: [{ path: "a.py", source: "stale" }] }],
        ["graph:legacy-ws", { value: { nodes: [], edges: [], meta: {} } }],
      ]);
      await store.storeReady();
      expect(store.persistedStoreKeys().sort()).toEqual(["graph:legacy-ws", "raw:legacy-ws", "workspace:legacy-ws"]);
      await registerLocalWorkspace(root, { repoKey, repoRef: "local/a", label: "a" });
      await store.flushStoreForTests();
      expect(store.persistedStoreKeys().sort()).toEqual(["files:legacy-ws", "workspace:legacy-ws"]);
      expect(await store.getRawFile(repoKey, "a.py")).toEqual({ path: "a.py", source: "def a():\n    return 1\n" });
      // The backup still has everything.
      expect(await readFile(path.join(dir, `${LEGACY_STORE_FILE}.bak`), "utf8")).toContain("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

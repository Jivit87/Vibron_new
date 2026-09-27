import { beforeEach, describe, expect, it } from "vitest";

import { ContextLedger } from "@/lib/context/ledger";
import { attributeRows, type EngineInput } from "@/lib/context/engine";
import { deriveMemory, emptyMemory } from "@/lib/memory";
import { parseRepo } from "@/lib/parser";
import { resetMemoryStoreForTests } from "@/lib/store";
import { runTool, type ToolContext } from "@/lib/tools/registry";

/**
 * Attribution is additive: every chunk the ledger sees can name the files
 * and graph nodes it came from, and the snapshot rolls those up per file,
 * per node and per tool. The original totals must not move.
 */

const SHELL = [
  "/** Builds the public app shell. */",
  "export function createShell() {",
  "  return { title: 'Viberon' };",
  "}",
  "",
  "export function mountShell() {",
  "  return createShell();",
  "}",
  "",
].join("\n");

const ROUTER = [
  "/** Resolves a path to a route handler. */",
  "export function resolveRoute(path) {",
  "  return routes[path];",
  "}",
  "",
].join("\n");

const FILES = [
  { path: "src/shell.ts", source: SHELL },
  { path: "src/router.ts", source: ROUTER },
];

function buildContext(): { ctx: ToolContext; ledger: ContextLedger; engine: EngineInput } {
  const parsed = parseRepo(FILES, "owner/repo@main");
  const memory = emptyMemory("fixture");
  deriveMemory(memory, FILES, parsed.graph);
  const ledger = new ContextLedger();
  const engine: EngineInput = {
    graph: parsed.graph,
    memory,
    fileInfo: FILES.map((f) => ({ path: f.path, tokenCount: 40 })),
    readFile: async (path) => FILES.find((f) => f.path === path)?.source ?? null,
    ledger,
  };
  return {
    ledger,
    engine,
    ctx: {
      handle: { repoKey: "fixture", rootPath: null, repoRef: "owner/repo@main", label: "fixture" },
      engine,
      memory,
      agent: "Test",
      commandPolicy: "never",
      events: {},
    },
  };
}

describe("ContextLedger attribution", () => {
  it("rolls tokens up per file, per node and per source, splitting shared chunks evenly", () => {
    const ledger = new ContextLedger();
    ledger.offer("graph_slice", "slice", "alpha beta gamma delta epsilon zeta", {
      paths: ["a.ts", "b.ts"],
      nodeIds: ["a#one", "b#two"],
    });
    const snap = ledger.snapshot();
    const tokens = snap.sentTokens;
    expect(tokens).toBeGreaterThan(0);

    const byPath = new Map(snap.files!.map((f) => [f.path, f]));
    // Shares are rounded per file for the wire, so the sum is within one per file.
    const sum = byPath.get("a.ts")!.sentTokens + byPath.get("b.ts")!.sentTokens;
    expect(Math.abs(sum - tokens)).toBeLessThanOrEqual(2);
    expect(byPath.get("a.ts")!.sentTokens).toBe(byPath.get("b.ts")!.sentTokens);
    expect(byPath.get("a.ts")!.reads).toBe(1);
    expect(snap.nodes!.map((n) => n.id).sort()).toEqual(["a#one", "b#two"]);
    expect(snap.sources).toEqual([{ source: "graph_slice", tokens, dedupedTokens: 0, count: 1 }]);
    expect(snap.events[0].paths).toEqual(["a.ts", "b.ts"]);
    expect(snap.events[0].nodeIds).toEqual(["a#one", "b#two"]);
  });

  it("counts a deduped repeat as a read with deduped tokens, not sent tokens", () => {
    const ledger = new ContextLedger();
    const first = ledger.offer("read_file", "a.ts", "some file text here", { paths: ["a.ts"] });
    ledger.offer("read_file", "a.ts", "some file text here", { paths: ["a.ts"] });
    const file = ledger.snapshot().files![0];
    expect(file).toEqual({ path: "a.ts", sentTokens: first.tokens, dedupedTokens: first.tokens, reads: 2 });
  });

  it("keeps sentTokens/dedupedTokens unchanged by untracked records", () => {
    const ledger = new ContextLedger();
    ledger.offer("read_file", "a.ts", "text one");
    const before = ledger.snapshot();
    const tokens = ledger.record("grep", 'grep "x"', "a.ts:1: x\nb.ts:2: x", { paths: ["a.ts", "b.ts"] });
    const after = ledger.snapshot();
    expect(tokens).toBeGreaterThan(0);
    expect(after.sentTokens).toBe(before.sentTokens);
    expect(after.dedupedTokens).toBe(before.dedupedTokens);
    expect(after.events.at(-1)).toMatchObject({ source: "grep", untracked: true, deduped: false });
    expect(after.files!.find((f) => f.path === "b.ts")!.reads).toBe(1);
  });

  it("drops duplicate and empty attribution entries", () => {
    const ledger = new ContextLedger();
    ledger.offer("x", "x", "text", { paths: ["a.ts", "a.ts", ""], nodeIds: [] });
    const snap = ledger.snapshot();
    expect(snap.events[0].paths).toEqual(["a.ts"]);
    expect(snap.events[0].nodeIds).toBeUndefined();
    expect(snap.nodes).toEqual([]);
  });

  it("shares attribution across forks, like the totals", () => {
    const root = new ContextLedger();
    root.fork("a").offer("read_file", "a.ts", "text a", { paths: ["a.ts"] });
    root.fork("b").offer("read_file", "a.ts", "text a", { paths: ["a.ts"] });
    // Dedupe is per agent, so both forks sent it.
    expect(root.snapshot().files![0].reads).toBe(2);
    expect(root.snapshot().files![0].dedupedTokens).toBe(0);
  });

  it("invalidates by attributed path, not only by label", () => {
    const ledger = new ContextLedger();
    ledger.offer("graph_slice", 'graph slice for "shell"', "slice text", { paths: ["src/shell.ts"] });
    ledger.invalidatePath("src/shell.ts");
    const again = ledger.offer("graph_slice", 'graph slice for "shell"', "slice text", { paths: ["src/shell.ts"] });
    expect(again.deduped).toBe(false);
  });
});

describe("engine attribution through the tools", () => {
  beforeEach(resetMemoryStoreForTests);

  it("graph_search attributes the slice to its nodes and their files", async () => {
    const { ctx, ledger, engine } = buildContext();
    await runTool("graph_search", { query: "shell" }, ctx);
    const event = ledger.snapshot().events.find((e) => e.source === "graph_slice")!;
    expect(event.nodeIds?.length).toBeGreaterThan(0);
    const files = new Set(engine.graph!.nodes.filter((n) => event.nodeIds!.includes(n.id)).map((n) => n.file));
    expect(new Set(event.paths)).toEqual(files);
  });

  it("read_file attributes the path and the symbols inside the window", async () => {
    const { ctx, ledger, engine } = buildContext();
    await runTool("read_file", { path: "src/shell.ts", start_line: 1, end_line: 4 }, ctx);
    const event = ledger.snapshot().events.at(-1)!;
    expect(event.paths).toEqual(["src/shell.ts"]);
    const create = engine.graph!.nodes.find((n) => n.name === "createShell")!;
    const mount = engine.graph!.nodes.find((n) => n.name === "mountShell")!;
    expect(event.nodeIds).toContain(create.id);
    expect(event.nodeIds).not.toContain(mount.id);
  });

  it("symbol_outline, grep and find_symbols are recorded without moving sentTokens", async () => {
    const { ctx, ledger } = buildContext();
    await runTool("symbol_outline", { path: "src/router.ts" }, ctx);
    await runTool("grep", { pattern: "createShell" }, ctx);
    await runTool("find_symbols", { query: "resolveRoute" }, ctx);
    const snap = ledger.snapshot();
    expect(snap.sentTokens).toBe(0);
    const sources = snap.sources!.map((s) => s.source).sort();
    expect(sources).toEqual(["find_symbols", "grep", "symbol_outline"]);
    const grep = snap.events.find((e) => e.source === "grep")!;
    expect(grep.paths).toEqual(["src/shell.ts"]);
    expect(snap.files!.map((f) => f.path).sort()).toEqual(["src/router.ts", "src/shell.ts"]);
  });

  it("attributeRows maps path:line rows to files and the nodes containing those lines", () => {
    const { engine } = buildContext();
    const rows = "src/shell.ts:7: return createShell();\nsrc/missing.ts:1: nope\nnot a row";
    const { paths, nodeIds } = attributeRows(engine, rows);
    expect(paths).toEqual(["src/shell.ts"]);
    const mount = engine.graph!.nodes.find((n) => n.name === "mountShell")!;
    expect(nodeIds).toEqual([mount.id]);
  });
});

import { describe, expect, it } from "vitest";

import { ROLES } from "@/lib/agents/roles";
import {
  GREP_PER_FILE,
  LIST_MAX_ENTRIES,
  READ_DEFAULT_LINES,
  READ_MAX_LINES,
  SOLVER_TOOLS,
  capChars,
  capLines,
  groupByFile,
  runTool,
  toolDefs,
  type ToolContext,
} from "@/lib/tools/registry";
import { strReplace } from "@/lib/tools/editor";
import { renderView } from "@/lib/tools/navigate";
import { countTokens } from "@/lib/tokens";
import { makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

function ctx(ws: TestWorkspace): ToolContext {
  return { handle: ws.handle, engine: ws.engine, memory: ws.memory, agent: "T", commandPolicy: "never", events: {} };
}

const numbered = (n: number, prefix = "line") => Array.from({ length: n }, (_, i) => `const ${prefix}${i + 1} = ${i + 1};`).join("\n") + "\n";

describe("tool schema budget (sent on every turn)", () => {
  it("keeps each role's tool definitions under a token budget", () => {
    const tokens = (names: string[]) => countTokens(JSON.stringify(toolDefs(names)));
    // Measured after the T2 cut: solver 722, generalist 1696, reviewer 987.
    expect(tokens(ROLES.solver.tools)).toBeLessThan(800);
    expect(tokens(ROLES.generalist.tools)).toBeLessThan(1850);
    expect(tokens(ROLES.reviewer.tools)).toBeLessThan(1100);
  });

  it("is deterministic: same names give byte-identical definitions", () => {
    expect(JSON.stringify(toolDefs(SOLVER_TOOLS))).toBe(JSON.stringify(toolDefs([...SOLVER_TOOLS])));
    expect(toolDefs(SOLVER_TOOLS).map((d) => d.name)).toEqual(SOLVER_TOOLS);
  });
});

describe("tool output caps", () => {
  it("read_file without a range returns a bounded window and says how to continue", async () => {
    const ws = await makeWorkspace([{ path: "src/big.ts", source: numbered(900) }]);
    const out = await runTool("read_file", { path: "src/big.ts" }, ctx(ws));
    expect(out).toContain(`lines 1-${READ_DEFAULT_LINES} of 901`);
    expect(out).toContain(`call read_file with start_line=${READ_DEFAULT_LINES + 1}`);
    expect(out).not.toContain(`line${READ_DEFAULT_LINES + 1} =`);
  });

  it("read_file caps an explicit range and leaves a small file whole", async () => {
    const ws = await makeWorkspace([
      { path: "src/big.ts", source: numbered(900) },
      { path: "src/small.ts", source: numbered(20) },
    ]);
    const big = await runTool("read_file", { path: "src/big.ts", start_line: 1, end_line: 900 }, ctx(ws));
    expect(big).toContain(`lines 1-${READ_MAX_LINES} of 901`);
    expect(big).toContain(`start_line=${READ_MAX_LINES + 1}`);
    const exact = await runTool("read_file", { path: "src/big.ts", start_line: 10, end_line: 20 }, ctx(ws));
    expect(exact).toContain("lines 10-20 of 901");
    expect(exact).not.toContain("more lines");
    const small = await runTool("read_file", { path: "src/small.ts" }, ctx(ws));
    expect(small).toContain("line20 = 20");
    expect(small).not.toContain("more lines");
  });

  it("grep groups hits by file and caps each file", async () => {
    const ws = await makeWorkspace([
      { path: "src/a.ts", source: numbered(40, "needle") },
      { path: "src/b.ts", source: "export const needle = 1;\n" },
    ]);
    const out = await runTool("grep", { pattern: "needle" }, ctx(ws));
    expect(out).toMatch(/^src\/a\.ts \(\d+\):$/m);
    expect(out).toMatch(/^ {2}1: const needle1 = 1;$/m);
    expect(out).toContain("more in this file");
    expect(out).toMatch(/^src\/b\.ts:1: export const needle = 1;$/m);
    expect(out.split("\n").filter((l) => /^ {2}\d+: /.test(l) && l.includes("needle")).length).toBeLessThanOrEqual(GREP_PER_FILE + 1);
  });

  it("groupByFile leaves non-row output alone", () => {
    expect(groupByFile('No matches for "x" across 3 files.')).toBe('No matches for "x" across 3 files.');
  });

  it("list_files summarizes a large workspace by folder unless a glob is given", async () => {
    const files = Array.from({ length: LIST_MAX_ENTRIES + 20 }, (_, i) => ({
      path: `pkg${i % 3}/sub/f${i}.ts`,
      source: `export const f${i} = ${i};\n`,
    }));
    const ws = await makeWorkspace(files);
    const out = await runTool("list_files", {}, ctx(ws));
    expect(out).toContain("by folder");
    expect(out).toMatch(/^pkg0\/sub\/ \(\d+ files, \d+t\)$/m);
    expect(out.split("\n").length).toBeLessThan(10);
    const globbed = await runTool("list_files", { glob: "pkg1/**" }, ctx(ws));
    expect(globbed).toContain("pkg1/sub/f1.ts");
  });

  it("view keeps a long file's expanded sections within budget", () => {
    const body = Array.from({ length: 40 }, (_, i) =>
      [`function f${i}() {`, ...Array.from({ length: 20 }, () => "  target();"), "}"].join("\n"),
    ).join("\n");
    const out = renderView("x.ts", body, { terms: ["target"] });
    expect(out.split("\n").length).toBeLessThan(330);
    expect(out).toContain("left folded");
  });

  it("an edit miss never echoes a long find back whole", () => {
    const file = Array.from({ length: 200 }, (_, i) => `row ${i} value`).join("\n");
    const find = Array.from({ length: 100 }, (_, i) => `row ${i + 50} valu`).join("\n");
    const outcome = strReplace(file, find, "x", { path: "f.txt" });
    expect(outcome.ok).toBe(false);
    if ("error" in outcome) {
      expect(outcome.error).toContain("lines not shown");
      expect(outcome.error.split("\n").length).toBeLessThan(40);
    }
  });

  it("capLines and capChars say what they dropped", () => {
    expect(capLines("a\nb\nc", 2, "hint")).toBe("a\nb\n[… 1 more lines not shown; hint]");
    expect(capLines("a\nb", 2, "hint")).toBe("a\nb");
    const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const capped = capChars(text, 100, "narrow it");
    expect(capped.length).toBeLessThan(160);
    expect(capped).toMatch(/more lines not shown; narrow it\]$/);
  });
});

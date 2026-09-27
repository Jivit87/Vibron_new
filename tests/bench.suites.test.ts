/**
 * Bench port (Pramana bench.py + swebench/*): suites, terminal table, pick,
 * shard, gold env-broken exclusion, report, and a fake-solver `quick` run.
 */

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseBenchArgs } from "@/bench/cli";
import { emptySolveResult } from "@/lib/headless/run";
import { listTasks, runEval } from "@/eval/run";
import { renderTable, resolveSuite } from "@/eval/suites";
import { loadTag, renderSweReport } from "@/eval/swe/report";
import { gradeInstance, shardIds, type SweRow } from "@/eval/swe/run";
import { pickIds, type SweInstance } from "@/eval/swe/specs";

describe("suites", () => {
  const known = ["config-merge", "semver-js", "slugify", "todo-json"];
  it("quick is one python + one js task, mini is everything, --only wins", () => {
    expect(resolveSuite("quick", undefined, known)).toEqual(["slugify", "semver-js"]);
    expect(resolveSuite(undefined, undefined, known)).toEqual(known);
    expect(resolveSuite("quick", ["todo-json"], known)).toEqual(["todo-json"]);
    expect(() => resolveSuite("huge", undefined, known)).toThrow(/unknown suite/);
  });

  it("bundled tasks still include the quick suite", async () => {
    const names = (await listTasks()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["slugify", "semver-js", "config-merge", "todo-json"]));
  });

  it("renders a per-task table with tokens, calls, wall and verified", () => {
    const table = renderTable([
      { task: "slugify", status: "resolved", resolved: true, tokens: 12345, modelCalls: 4, toolCalls: 9, seconds: 31.2 },
      { task: "semver-js", status: "failed", resolved: false, tokens: 800, modelCalls: 1, toolCalls: 2, seconds: 5 },
    ]);
    expect(table).toMatch(/task\s+harness verdict\s+verified\s+tokens\s+calls\s+tools\s+wall/);
    expect(table).toContain("12,345");
    expect(table).toContain("resolved 1/2 · 13,145 tokens · 36s");
  });
});

describe("quick suite end to end (fake solver)", () => {
  it("runs only the quick tasks and grades by hidden tests", async () => {
    const resultsDir = await mkdtemp(path.join(os.tmpdir(), "bench-quick-"));
    const solve = async () => emptySolveResult("failed");
    const lines: string[] = [];
    const summary = await runEval({ suite: "quick", only: ["semver-js"], solve, venv: false, resultsDir, log: (l) => lines.push(l) });
    expect(summary.total).toBe(1);
    expect(summary.resolved).toBe(0); // the bug is unfixed, so hidden tests fail
    expect(lines.join("\n")).toMatch(/verified/);
    const latest = JSON.parse(await readFile(path.join(resultsDir, "latest.json"), "utf8"));
    expect(latest.rows[0].task).toBe("semver-js");
  }, 60_000);
});

describe("swe-bench helpers", () => {
  const rows = [
    ...["a", "b", "c", "d"].map((x) => ({ instance_id: `django__django-${x}`, repo: "django/django" })),
    ...["1", "2"].map((x) => ({ instance_id: `psf__requests-${x}`, repo: "psf/requests" })),
  ];
  it("pick is stratified and seed-reproducible", () => {
    const per = { "django/django": 2, "psf/requests": 1 };
    const a = pickIds(rows, 0, per);
    expect(a).toHaveLength(3);
    expect(a.filter((i) => i.startsWith("django"))).toHaveLength(2);
    expect(pickIds(rows, 0, per)).toEqual(a);
  });

  it("shards split ids k/n", () => {
    expect(shardIds(["a", "b", "c", "d", "e"], "1/2")).toEqual(["b", "d"]);
    expect(shardIds(["a"], undefined)).toEqual(["a"]);
    expect(() => shardIds(["a"], "2/2")).toThrow(/bad shard/);
  });

  it("P2P tests broken under the gold patch do not fail an instance", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bench-grade-"));
    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await writeFile(path.join(dir, "x.txt"), "x\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i"], { cwd: dir });
    const inst: SweInstance = {
      instance_id: "psf__requests-1",
      repo: "psf/requests",
      base_commit: "HEAD",
      version: "2.0",
      problem_statement: "",
      test_patch: "diff --git a/t.py b/t.py\nnew file mode 100644\n--- /dev/null\n+++ b/t.py\n@@ -0,0 +1 @@\n+x = 1\n",
      FAIL_TO_PASS: ["t.py::f"],
      PASS_TO_PASS: ["t.py::ok", "t.py::platform"],
    };
    const exec = async () => ({ exitCode: 1, output: "PASSED t.py::f\nPASSED t.py::ok\nFAILED t.py::platform\n", timedOut: false, durationMs: 1 });
    const strict = await gradeInstance(inst, dir, exec as never);
    const lenient = await gradeInstance(inst, dir, exec as never, "HEAD", ["t.py::platform"]);
    expect(strict.resolved).toBe(false);
    expect(strict.allFailedP2p).toEqual(["t.py::platform"]);
    expect(lenient.resolved).toBe(true);
  });

  it("report compares tags on common instances", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bench-report-"));
    const row = (id: string, resolved: boolean, tokens: number): SweRow => ({
      instance_id: id, resolved, f2p: "1/1", p2p: "0/0", seconds: 60, tokens, cached: 0, calls: 5, costUsd: 0, phaseMs: {}, status: "resolved",
    });
    await writeFile(path.join(dir, "results-v1.jsonl"), [row("i1", true, 40000), row("i2", false, 80000)].map((r) => JSON.stringify(r)).join("\n"));
    await writeFile(path.join(dir, "results-v2-shard0of2.jsonl"), JSON.stringify(row("i1", true, 20000)));
    const out = renderSweReport({ v1: await loadTag(dir, "v1"), v2: await loadTag(dir, "v2") });
    expect(out).toContain("v1: 1/2 resolved (50%), mean tokens 60k");
    expect(out).toContain("on 1 common instances: v1 1/1 (40k tok), v2 1/1 (20k tok)");
  });

  it("parses bench args", () => {
    expect(parseBenchArgs(["swe-run", "ids.txt", "--tag", "v2", "--shard=0/2"])).toEqual({
      command: "swe-run", positional: ["ids.txt"], flags: { tag: "v2", shard: "0/2" },
    });
  });
});

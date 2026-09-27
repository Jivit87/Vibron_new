/**
 * SWE-bench runner, offline: a fake dataset row (read from a rows file), a
 * local git repo standing in for the shallow checkout, a fake solver that
 * edits the code, and a fake test shell. No network, no model, no venv.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCliArgs } from "@/cli/viberon";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import type { ShellRunner } from "@/lib/verify";
import { runSwe, type SweRow } from "@/eval/swe/run";
import { loadInstances, parseDjango, parseSympy, testDirectives, type SweInstance } from "@/eval/swe/specs";

const TEST_PATCH = [
  "diff --git a/tests/test_calc.py b/tests/test_calc.py",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/tests/test_calc.py",
  "@@ -0,0 +1,4 @@",
  "+from calc import add",
  "+",
  "+def test_add():",
  "+    assert add(2, 2) == 4",
  "",
].join("\n");

const ROW = {
  instance_id: "acme__calc-1",
  repo: "acme/calc",
  base_commit: "0000000",
  version: "1.0",
  problem_statement: "add(2, 2) returns 5 instead of 4.",
  test_patch: TEST_PATCH,
  patch: "",
  // SWE-bench stores these as JSON strings.
  FAIL_TO_PASS: JSON.stringify(["tests/test_calc.py::test_add"]),
  PASS_TO_PASS: JSON.stringify(["tests/test_calc.py::test_import"]),
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).toString();

async function prepare(_instance: SweInstance, scratch: string): Promise<string> {
  const dir = path.join(scratch, "repo");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "calc.py"), "def add(a, b):\n    return a + b + 1\n");
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

/** pytest -rA style output that depends on the code actually in the tree. */
const exec: ShellRunner = async (cwd, command) => {
  const code = await readFile(path.join(cwd, "calc.py"), "utf8");
  const hidden = await readFile(path.join(cwd, "tests", "test_calc.py"), "utf8");
  const fixed = code.includes("return a + b\n");
  const output = [
    `$ ${command}`,
    hidden.includes("test_add") ? `${fixed ? "PASSED" : "FAILED"} tests/test_calc.py::test_add` : "",
    "PASSED tests/test_calc.py::test_import",
  ].join("\n");
  return { exitCode: fixed ? 0 : 1, timedOut: false, output, durationMs: 1 };
};

describe("SWE-bench runner", () => {
  it("solves from the problem statement only, grades with the hidden tests, writes rows and cleans up", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-swe-"));
    const dataFile = path.join(root, "rows.json");
    await writeFile(dataFile, JSON.stringify([ROW, { ...ROW, instance_id: "other-2" }]));
    const tasks: string[] = [];
    let agentSawTests = true;
    const solve = async (options: SolveOptions) => {
      tasks.push(options.task);
      const root = options.handle.rootPath!;
      agentSawTests = existsSync(path.join(root, "tests", "test_calc.py"));
      // The agent also "writes" its own copy of the hidden test file: grading must replace it.
      await mkdir(path.join(root, "tests"), { recursive: true });
      await writeFile(path.join(root, "tests", "test_calc.py"), "def test_add():\n    pass\n");
      await writeFile(path.join(root, "calc.py"), "def add(a, b):\n    return a + b\n");
      const result = emptySolveResult("resolved");
      Object.assign(result.metrics, { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 4000, cacheWriteTokens: 0, modelCalls: 3, costUsd: 0.02 });
      return result;
    };
    const workDir = path.join(root, "work");
    const resultsDir = path.join(root, "results");
    const lines: string[] = [];

    const summary = await runSwe({
      ids: ["acme__calc-1", "other-2"],
      limit: 1,
      dataFile,
      workDir,
      resultsDir,
      prepare,
      solve,
      exec,
      log: (line) => lines.push(line),
    });

    expect(summary).toMatchObject({ total: 1, resolved: 1 });
    expect(tasks).toEqual(["add(2, 2) returns 5 instead of 4."]);
    expect(agentSawTests).toBe(false);
    const row = summary.rows[0]!;
    expect(row).toMatchObject<Partial<SweRow>>({
      instance_id: "acme__calc-1",
      resolved: true,
      f2p: "1/1",
      p2p: "1/1",
      tokens: 5050,
      cached: 4000,
      calls: 3,
      costUsd: 0.02,
      status: "resolved",
      phaseMs: {},
    });
    const jsonl = (await readFile(path.join(resultsDir, "results.jsonl"), "utf8")).trim().split("\n");
    expect(JSON.parse(jsonl[0]!)).toMatchObject({ instance_id: "acme__calc-1", resolved: true });
    expect(await readFile(path.join(resultsDir, "results.md"), "utf8")).toMatch(/Resolved \*\*1\/1\*\*[\s\S]*\| acme__calc-1 \| yes \|/);
    // The checkout and env are gone.
    expect(existsSync(path.join(workDir, "acme__calc-1"))).toBe(false);
  });

  it("an unfixed tree fails FAIL_TO_PASS", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-swe-"));
    const summary = await runSwe({
      ids: ["acme__calc-1"],
      instances: [(await loadInstancesFrom(root))[0]!],
      workDir: path.join(root, "work"),
      resultsDir: path.join(root, "results"),
      prepare,
      solve: async () => emptySolveResult("failed"),
      exec,
      log: () => {},
    });
    expect(summary.rows[0]).toMatchObject({ resolved: false, f2p: "0/1", p2p: "1/1", failedF2p: ["tests/test_calc.py::test_add"] });
  });

  it("parses SWE-bench's django and sympy logs and builds test directives", () => {
    expect(
      parseDjango(
        [
          "test_ok (admin.tests.A) ... ok",
          "test_bad (admin.tests.A) ... FAIL",
          "test_doc (admin.tests.A)",
          "Docstring line ... ERROR",
          "test_skip (admin.tests.A) ... skipped 'no db'",
        ].join("\n"),
      ),
    ).toEqual({
      "test_ok (admin.tests.A)": "pass",
      "test_bad (admin.tests.A)": "fail",
      "test_doc (admin.tests.A)": "error",
      "test_skip (admin.tests.A)": "skip",
    });
    expect(parseSympy("test_a ok\ntest_b F\ntest_c E\ntest_d f\n")).toEqual({
      test_a: "pass",
      test_b: "fail",
      test_c: "error",
      test_d: "pass",
    });
    const django = { ...ROW, repo: "django/django", FAIL_TO_PASS: [], PASS_TO_PASS: [] } as SweInstance;
    expect(testDirectives({ ...django, test_patch: "diff --git a/tests/forms_tests/tests.py b/tests/forms_tests/tests.py\n" })).toEqual([
      "forms_tests.tests",
    ]);
  });

  it("downloads the Verified split once, paged, from the datasets server (fake fetch)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "viberon-swe-"));
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)![1]);
      const row = offset === 0 ? ROW : { ...ROW, instance_id: "late-1" };
      return new Response(JSON.stringify({ num_rows_total: 150, rows: [{ row }] }));
    }) as typeof fetch;
    const prev = process.env.PRAMANA_SWE_WORK;
    process.env.PRAMANA_SWE_WORK = path.join(root, "none");
    try {
      const cacheDir = path.join(root, "cache");
      const [a, b] = await loadInstances(["late-1", "acme__calc-1"], { cacheDir, fetchImpl });
      expect([a!.instance_id, b!.FAIL_TO_PASS]).toEqual(["late-1", ["tests/test_calc.py::test_add"]]);
      expect(urls.map((u) => /offset=\d+/.exec(u)![0])).toEqual(["offset=0", "offset=100"]);
      await loadInstances(["late-1"], { cacheDir, fetchImpl });
      expect(urls).toHaveLength(2);
      await expect(loadInstances(["nope"], { cacheDir, fetchImpl })).rejects.toThrow(/nope is not in/);
    } finally {
      if (prev === undefined) delete process.env.PRAMANA_SWE_WORK;
      else process.env.PRAMANA_SWE_WORK = prev;
    }
  });

  it("parses `viberon swe`", () => {
    expect(parseCliArgs(["swe", "--ids", "a,b", "--limit", "1", "--model", "deepseek:deepseek-v4-flash"])).toMatchObject({
      command: "swe",
      ids: ["a", "b"],
      limit: 1,
      model: "deepseek:deepseek-v4-flash",
      gold: false,
    });
    expect(() => parseCliArgs(["swe"])).toThrow(/--ids/);
  });
});

async function loadInstancesFrom(root: string): Promise<SweInstance[]> {
  const file = path.join(root, "rows.jsonl");
  await writeFile(file, `${JSON.stringify(ROW)}\n`);
  return loadInstances(["acme__calc-1"], { dataFile: file, cacheDir: path.join(root, "cache") });
}

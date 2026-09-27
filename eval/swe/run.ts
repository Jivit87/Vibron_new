/**
 * SWE-bench Verified runner, graded by hidden tests (ported from Pramana
 * `bench/swebench/swe_eval.py`, no Docker). Per instance:
 *
 *   1. shallow checkout of `base_commit` (`git fetch --depth 1 <sha>`);
 *   2. a per-instance Python venv (`uv` when installed, else `python<ver> -m venv`),
 *      the spec's packages, then the repo itself, linked as `<repo>/.venv`;
 *   3. `runHeadless` with the problem statement only: the hidden tests are
 *      not in the checkout and never reach the agent;
 *   4. grading: the test patch's files are reset to base, the test patch is
 *      applied, the spec's test command runs on those files, and
 *      resolved = every FAIL_TO_PASS and every PASS_TO_PASS test passes;
 *   5. the checkout and venv are deleted (disk is tight).
 *
 * `--gold` applies the official patch instead of step 3: it validates the
 * environment with no model call. Rows append to `<out>/results.jsonl`;
 * `<out>/results.md` is re-rendered from it (latest row per instance).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { runHeadless } from "@/lib/headless/run";
import { execInRepo, which, type ShellRunner } from "@/lib/verify";
import { loadInstances, specFor, testDirectives, type SweInstance } from "@/eval/swe/specs";

export const SWE_DIR = path.resolve(__dirname);

export interface SweRow {
  instance_id: string;
  resolved: boolean;
  /** Passing / total FAIL_TO_PASS tests after the hidden tests are applied. */
  f2p: string;
  p2p: string;
  seconds: number;
  /** Every token the model processed: input (fresh + cached + cache writes) + output. */
  tokens: number;
  cached: number;
  calls: number;
  costUsd: number;
  phaseMs: Record<string, number>;
  status: string;
  failedF2p?: string[];
  failedP2p?: string[];
  error?: string;
}

export interface RunSweOptions {
  ids: string[];
  model?: string;
  limit?: number;
  maxTurns?: number;
  timeoutMs?: number;
  dataFile?: string;
  resultsDir?: string;
  gold?: boolean;
  log?: (line: string) => void;
  /** Scratch space for checkouts and venvs (default `$VIBERON_SWE_WORK` or the OS temp dir). */
  workDir?: string;
  /** Test seams: dataset rows, checkout + env, the solver, and the grading shell. */
  instances?: SweInstance[];
  /** Checkout + env inside the instance's scratch dir (deleted afterwards); returns the repo dir. */
  prepare?: (instance: SweInstance, scratch: string, log: (line: string) => void) => Promise<string>;
  solve?: (options: SolveOptions) => Promise<SolveResult>;
  exec?: ShellRunner;
}

function run(cmd: string, args: string[], options: { cwd?: string; input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      cmd,
      args,
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs ?? 30 * 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

async function must(cmd: string, args: string[], options: Parameters<typeof run>[2] = {}): Promise<string> {
  const result = await run(cmd, args, options);
  if (result.code !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${result.stderr.slice(-600)}`);
  return result.stdout;
}

/** `git fetch --depth 1` of the base commit into a fresh repo; `.venv` git-excluded. */
export async function shallowCheckout(instance: SweInstance, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await must("git", ["init", "-q"], { cwd: dir });
  await must("git", ["remote", "add", "origin", `https://github.com/${instance.repo}.git`], { cwd: dir });
  let fetched = { code: 1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt < 3 && fetched.code !== 0; attempt += 1) {
    fetched = await run("git", ["fetch", "-q", "--depth", "1", "origin", instance.base_commit], { cwd: dir });
  }
  if (fetched.code !== 0) throw new Error(`git fetch ${instance.base_commit.slice(0, 12)} failed: ${fetched.stderr.slice(-400)}`);
  await must("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: dir });
  await appendFile(path.join(dir, ".git", "info", "exclude"), "\n/.venv\n/.viberon/\n");
}

/** Per-instance venv with the spec's packages, pytest and the repo installed; linked as `<dir>/.venv`. */
export async function buildEnv(instance: SweInstance, dir: string, venv: string, log: (line: string) => void): Promise<void> {
  const spec = specFor(instance);
  const uv = which("uv");
  const pythonBin = path.join(venv, "bin", "python");
  if (uv) {
    await must(uv, ["venv", "-q", "--python", spec.python, venv]);
  } else {
    const python = which(`python${spec.python}`) ?? which("python3");
    if (!python) throw new Error("no python3 on PATH");
    if (!python.endsWith(spec.python)) log(`   python ${spec.python} not found (and no uv); using ${python}`);
    await must(python, ["-m", "venv", venv]);
  }
  const pip = (args: string[], env?: NodeJS.ProcessEnv) =>
    uv ? run(uv, ["pip", "install", "-q", "--python", pythonBin, ...args], { env }) : run(pythonBin, ["-m", "pip", "install", "-q", ...args], { env });
  const packages = [...spec.packages, ...(instance.repo === "pytest-dev/pytest" ? [] : ["pytest"])];
  if (packages.length && (await pip(packages)).code !== 0) log("   some packages failed to install");
  // A shallow checkout has no tags, so setuptools-scm needs the version spelled out.
  const version = instance.version.split(".").length >= 3 ? instance.version : `${instance.version}.0`;
  const installed = await pip(spec.editable ? ["-e", dir] : [dir], { ...process.env, SETUPTOOLS_SCM_PRETEND_VERSION: version });
  if (installed.code !== 0) log(`   install warning: ${installed.stderr.trim().slice(-300)}`);
  await symlink(venv, path.join(dir, ".venv"), "dir");
}

async function prepareDefault(instance: SweInstance, scratch: string, log: (line: string) => void): Promise<string> {
  const repo = path.join(scratch, "repo");
  log("   checkout…");
  await shallowCheckout(instance, repo);
  log("   python env…");
  await buildEnv(instance, repo, path.join(scratch, "venv"), log);
  return repo;
}

export interface SweGrade {
  resolved: boolean;
  f2p: string;
  p2p: string;
  failedF2p: string[];
  failedP2p: string[];
  error?: string;
}

/** Reset the test files to base, apply the hidden test patch, run and score it. */
export async function gradeInstance(
  instance: SweInstance,
  dir: string,
  exec: ShellRunner = execInRepo,
  base = "HEAD",
): Promise<SweGrade> {
  const none = (error: string): SweGrade => ({
    resolved: false,
    f2p: `0/${instance.FAIL_TO_PASS.length}`,
    p2p: `0/${instance.PASS_TO_PASS.length}`,
    failedF2p: instance.FAIL_TO_PASS.slice(0, 5),
    failedP2p: [],
    error,
  });
  const files = [...instance.test_patch.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]!);
  for (const file of files) {
    const reset = await run("git", ["checkout", "-q", base, "--", file], { cwd: dir });
    // New in the test patch: drop any copy the agent wrote.
    if (reset.code !== 0 && existsSync(path.join(dir, file))) await unlink(path.join(dir, file));
  }
  const applied = await run("git", ["apply", "-"], { cwd: dir, input: instance.test_patch });
  if (applied.code !== 0) return none(`test patch failed to apply: ${applied.stderr.slice(-300)}`);
  const spec = specFor(instance);
  const command = [spec.testCmd, ...testDirectives(instance)].join(" ");
  const result = await exec(dir, command, { timeoutMs: 30 * 60_000, env: { PYTHONWARNINGS: "ignore", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" } });
  if (result.timedOut) return none("tests timed out");
  const tests = spec.parse(result.output);
  const ok = (id: string) => tests[id] === "pass";
  const failedF2p = instance.FAIL_TO_PASS.filter((t) => !ok(t));
  const failedP2p = instance.PASS_TO_PASS.filter((t) => !ok(t));
  const count = (all: string[], failed: string[]) => `${all.length - failed.length}/${all.length}`;
  return {
    resolved: failedF2p.length === 0 && failedP2p.length === 0,
    f2p: count(instance.FAIL_TO_PASS, failedF2p),
    p2p: count(instance.PASS_TO_PASS, failedP2p),
    failedF2p: failedF2p.slice(0, 5),
    failedP2p: failedP2p.slice(0, 5),
  };
}

export function renderSweMarkdown(rows: SweRow[]): string {
  const resolved = rows.filter((r) => r.resolved).length;
  const sum = (pick: (r: SweRow) => number) => rows.reduce((n, r) => n + pick(r), 0);
  const lines = [
    "# SWE-bench Verified",
    "",
    `Resolved **${resolved}/${rows.length}**${rows.length ? ` (${Math.round((100 * resolved) / rows.length)}%)` : ""}; ` +
      `${sum((r) => r.tokens).toLocaleString("en-US")} tokens (${sum((r) => r.cached).toLocaleString("en-US")} cached), ` +
      `${sum((r) => r.calls)} calls, $${sum((r) => r.costUsd).toFixed(2)}, ${Math.round(sum((r) => r.seconds))}s.`,
    "",
    "| instance | resolved | status | FAIL_TO_PASS | PASS_TO_PASS | tokens | cached | calls | cost | seconds |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.instance_id} | ${r.resolved ? "yes" : "no"} | ${r.status}${r.error ? ` (${r.error.slice(0, 60).replace(/\|/g, "/")})` : ""} | ${r.f2p} | ${r.p2p} | ` +
        `${r.tokens.toLocaleString("en-US")} | ${r.cached.toLocaleString("en-US")} | ${r.calls} | $${r.costUsd.toFixed(3)} | ${r.seconds.toFixed(0)} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function readRows(file: string): Promise<SweRow[]> {
  if (!existsSync(file)) return [];
  const latest = new Map<string, SweRow>();
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as SweRow;
    latest.set(row.instance_id, row);
  }
  return [...latest.values()];
}

export async function runSwe(options: RunSweOptions): Promise<{ total: number; resolved: number; rows: SweRow[] }> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const resultsDir = path.resolve(options.resultsDir ?? path.join(SWE_DIR, "results"));
  const workDir = options.workDir ?? process.env.VIBERON_SWE_WORK ?? path.join(os.tmpdir(), "viberon-swe");
  const ids = options.limit ? options.ids.slice(0, options.limit) : options.ids;
  const instances =
    options.instances?.filter((i) => ids.includes(i.instance_id)) ??
    (await loadInstances(ids, { dataFile: options.dataFile, cacheDir: path.join(SWE_DIR, "..", ".cache", "swe") }));
  await mkdir(resultsDir, { recursive: true });
  const jsonl = path.join(resultsDir, "results.jsonl");

  const rows: SweRow[] = [];
  for (const instance of instances) {
    log(`── ${instance.instance_id} (${instance.repo} ${instance.version})`);
    const started = Date.now();
    const scratch = path.join(workDir, instance.instance_id);
    let row: SweRow = {
      instance_id: instance.instance_id,
      resolved: false,
      f2p: `0/${instance.FAIL_TO_PASS.length}`,
      p2p: `0/${instance.PASS_TO_PASS.length}`,
      seconds: 0,
      tokens: 0,
      cached: 0,
      calls: 0,
      costUsd: 0,
      phaseMs: {},
      status: "error",
    };
    try {
      await rm(scratch, { recursive: true, force: true });
      await mkdir(scratch, { recursive: true });
      const dir = await (options.prepare ?? prepareDefault)(instance, scratch, log);
      const base = (await must("git", ["rev-parse", "HEAD"], { cwd: dir })).trim();
      if (options.gold) {
        const applied = await run("git", ["apply", "-"], { cwd: dir, input: instance.patch ?? "" });
        if (applied.code !== 0) throw new Error(`gold patch failed to apply: ${applied.stderr.slice(-300)}`);
        row.status = "gold";
      } else {
        // The agent sees the problem statement and nothing else.
        const issue = path.join(scratch, "issue.md");
        await writeFile(issue, instance.problem_statement);
        const outcome = await runHeadless(
          {
            repo: dir,
            taskFile: issue,
            taskId: instance.instance_id,
            out: path.join(resultsDir, "runs", instance.instance_id),
            model: options.model,
            maxTurns: options.maxTurns,
            timeoutMs: options.timeoutMs,
            log: (line) => log(`   ${line}`),
          },
          options.solve ? { solve: options.solve } : {},
        );
        const m = outcome.result.metrics;
        row = {
          ...row,
          status: outcome.result.status,
          tokens: m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens + m.outputTokens,
          cached: m.cacheReadTokens,
          calls: m.modelCalls,
          costUsd: m.costUsd,
          phaseMs: (m as { phaseMs?: Record<string, number> }).phaseMs ?? {},
          ...(outcome.result.error ? { error: outcome.result.error } : {}),
        };
      }
      const grade = await gradeInstance(instance, dir, options.exec, base);
      row = {
        ...row,
        resolved: grade.resolved,
        f2p: grade.f2p,
        p2p: grade.p2p,
        ...(grade.failedF2p.length ? { failedF2p: grade.failedF2p } : {}),
        ...(grade.failedP2p.length ? { failedP2p: grade.failedP2p } : {}),
        ...(grade.error ? { error: grade.error } : {}),
      };
    } catch (error) {
      row.error = error instanceof Error ? error.message : String(error);
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
    rows.push(row);
    await appendFile(jsonl, `${JSON.stringify(row)}\n`);
    log(`   ${row.resolved ? "RESOLVED" : "not resolved"}  f2p ${row.f2p}  p2p ${row.p2p}  (${row.status})${row.error ? `  ${row.error.slice(0, 200)}` : ""}`);
  }

  await writeFile(path.join(resultsDir, "results.md"), renderSweMarkdown(await readRows(jsonl)));
  const resolved = rows.filter((r) => r.resolved).length;
  log(`resolved ${resolved}/${rows.length} → ${path.join(resultsDir, "results.md")}`);
  return { total: rows.length, resolved, rows };
}

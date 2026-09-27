/**
 * Eval runner (ported from Pramana `bench.py`). For each task in
 * eval/tasks/<name>/ (repo/, issue.md, hidden_tests/, task.json):
 *   1. copy repo/ to a temp dir, `git init` + commit (so the diff is clean);
 *      Python tasks get a shared cached venv with pytest symlinked as .venv;
 *   2. run the exact headless path (`runHeadless`) on issue.md;
 *   3. copy hidden_tests/ in and run task.json `test_cmd`; resolved = exit 0.
 * Writes eval/results/latest.json and eval/results/results.md.
 *
 * Run via `viberon eval` (or `pnpm eval`), which sets VIBERON_STORE=memory.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { envModelId, resolveModel } from "@/lib/ai";

import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { runHeadless } from "@/lib/headless/run";
import { execInRepo, which } from "@/lib/verify";
import { excludeFromGit } from "@/lib/workspace/graph-index";
import { renderTable, resolveSuite } from "@/eval/suites";
import { renderMarkdown, summarize, type EvalReport, type EvalRow, type EvalSummary } from "@/eval/score";

export const EVAL_DIR = path.resolve(__dirname);

export interface EvalTaskSpec {
  name: string;
  dir: string;
  title: string;
  language: string;
  category?: string;
  test_cmd: string;
}

export async function listTasks(tasksDir = path.join(EVAL_DIR, "tasks")): Promise<EvalTaskSpec[]> {
  const out: EvalTaskSpec[] = [];
  for (const name of (await readdir(tasksDir)).sort()) {
    const dir = path.join(tasksDir, name);
    if (!existsSync(path.join(dir, "task.json"))) continue;
    const spec = JSON.parse(await readFile(path.join(dir, "task.json"), "utf8")) as Omit<EvalTaskSpec, "name" | "dir">;
    out.push({ ...spec, name, dir });
  }
  return out;
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "viberon-eval",
  GIT_AUTHOR_EMAIL: "eval@localhost",
  GIT_COMMITTER_NAME: "viberon-eval",
  GIT_COMMITTER_EMAIL: "eval@localhost",
};

/** Shared venv with pytest for Python tasks; null when it cannot be built (offline). */
export async function ensureEvalVenv(cacheDir: string, log: (line: string) => void): Promise<string | null> {
  const venv = path.join(cacheDir, "py-venv");
  if (existsSync(path.join(venv, "bin", "python"))) return venv;
  const python = which("python3") ?? which("python");
  if (!python) return null;
  await mkdir(cacheDir, { recursive: true });
  try {
    log("creating eval venv with pytest (one-time)…");
    execFileSync(python, ["-m", "venv", venv], { stdio: "ignore" });
    execFileSync(path.join(venv, "bin", "python"), ["-m", "pip", "install", "-q", "pytest"], {
      stdio: "ignore",
      timeout: 5 * 60_000,
    });
    return venv;
  } catch {
    log("could not install pytest; pytest-based tasks will be graded without it");
    await rm(venv, { recursive: true, force: true });
    return null;
  }
}

export async function prepareTask(spec: EvalTaskSpec, venv: string | null): Promise<string> {
  const work = await mkdtemp(path.join(os.tmpdir(), `viberon-eval-${spec.name}-`));
  const repo = path.join(work, "repo");
  await cp(path.join(spec.dir, "repo"), repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const pattern of ["/.venv", "__pycache__/", ".pytest_cache/", "node_modules/", "/.viberon/"]) {
    await excludeFromGit(repo, pattern);
  }
  execFileSync("git", ["add", "-A"], { cwd: repo, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repo, env: gitEnv });
  if (spec.language === "python" && venv) await symlink(venv, path.join(repo, ".venv"), "dir");
  return repo;
}

export async function gradeTask(spec: EvalTaskSpec, repo: string): Promise<{ resolved: boolean; tail: string }> {
  const hidden = path.join(spec.dir, "hidden_tests");
  if (existsSync(hidden)) await cp(hidden, path.join(repo, "hidden_tests"), { recursive: true });
  const result = await execInRepo(repo, spec.test_cmd, { timeoutMs: 10 * 60_000 });
  return {
    resolved: result.exitCode === 0 && !result.timedOut,
    tail: result.output.trim().split("\n").slice(-15).join("\n"),
  };
}

export interface RunEvalOptions {
  only?: string[];
  /** `quick` (slugify + semver-js) or `mini` (all, the default); `$VIBERON_EVAL_SUITE` when unset. */
  suite?: string;
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** Injected solver (tests); defaults to the real `solveTask`. */
  solve?: (options: SolveOptions) => Promise<SolveResult>;
  tasksDir?: string;
  /** Build/reuse the shared pytest venv for Python tasks (default true). */
  venv?: boolean;
  resultsDir?: string;
}

export async function runEval(options: RunEvalOptions = {}): Promise<EvalSummary> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const resultsDir = options.resultsDir ?? path.join(EVAL_DIR, "results");
  let tasks = await listTasks(options.tasksDir);
  const picked = resolveSuite(options.suite ?? process.env.VIBERON_EVAL_SUITE, options.only, tasks.map((t) => t.name));
  tasks = tasks.filter((t) => picked.includes(t.name));
  if (!tasks.length) throw new Error("no eval tasks found");
  // AI_MODEL is the evaluator's model; resolve it like every other entry point.
  const model = options.model ?? (await resolveModel("auto", { agenticOnly: true }).catch(() => envModelId() ?? "claude-opus-5"));
  const venv = options.venv !== false && tasks.some((t) => t.language === "python")
    ? await ensureEvalVenv(path.join(EVAL_DIR, ".cache"), log)
    : null;

  const rows: EvalRow[] = [];
  for (const spec of tasks) {
    log(`── ${spec.name}: ${spec.title}`);
    const started = Date.now();
    const repo = await prepareTask(spec, venv);
    const outDir = path.join(resultsDir, "runs", spec.name);
    await rm(outDir, { recursive: true, force: true });
    const outcome = await runHeadless(
      {
        repo,
        taskFile: path.join(spec.dir, "issue.md"),
        taskId: spec.name,
        out: outDir,
        model,
        maxTurns: options.maxTurns,
        timeoutMs: options.timeoutMs,
        log: (line) => log(`   ${line}`),
      },
      options.solve ? { solve: options.solve } : {},
    );
    const grade = await gradeTask(spec, repo);
    const r = outcome.result;
    rows.push({
      task: spec.name,
      title: spec.title,
      language: spec.language,
      category: spec.category,
      status: r.status,
      resolved: grade.resolved,
      exitCode: outcome.exitCode,
      regressions: r.gate.newFailures.length,
      tokens: r.metrics.inputTokens + r.metrics.outputTokens,
      modelCalls: r.metrics.modelCalls,
      toolCalls: r.metrics.toolCalls,
      costUsd: r.metrics.costUsd,
      seconds: (Date.now() - started) / 1000,
      gradeTail: grade.tail,
      outDir,
      ...(r.error ? { error: r.error } : {}),
    });
    log(`   hidden tests: ${grade.resolved ? "PASS" : "FAIL"} (harness: ${r.status})`);
    await rm(path.dirname(repo), { recursive: true, force: true });
  }

  const report: EvalReport = { generatedAt: new Date().toISOString(), model, summary: summarize(rows), rows };
  await mkdir(resultsDir, { recursive: true });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path.join(resultsDir, "latest.json"), json);
  // Pramana keeps every run: a timestamped copy so before/after comparisons survive.
  await writeFile(path.join(resultsDir, "runs", `eval-${report.generatedAt.replace(/[:.]/g, "-")}.json`), json);
  log(renderTable(rows));
  await writeFile(path.join(resultsDir, "results.md"), renderMarkdown(report));
  log(`resolved ${report.summary.resolved}/${report.summary.total} → ${path.join(resultsDir, "results.md")}`);
  return report.summary;
}

/**
 * The finish gate: turns the agent's *claims* into *evidence* (ported from
 * Pramana `agent/verify.py`).
 *
 * When the agent calls `finish`, its reproduction command and the existing
 * tests related to the changed files run on the ORIGINAL code (a temporary
 * checkout of the base snapshot) and on the PATCHED work tree, and each
 * check is classified:
 *
 *     fixes          fail -> pass   (the proof we want)
 *     passes_both    pass -> pass   (no regression; not proof of a fix)
 *     regression     pass -> fail   (reject)
 *     still_failing  fail -> fail   (reject: the reproduction still fails)
 *     fails_both     fail -> fail   (a related test that already failed; noted)
 *
 * With no related tests the repository's detected suite is the regression
 * net. `accept_unverified` is reserved for a repository with no runnable
 * check at all; otherwise the gate accepts proof, rejects with the failing
 * output, or gives up (ending the attempt) once its rounds run out.
 */

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { EventSink, VerificationCheckRow } from "@/lib/agents/events";
import type { Graph } from "@/lib/graph";
import { runRunCommand } from "@/lib/harness/workspace-services";
import {
  changedFiles,
  listFiles,
  restore,
  SCRATCH_DIR,
  snapshot,
  withOriginal,
  type ChangedFile,
} from "@/lib/harness/snapshot";
import { syntaxError } from "@/lib/tools/editor";
import * as verify from "@/lib/verify";
import type { TestOutcome, VerificationReport, VerifyCommand } from "@/lib/verify/types";

/* ------------------------------- types ----------------------------------- */

export interface RawRun {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

/** Runs one shell command. Injectable for tests. */
export type CheckRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string> },
) => Promise<RawRun>;

/** The `lib/verify` functions the harness uses; injectable so tests do not depend on them. */
export interface VerifyServices {
  detectVerifyCommands: typeof verify.detectVerifyCommands;
  runVerification: typeof verify.runVerification;
  relatedTestFiles: typeof verify.relatedTestFiles;
  extractFailures: typeof verify.extractFailures;
}

export function verifyServices(overrides: Partial<VerifyServices> = {}): VerifyServices {
  return {
    detectVerifyCommands: verify.detectVerifyCommands,
    runVerification: verify.runVerification,
    relatedTestFiles: verify.relatedTestFiles,
    extractFailures: verify.extractFailures,
    ...overrides,
  };
}

export interface Outcome {
  exitCode: number | null;
  passed: boolean;
  timedOut: boolean;
  durationMs: number;
  output: string;
  tail: string;
  summary: string;
  tests: Record<string, TestOutcome>;
  counts: { passed: number; failed: number };
}

export type CheckOrigin = "agent" | "suite" | "related-tests";

export type Verdict =
  | "fixes"
  | "passes_both"
  | "regression"
  | "still_failing"
  | "fails_both"
  | "timeout"
  | "no_tests"
  | "passes_after"
  | "fails_after"
  | "error";

export interface Check {
  command: string;
  origin: CheckOrigin;
  before: Outcome | null;
  after: Outcome | null;
  verdict: Verdict;
  newFailures: string[];
  fixed: string[];
}

export type Strength = "strong" | "weak" | "none";
export type GateDecision = "accept" | "reject" | "accept_unverified" | "give_up";

export interface GateResult {
  /** The gate has ruled for good (accept, accept_unverified or give_up): the attempt ends. */
  done: boolean;
  decision: GateDecision;
  strength: Strength;
  score: number;
  feedback: string;
  checks: Check[];
  syntaxErrors: string[];
  changed: ChangedFile[];
  round: number;
  newFailures: string[];
  fixed: string[];
  shadowStubs: string[];
  summary: string;
  /** Snapshot tree of the verified state. */
  tree: string | null;
  rolledBack: boolean;
}

export interface FinishInput {
  summary: string;
  reproduction?: string;
}

export interface GateOptions {
  root: string;
  /** Snapshot of the original code. */
  baseRef: string;
  /** Detected repository checks (tests first, then typecheck/compile). */
  suite: VerifyCommand[];
  graph: Graph | null;
  timeoutMs: number;
  emit: EventSink;
  agentId: string;
  signal?: AbortSignal;
  runId?: string;
  repoKey?: string;
  runner?: CheckRunner;
  services?: Partial<VerifyServices>;
  /** Rulings before the gate gives up (Pramana: 3). */
  maxRounds?: number;
}

/* ------------------------------ helpers ---------------------------------- */

const PYTEST_SUMMARY_RE = /=+ (.*(?:passed|failed|error|skipped|no tests ran).*) =+\s*$/gm;

export function summarizeOutput(out: string, code: number | null, timedOut: boolean): string {
  if (timedOut) return "timed out";
  const pytest = [...out.matchAll(PYTEST_SUMMARY_RE)].at(-1);
  if (pytest) return pytest[1].trim().slice(0, 160);
  const unit = out.match(/Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK.*|FAILED.*)/);
  if (unit) return `${unit[1]} tests: ${unit[2].trim()}`.slice(0, 160);
  const node = out.match(/# pass (\d+)[\s\S]*?# fail (\d+)/);
  if (node) return `${node[1]} passed, ${node[2]} failed`;
  const lines = out
    .trim()
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("$ ") && !/^\[(exit code|exited with code)/.test(l));
  const tail = lines.at(-1)?.trim() ?? "";
  return `exit ${code ?? "?"}${tail ? `: ${tail.slice(0, 120)}` : ""}`;
}

export function isTestPath(p: string): boolean {
  const low = p.toLowerCase();
  return (
    /(^|\/)(tests?|testing|spec|__tests__)(\/|$)/.test(low) ||
    /(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+)$/.test(low)
  );
}

function tailOf(output: string, lines = 40): string {
  return output.trimEnd().split("\n").slice(-lines).join("\n");
}

/**
 * The agent's command with the work tree's absolute path replaced by `.`.
 * Models often write `cd /abs/repo && python repro.py`; run in the temporary
 * checkout of the original code, that `cd` would jump back into the PATCHED
 * tree, and "original vs patched" would compare the patch with itself.
 */
export function rootRelative(command: string, root: string): string {
  const roots = new Set([root.replace(/\/+$/, "")]);
  try {
    roots.add(realpathSync(root).replace(/\/+$/, ""));
  } catch {
    // Missing root: nothing to resolve.
  }
  let out = command;
  for (const r of [...roots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) {
    const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}(?=[/\\s'";&|)]|$)`, "g"), ".");
  }
  return out;
}

/** Python resolves the package from the directory under test, not from an editable install. */
function pythonPath(dir: string): Record<string, string> {
  const src = path.join(dir, "src");
  const entries = [dir, ...(existsSync(src) ? [src] : []), ...(process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [])];
  return { PYTHONPATH: entries.join(path.delimiter) };
}

/** Default runner: the terminal service, attributed to the run. */
function terminalRunner(repoKey: string, runId?: string): CheckRunner {
  return async (command, { cwd, timeoutMs, signal, env }) => {
    const started = Date.now();
    const result = await runRunCommand({
      repoKey,
      command,
      cwd,
      timeoutMs,
      signal,
      runId,
      env: { PYTHONDONTWRITEBYTECODE: "1", CI: "1", ...env },
      maxOutputChars: 200_000,
    });
    return {
      exitCode: result.exitCode,
      output: result.output,
      timedOut: /\[timed out after/.test(result.output) && !signal?.aborted,
      durationMs: Date.now() - started,
    };
  };
}

const FRAMEWORK_TEMPLATES: Partial<Record<VerifyCommand["framework"], string>> = {
  pytest: "python -m pytest -q -rA {files}",
  unittest: "python -m pytest -q -rA {files}",
  vitest: "npx vitest run {files}",
  jest: "npx jest {files}",
  "node-test": "node --test {files}",
};

/** Added files that create a top-level Python module the repo imports but never defined. */
async function shadowedDependencies(root: string, added: string[], files: string[]): Promise<{ path: string; why: string }[]> {
  const out: { path: string; why: string }[] = [];
  for (const file of added) {
    const parts = file.split("/");
    let mod: string | null = null;
    if (parts.length === 1 && file.endsWith(".py")) mod = file.slice(0, -3);
    else if (parts.length === 2 && parts[1] === "__init__.py") mod = parts[0];
    else if (parts.length === 3 && parts[0] === "src" && parts[2] === "__init__.py") mod = parts[1];
    if (!mod || !/^[A-Za-z_]\w*$/.test(mod) || ["conftest", "setup", "tests", "test"].includes(mod)) continue;
    if (files.some((f) => f === `${mod}.py` || f.startsWith(`${mod}/`) || f.startsWith(`src/${mod}/`))) continue;
    const rx = new RegExp(`^\\s*(?:from\\s+${mod}[\\s.]|import\\s+${mod}\\b)`, "m");
    for (const f of files) {
      if (!f.endsWith(".py") || f === file) continue;
      const text = await readText(path.join(root, f));
      if (text && rx.test(text.slice(0, 200_000))) {
        out.push({ path: file, why: `\`${mod}\` is imported by ${f} but is not part of this repository` });
        break;
      }
    }
  }
  return out;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  fixes: "PROVES FIX",
  passes_both: "ok (no regression)",
  regression: "REGRESSION",
  still_failing: "STILL FAILING",
  fails_both: "fails before+after (pre-existing)",
  timeout: "TIMEOUT",
  no_tests: "no tests collected",
  passes_after: "passes",
  fails_after: "FAILS",
  error: "error",
};

/** Gate verdicts → the UI's row verdicts (`verification.checks[].verdict`). */
const ROW_VERDICT: Record<Verdict, VerificationCheckRow["verdict"]> = {
  fixes: "fixes",
  regression: "regression",
  fails_both: "pre_existing",
  still_failing: "still_failing",
  fails_after: "still_failing",
  timeout: "still_failing",
  error: "still_failing",
  no_tests: "still_failing",
  passes_both: "pass",
  passes_after: "pass",
};

export function renderChecks(checks: Check[]): string {
  if (!checks.length) return "(no checks ran)";
  const rows = ["| verdict | origin | command | original code | with patch |", "|---|---|---|---|---|"];
  for (const c of checks) {
    rows.push(
      `| ${VERDICT_LABEL[c.verdict]} | ${c.origin} | \`${c.command.slice(0, 90)}\` | ${(c.before?.summary ?? "-").slice(0, 60)} | ${(c.after?.summary ?? "-").slice(0, 60)} |`,
    );
  }
  return rows.join("\n");
}

function diffTests(
  before: Record<string, TestOutcome>,
  after: Record<string, TestOutcome>,
): { newFailures: string[]; fixed: string[] } {
  const bad = (o: TestOutcome | undefined) => o === "fail" || o === "error";
  const newFailures: string[] = [];
  const fixed: string[] = [];
  for (const [id, outcome] of Object.entries(after)) {
    if (bad(outcome) && before[id] === "pass") newFailures.push(id);
    if (outcome === "pass" && bad(before[id])) fixed.push(id);
  }
  return { newFailures: newFailures.sort(), fixed: fixed.sort() };
}

export function classifyCheck(check: Check): Verdict {
  const a = check.after;
  const b = check.before;
  let verdict: Verdict;
  if (!a) verdict = "error";
  else if (a.timedOut) verdict = "timeout";
  else if (!b) verdict = a.passed ? "passes_after" : "fails_after";
  else {
    const diff = diffTests(b.tests, a.tests);
    check.newFailures = diff.newFailures;
    check.fixed = diff.fixed;
    if (diff.newFailures.length) verdict = "regression";
    else if (!b.passed && a.passed) verdict = "fixes";
    else if (b.passed && a.passed) verdict = "passes_both";
    else if (b.passed && !a.passed) verdict = b.timedOut ? "fails_after" : "regression";
    else if (diff.fixed.length) verdict = "fixes";
    else verdict = check.origin === "agent" ? "still_failing" : "fails_both";
  }
  if (a && a.exitCode === 5 && /pytest/.test(check.command)) verdict = "no_tests";
  check.verdict = verdict;
  if (verdict === "regression" && !check.newFailures.length) check.newFailures = [check.command];
  if (verdict === "fixes" && !check.fixed.length) check.fixed = [check.command];
  return verdict;
}

/** The agent's most recent reproduction-like command (Pramana `_guess_verification_cmds`). */
export function guessReproduction(commands: string[]): string | undefined {
  for (let i = commands.length - 1; i >= 0; i -= 1) {
    const cmd = commands[i];
    if (
      (cmd.includes(SCRATCH_DIR) || /pytest|runtests|\btest\b|vitest|jest|node --test/.test(cmd)) &&
      cmd.length < 300 &&
      !/pip install|npm (i|install)|pnpm (i|install)/.test(cmd)
    ) {
      return cmd;
    }
  }
  return undefined;
}

/* -------------------------------- gate ----------------------------------- */

const RANK: Record<Strength, number> = { strong: 2, weak: 1, none: 0 };

export class Gate {
  rounds = 0;
  rejections = 0;
  verifyRuns = 0;
  verifyMs = 0;
  rollbacks = 0;
  best: GateResult | null = null;
  last: GateResult | null = null;
  private askedForProof = false;
  private warnedTests = false;
  private warnedShadow = false;
  private consecutiveRegressions = 0;
  private baselineCache = new Map<string, Promise<Outcome>>();
  private baseFilesCache: Promise<string[]> | null = null;
  private readonly runner: CheckRunner;
  private readonly services: VerifyServices;
  private readonly maxRounds: number;

  constructor(private readonly options: GateOptions) {
    this.runner = options.runner ?? terminalRunner(options.repoKey ?? "", options.runId);
    this.services = verifyServices(options.services);
    this.maxRounds = options.maxRounds ?? 3;
  }

  /** The first detected test command, if any. */
  get testCommand(): VerifyCommand | null {
    return this.options.suite.find((c) => c.kind === "test") ?? this.options.suite[0] ?? null;
  }

  excerpt(output: string, exitCode: number | null, max = 4000): string {
    try {
      const text = this.services.extractFailures(output, max);
      if (text.trim()) return text.slice(0, max);
    } catch {
      // No extractor: fall back to the tail.
    }
    return exitCode === 0 ? "" : tailOf(output, 60).slice(-max);
  }

  private async runOnce(command: string, cwd: string, suite?: VerifyCommand, timeoutMs = this.options.timeoutMs): Promise<Outcome> {
    const started = Date.now();
    let report: VerificationReport | null = null;
    if (suite && !this.options.runner) {
      report = await this.services
        .runVerification(cwd, suite, { timeoutMs, signal: this.options.signal, runId: this.options.runId })
        .catch(() => null);
    }
    const raw: RawRun = report
      ? {
          exitCode: report.exitCode,
          output: `${report.failureExcerpt}\n${report.outputTail}`,
          timedOut: report.timedOut,
          durationMs: report.durationMs,
        }
      : await this.runner(command, { cwd, timeoutMs, signal: this.options.signal, env: pythonPath(cwd) });
    this.verifyRuns += 1;
    this.verifyMs += Date.now() - started;
    const passed = raw.exitCode === 0 && !raw.timedOut;
    return {
      exitCode: raw.exitCode,
      passed,
      timedOut: raw.timedOut,
      durationMs: raw.durationMs,
      output: raw.output,
      tail: tailOf(raw.output),
      summary: report
        ? `${report.counts.passed} passed, ${report.counts.failed + report.counts.errors} failed`
        : summarizeOutput(raw.output, raw.exitCode, raw.timedOut),
      tests: report?.parsed ? report.tests : {},
      counts: report
        ? { passed: report.counts.passed, failed: report.counts.failed + report.counts.errors }
        : { passed: passed ? 1 : 0, failed: passed ? 0 : 1 },
    };
  }

  private onOriginal<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    return withOriginal(this.options.root, this.options.baseRef, fn);
  }

  /**
   * Record the suite on the original code. It runs in a temporary checkout,
   * so it can proceed in the background while the agent edits.
   */
  startBaseline(): Promise<void> {
    const suite = this.options.suite;
    if (!suite.length) return Promise.resolve();
    const run = this.onOriginal(async (dir) => {
      for (const cmd of suite) {
        const outcome = this.runOnce(cmd.command, dir, cmd);
        this.baselineCache.set(cmd.command, outcome);
        const o = await outcome;
        this.options.emit({
          type: "verification",
          agentId: this.options.agentId,
          phase: "baseline",
          command: cmd.command,
          exitCode: o.exitCode,
          timedOut: o.timedOut,
          passed: o.counts.passed,
          failed: o.counts.failed,
          newFailures: [],
          fixed: [],
          durationMs: o.durationMs,
          excerpt: this.excerpt(o.output, o.exitCode),
        });
      }
    });
    return run;
  }

  /** Targeted runs of the existing tests related to the changed files. */
  private async relatedCommands(changed: string[]): Promise<string[]> {
    const test = this.testCommand;
    const template = test?.targetTemplate ?? (test ? FRAMEWORK_TEMPLATES[test.framework] : undefined);
    if (!template?.includes("{files}") || !changed.length) return [];
    const files = await this.services.relatedTestFiles(this.options.root, changed, this.options.graph).catch(() => []);
    const picks = files.filter((f) => !changed.includes(f)).slice(0, 4);
    return picks.length ? [template.replace("{files}", picks.join(" "))] : [];
  }

  /** The `compare` tool: one command on the original code and on the current code. */
  async compare(raw: string, timeoutMs: number): Promise<string> {
    const { root, baseRef } = this.options;
    const command = rootRelative(raw, root);
    const run = (cwd: string) => this.runner(command, { cwd, timeoutMs, signal: this.options.signal, env: pythonPath(cwd) });
    const fmt = (r: RawRun) => summarizeOutput(r.output, r.exitCode, r.timedOut);
    if (!(await changedFiles(root, baseRef)).length) {
      const mine = await run(root);
      return `(You have not changed anything yet, so both states are identical.)\n${fmt(mine)}\n${tailOf(mine.output, 30)}`;
    }
    // Both sides at once: the original runs in its own temporary checkout.
    const [mine, orig] = await Promise.all([run(root), this.onOriginal(run).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))]);
    if (orig instanceof Error) {
      return `Error: could not run on the original code (${orig.message}).\n${tailOf(mine.output, 30)}`;
    }
    const ok = (r: RawRun) => r.exitCode === 0 && !r.timedOut;
    const [o, m] = [ok(orig), ok(mine)];
    const verdict =
      !o && m
        ? "fixes: fails on the original code, passes with your change."
        : o && !m
          ? "regression: passes on the original code but FAILS with your change. Your change caused this."
          : o && m
            ? "passes: passes on both (your change does not affect this result)."
            : "pre_existing: fails on BOTH, so this failure existed before your change. If it is unrelated to the task, ignore it; do not fix pre-existing failures.";
    let body = `ORIGINAL code: ${fmt(orig)}\nYOUR code:     ${fmt(mine)}\nVerdict: ${verdict}\n\nOutput with your code (tail):\n${tailOf(mine.output, 30)}`;
    if (o !== m || !o) body += `\n\nOutput with the original code (tail):\n${tailOf(orig.output, 15)}`;
    return body;
  }

  /** Execute a blind regression script on both trees without changing the gate ruling. */
  async compareIndependent(command: string): Promise<{
    beforePassed: boolean;
    afterPassed: boolean;
    beforeOutput: string;
    afterOutput: string;
  }> {
    const [after, before] = await Promise.all([
      this.runOnce(command, this.options.root),
      this.onOriginal((dir) => this.runOnce(command, dir)),
    ]);
    return {
      beforePassed: before.passed,
      afterPassed: after.passed,
      beforeOutput: before.output,
      afterOutput: after.output,
    };
  }

  /**
   * Rule on the current change. `dry` computes evidence without spending a
   * round or changing gate state (the harness checkpoint); `final` forces a
   * ruling.
   */
  async verify(input: FinishInput, mode: { final?: boolean; dry?: boolean } = {}): Promise<GateResult> {
    const { root, baseRef } = this.options;
    const dry = mode.dry === true;
    if (!dry) this.rounds += 1;
    const lastRound = mode.final === true || this.rounds >= this.maxRounds;
    const changed = await changedFiles(root, baseRef);
    const result: GateResult = {
      done: false,
      decision: "reject",
      strength: "none",
      score: 0,
      feedback: "",
      checks: [],
      syntaxErrors: [],
      changed,
      round: this.rounds,
      newFailures: [],
      fixed: [],
      shadowStubs: [],
      summary: input.summary,
      tree: null,
      rolledBack: false,
    };

    if (!changed.length) {
      result.feedback =
        "REJECTED: the repository has no changes. Make the source edit that fixes the issue, verify it, then call finish again.";
      if (lastRound && !dry) Object.assign(result, { done: true, decision: "give_up" });
      if (!dry) this.last = result;
      return result;
    }
    result.tree = await snapshot(root);

    for (const change of changed) {
      if (change.status === "D") continue;
      const text = await readText(path.join(root, change.path));
      if (text === null) continue;
      const err = await syntaxError(change.path, text.replace(/^﻿/, ""));
      if (err) result.syntaxErrors.push(`${change.path}: ${err}`);
    }

    // Checks: the reproduction, then the related existing tests (or the suite as the regression net).
    const checks: Check[] = [];
    const add = (command: string, origin: CheckOrigin) => {
      const c = command.trim();
      if (c && !checks.some((x) => x.command === c)) {
        checks.push({ command: c, origin, before: null, after: null, verdict: "error", newFailures: [], fixed: [] });
      }
    };
    if (input.reproduction) add(rootRelative(input.reproduction, root), "agent");
    const related = await this.relatedCommands(changed.filter((c) => c.status !== "D").map((c) => c.path));
    for (const c of related) add(c, "related-tests");
    if (!related.length) for (const s of this.options.suite) add(s.command, "suite");
    const suiteByCommand = new Map(this.options.suite.map((s) => [s.command.trim(), s]));

    // The two sides run concurrently: the patched side in the work tree, the
    // original side in its own temporary checkout, so they share no files.
    // Each side stays sequential (one side's checks can share caches).
    const patched = (async () => {
      for (const check of checks) check.after = await this.runOnce(check.command, root, suiteByCommand.get(check.command));
    })();
    const original = (async () => {
      try {
        const needBaseline = checks.filter((c) => !this.baselineCache.has(c.command) || c.origin === "agent");
        if (needBaseline.length) {
          await this.onOriginal(async (dir) => {
            for (const check of needBaseline) {
              const outcome = this.runOnce(check.command, dir, suiteByCommand.get(check.command));
              // Existing tests on the original code never change: cache them.
              if (check.origin !== "agent") this.baselineCache.set(check.command, outcome);
              check.before = await outcome;
            }
          });
        }
        for (const check of checks) check.before ??= (await this.baselineCache.get(check.command)) ?? null;
      } catch (error) {
        result.feedback += `(could not run the checks on the original code: ${error instanceof Error ? error.message : String(error)})\n`;
      }
    })();
    await Promise.all([patched, original]);
    for (const check of checks) classifyCheck(check);
    result.checks = checks;

    const fixes = checks.filter((c) => c.verdict === "fixes");
    const regressions = checks.filter((c) => c.verdict === "regression");
    const failingOwn = checks.filter(
      (c) => c.origin === "agent" && ["still_failing", "fails_after", "timeout", "no_tests"].includes(c.verdict),
    );
    result.newFailures = [...new Set(regressions.flatMap((c) => c.newFailures))];
    result.fixed = [...new Set(fixes.flatMap((c) => c.fixed))];
    result.score =
      3 * fixes.length +
      0.5 * checks.filter((c) => c.verdict === "passes_both").length -
      6 * regressions.length -
      3 * failingOwn.length -
      5 * result.syntaxErrors.length;
    const clean = !regressions.length && !failingOwn.length && !result.syntaxErrors.length;
    result.strength = fixes.length && clean ? "strong" : clean ? "weak" : "none";

    const problems: string[] = [];
    if (result.syntaxErrors.length) problems.push(`Syntax errors in changed files:\n${result.syntaxErrors.join("\n")}`);
    for (const c of regressions) {
      const which = c.newFailures[0] !== c.command ? ` (newly failing: ${c.newFailures.slice(0, 8).join(", ")})` : "";
      problems.push(
        `REGRESSION - \`${c.command}\` passed on the original code but FAILS with your change${which}:\n${this.excerpt(c.after?.output ?? "", c.after?.exitCode ?? 1, 2500)}`,
      );
    }
    for (const c of failingOwn) {
      problems.push(
        `your reproduction \`${c.command}\` still fails after your change (${c.after?.summary ?? "?"}):\n${this.excerpt(c.after?.output ?? "", c.after?.exitCode ?? 1, 2000)}`,
      );
    }

    const added = changed.filter((c) => c.status === "A").map((c) => c.path);
    const shadows = added.length ? await shadowedDependencies(root, added, await this.baseFiles()) : [];
    result.shadowStubs = shadows.map((s) => s.path);
    if (shadows.length && !this.warnedShadow && !lastRound && !dry) {
      this.warnedShadow = true;
      problems.push(
        `Your patch adds a stand-in for a third-party dependency: ${shadows.map((s) => `${s.path} (${s.why})`).join("; ")}. A stub like this is not part of the fix and can mask failures. Delete it and install the real package, or run a narrower test that does not need it.`,
      );
    }
    const editedTests = changed.filter((c) => c.status === "M" && isTestPath(c.path)).map((c) => c.path);
    if (editedTests.length && !this.warnedTests && !lastRound && !dry) {
      this.warnedTests = true;
      problems.push(
        `Your patch modifies existing test files: ${editedTests.slice(0, 5).join(", ")}. Tests encode the expected behaviour; changing them to make them pass hides bugs. Revert those edits unless the task explicitly asks for a test change, and fix the source code instead.`,
      );
    }

    const table = renderChecks(checks);
    if (dry) {
      result.feedback = table;
      result.decision = result.strength === "strong" ? "accept" : "reject";
      return result;
    }

    if (problems.length && !lastRound) {
      result.feedback += `REJECTED - the evidence does not support the fix yet.\n\n${table}\n\n${problems.join("\n\n")}\n\nFix these problems, then call finish again.`;
      await this.afterReject(result, regressions.length > 0);
      this.last = result;
      return result;
    }
    if (checks.length && !fixes.length && !problems.length && !this.askedForProof && !lastRound) {
      this.askedForProof = true;
      result.feedback += `NOT YET - no check fails on the original code, so nothing proves that your change fixes the issue.\n\n${table}\n\nWrite a reproduction in ${SCRATCH_DIR}/ that exits non-zero on the original code because of this issue (assert the expected behaviour) and passes with your change, run it, then call finish again with it as \`reproduction\`. If the issue truly cannot be reproduced by a script, explain why in the summary and call finish again.`;
      await this.afterReject(result, false);
      this.last = result;
      return result;
    }

    result.done = true;
    if (result.strength === "strong") {
      result.decision = "accept";
      result.feedback += `VERIFIED.\n\n${table}`;
    } else if (!checks.length && !problems.length) {
      result.decision = "accept_unverified";
      result.feedback += "ACCEPTED UNVERIFIED: this repository has no runnable checks and no reproduction was given.";
    } else {
      result.decision = "give_up";
      result.feedback += `NOT VERIFIED: the gate stops here without proof.\n\n${table}`;
      if (problems.length) result.feedback += `\n\nUnresolved:\n${problems.map((p) => p.slice(0, 1500)).join("\n\n")}`;
    }
    if (checks.some((c) => c.verdict === "fails_both")) {
      result.feedback += "\n\nNote: some related tests also fail on the original code (pre-existing failures).";
    }
    this.consecutiveRegressions = 0;
    this.last = result;
    return result;
  }

  private baseFiles(): Promise<string[]> {
    this.baseFilesCache ??= listFiles(this.options.root, this.options.baseRef);
    return this.baseFilesCache;
  }

  private async afterReject(result: GateResult, regression: boolean): Promise<void> {
    this.rejections += 1;
    this.consecutiveRegressions = regression ? this.consecutiveRegressions + 1 : 0;
    if (this.consecutiveRegressions < 2) return;
    // Two regressions in a row: roll back to the best state seen (or the original).
    this.consecutiveRegressions = 0;
    const target = this.best && this.best.strength !== "none" ? this.best.tree : null;
    try {
      await restore(this.options.root, target ?? this.options.baseRef);
      this.rollbacks += 1;
      result.rolledBack = true;
      result.feedback += target
        ? "\n\n[harness] Two regressions in a row: your changes were rolled back to your best earlier state. Re-read the failing test before editing again."
        : "\n\n[harness] Two regressions in a row: your changes were rolled back to the original code. Re-read the failing test and take a different approach.";
      this.options.emit({
        type: "recovery",
        agentId: this.options.agentId,
        failureClass: "regression",
        action: "rollback",
        detail: target ? "Rolled back to the best checkpoint after two regressions." : "Rolled back to the original code after two regressions.",
        checkpointId: target ?? this.options.baseRef,
      });
    } catch {
      // Rollback is best effort; the rejection feedback still stands.
    }
  }

  /** Start a fresh attempt: per-attempt state resets, cached baselines stay. */
  resetAttempt(): void {
    this.rounds = 0;
    this.askedForProof = false;
    this.warnedTests = false;
    this.warnedShadow = false;
    this.consecutiveRegressions = 0;
    this.best = null;
    this.last = null;
  }

  /** Suite baseline outcome for a command (null until it has run). */
  async baselineFor(command: string): Promise<Outcome | null> {
    return (await this.baselineCache.get(command)?.catch(() => null)) ?? null;
  }

  /** Emit the `verification` event for a ruling and, in the gate phase, the `gate` decision. */
  emitResult(result: GateResult, phase: "gate" | "final" = "gate"): void {
    const ran = result.checks.filter((c) => c.after);
    if (ran.length) {
      // The headline is the repo's tests when they ran, else the first check; `checks` carries every row.
      const primary = ran.find((c) => c.origin !== "agent") ?? ran[0];
      const after = primary.after!;
      const failing = ran.find((c) => c.after && !c.after.passed);
      this.options.emit({
        type: "verification",
        agentId: this.options.agentId,
        phase,
        command: primary.command,
        exitCode: after.exitCode,
        timedOut: after.timedOut,
        passed: ran.reduce((n, c) => n + (c.after?.counts.passed ?? 0), 0),
        failed: ran.reduce((n, c) => n + (c.after?.counts.failed ?? 0), 0),
        newFailures: result.newFailures,
        fixed: result.fixed,
        durationMs: ran.reduce((n, c) => n + (c.after?.durationMs ?? 0), 0),
        excerpt: failing?.after ? this.excerpt(failing.after.output, failing.after.exitCode) : "",
        checks: ran.map((c) => ({
          name: c.command,
          verdict: ROW_VERDICT[c.verdict],
          before: c.before?.summary,
          after: c.after?.summary,
          ...(c.after && !c.after.passed ? { excerpt: this.excerpt(c.after.output, c.after.exitCode, 1500) } : {}),
        })),
      });
    }
    if (phase === "gate") {
      this.options.emit({
        type: "gate",
        agentId: this.options.agentId,
        decision: result.decision,
        reason: result.feedback.split("\n")[0].slice(0, 300),
        attempt: result.round,
      });
    }
  }

  /** Track the best verified state; returns true when this result became the best. */
  async trackBest(result: GateResult): Promise<boolean> {
    if (!result.changed.length) return false;
    const better =
      !this.best ||
      RANK[result.strength] > RANK[this.best.strength] ||
      (RANK[result.strength] === RANK[this.best.strength] && result.score > this.best.score);
    if (!better) return false;
    result.tree ??= await snapshot(this.options.root);
    this.best = result;
    this.options.emit({
      type: "checkpoint",
      id: randomUUID(),
      label: `Best so far (${result.strength} evidence)`,
      fileCount: result.changed.length,
      kind: "best",
      ref: result.tree,
    });
    return true;
  }
}

export function strengthRank(s: Strength): number {
  return RANK[s];
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

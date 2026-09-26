/**
 * Headless run: task + repo in, verified change + evidence bundle out.
 *
 *   <out>/result.json       SolveResult + {schemaVersion, taskId, exitCode, repo, model, task}
 *   <out>/trajectory.jsonl  {type:"meta"} line, {type:"event"} per event, {type:"result"} line
 *   <out>/patch.diff        the change (git apply-able)
 *   <out>/report.md         human-readable evidence (Pramana style)
 *
 * Exit codes: 0 resolved|unverified, 1 failed|incomplete, 2 error.
 * `solve` is injectable so the CLI, eval runner and tests share this path.
 */

import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { DeliverOptions, DeliverResult, reportOnIssue } from "@/lib/deliver";
import { fetchGitHubIssue, parseGitHubIssueUrl } from "@/lib/github";
import type { SolveOptions, SolveResult, SolveStatus } from "@/lib/harness/solve-types";
import { renderReport } from "@/lib/headless/report";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { recordFixNote } from "@/lib/memory/graph";
import { detectVerifyCommands } from "@/lib/verify";
import type { VerifyCommand } from "@/lib/verify/types";
import { openWorkspace } from "@/lib/workspace";
import { resolveGithubToken } from "@/lib/workspace/clone";
import { excludeFromGit } from "@/lib/workspace/graph-index";

export const RESULT_SCHEMA_VERSION = 1;

export interface HeadlessOptions {
  repo: string;
  task?: string;
  taskFile?: string;
  taskId?: string;
  /** Run in a detached `git worktree` of HEAD; the original checkout is untouched. */
  worktree?: boolean;
  keepWorktree?: boolean;
  out?: string;
  testCmd?: string;
  noGate?: boolean;
  maxTurns?: number;
  /** Wall-clock budget for the whole solve, ms. */
  timeoutMs?: number;
  verifyTimeoutMs?: number;
  model?: string;
  signal?: AbortSignal;
  /** Progress lines (stderr in the CLI). */
  log?: (line: string) => void;
  /** Final `reviewDiff` pass on an accepted fix (off by default). */
  review?: boolean;
  reviewModel?: string;
  /** Run a blind independent issue test after the verification gate accepts. */
  independentTest?: boolean;
  /** Deliver a resolved fix: branch, commit, push, draft PR. Never changes the exit code. */
  deliver?: boolean;
  /** Issue to comment on after delivery (default: the task, when it is an issue URL). */
  issueUrl?: string;
}

export interface HeadlessDeps {
  solve?: (options: SolveOptions) => Promise<SolveResult>;
  fetchIssue?: (url: string) => ReturnType<typeof fetchGitHubIssue>;
  /** Test seam: replaces `deliver` (e.g. a local bare remote and a fake fetch). */
  deliver?: (options: DeliverOptions) => Promise<DeliverResult>;
  reportOnIssue?: typeof reportOnIssue;
}

export type HeadlessDelivery =
  | (DeliverResult & { commentUrl?: string; commentError?: string })
  | { error: string };

export type HeadlessResultJson = SolveResult & {
  schemaVersion: number;
  taskId: string;
  exitCode: number;
  repo: string;
  workRoot: string;
  model: string;
  task: string;
  verifyCommands: VerifyCommand[];
  startedAt: string;
  delivery?: HeadlessDelivery;
};

export interface HeadlessOutcome {
  exitCode: number;
  outDir: string;
  result: HeadlessResultJson;
}

export function exitCodeFor(status: SolveStatus): 0 | 1 | 2 {
  if (status === "resolved" || status === "unverified") return 0;
  if (status === "failed" || status === "incomplete") return 1;
  return 2;
}

export function emptySolveResult(status: SolveStatus, error?: string): SolveResult {
  return {
    status,
    summary: "",
    diff: "",
    filesChanged: [],
    gate: {
      enabled: false,
      command: null,
      baseline: null,
      final: null,
      newFailures: [],
      fixed: [],
      rejections: 0,
      ranAfterLastEdit: false,
      reason: "",
    },
    recovery: { checkpoints: 0, rollbacks: 0, restoredBest: false, stuckEvents: 0, failureClasses: {} },
    metrics: {
      modelCalls: 0,
      toolCalls: 0,
      toolCallsByName: {},
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRate: 0,
      costUsd: 0,
      uncachedCostUsd: 0,
      contextSentTokens: 0,
      contextSavedTokens: 0,
      compactions: 0,
      verifyRuns: 0,
      verifyMs: 0,
      durationMs: 0,
    },
    ...(error ? { error } : {}),
  };
}

function newTaskId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `run-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Task text from --task / --task-file; a GitHub issue URL is fetched. */
export async function resolveTask(
  options: Pick<HeadlessOptions, "task" | "taskFile">,
  fetchIssue: (url: string) => ReturnType<typeof fetchGitHubIssue> = async (url) =>
    fetchGitHubIssue(url, fetch, await resolveGithubToken()),
): Promise<string> {
  let task = options.task?.trim() ?? "";
  if (!task && options.taskFile) task = (await readFile(options.taskFile, "utf8")).trim();
  if (!task) throw new Error("A task is required (--task or --task-file).");
  if (parseGitHubIssueUrl(task)) {
    const issue = await fetchIssue(task);
    task = `${issue.title}\n\n${issue.body}\n\n(Issue: ${issue.url})`;
  }
  return task;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}

async function createWorktree(repo: string, taskId: string): Promise<string> {
  try {
    git(repo, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new Error("--worktree needs a git repository with at least one commit.");
  }
  const base = await mkdtemp(path.join(os.tmpdir(), "viberon-wt-"));
  const dir = path.join(base, taskId);
  git(repo, ["worktree", "add", "--detach", dir, "HEAD"]);
  return dir;
}

function issueFromTask(task: string | undefined): string | undefined {
  return task && parseGitHubIssueUrl(task.trim()) ? task.trim() : undefined;
}

/** Deliver a resolved run (and report on the issue); failures are returned, never thrown. */
async function deliverResult(
  options: Pick<HeadlessOptions, "issueUrl">,
  root: string,
  task: string,
  result: SolveResult,
  deps: HeadlessDeps,
): Promise<HeadlessDelivery> {
  if (result.status !== "resolved") {
    return { error: `the run ended ${result.status}; only a verified (resolved) fix is delivered` };
  }
  const lib = await import("@/lib/deliver");
  const evidence = lib.evidenceFromResult(result);
  let delivered: DeliverResult;
  try {
    delivered = await (deps.deliver ?? lib.deliver)({
      root,
      title: lib.titleFromTask(task),
      body: lib.renderPrBody({ summary: result.summary, evidence, issueUrl: options.issueUrl }),
      expectedFiles: result.filesChanged,
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!options.issueUrl) return delivered;
  try {
    const { commentUrl } = await (deps.reportOnIssue ?? lib.reportOnIssue)({
      issueUrl: options.issueUrl,
      prUrl: delivered.prUrl,
      summary: result.summary,
      evidence,
    });
    return { ...delivered, commentUrl };
  } catch (error) {
    return { ...delivered, commentError: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The best configured agentic model (an NVIDIA-only or Groq-only setup must
 * not default to Claude). With no key at all, keep the documented default so
 * the run reports the missing credential clearly.
 */
async function defaultModel(): Promise<string> {
  try {
    const { resolveModel } = await import("@/lib/ai");
    return await resolveModel("auto", { agenticOnly: true });
  } catch {
    return "claude-opus-5";
  }
}

export async function runHeadless(options: HeadlessOptions, deps: HeadlessDeps = {}): Promise<HeadlessOutcome> {
  process.env.VIBERON_STORE ??= "memory";
  const log = options.log ?? (() => {});
  const startedAt = new Date();
  const taskId = options.taskId ?? newTaskId();
  const repo = path.resolve(options.repo);
  const model = options.model ?? process.env.VIBERON_MODEL ?? (await defaultModel());
  const outDir = path.resolve(options.out ?? path.join(repo, ".viberon", "runs", taskId));
  await mkdir(outDir, { recursive: true });
  if (outDir.startsWith(path.join(repo, ".viberon"))) await excludeFromGit(repo, "/.viberon/").catch(() => false);

  const trajectory = createWriteStream(path.join(outDir, "trajectory.jsonl"));
  const writeLine = (value: unknown) => trajectory.write(`${JSON.stringify(value)}\n`);

  let task = "";
  let workRoot = repo;
  let verifyCommands: VerifyCommand[] = [];
  let result: SolveResult;
  let eventCount = 0;

  try {
    if (!existsSync(repo) || !statSync(repo).isDirectory()) throw new Error(`Repository not found: ${repo}`);
    task = await resolveTask(options, deps.fetchIssue);
    if (options.worktree) {
      workRoot = await createWorktree(repo, taskId);
      log(`worktree: ${workRoot}`);
    }

    log("indexing workspace…");
    const meta = await registerLocalWorkspace(workRoot);
    const handle = await openWorkspace(meta.repoKey);

    if (options.testCmd) {
      verifyCommands = [
        { command: options.testCmd, framework: "custom", kind: "test", source: "--test-cmd" },
      ];
    } else if (!options.noGate) {
      verifyCommands = await detectVerifyCommands(workRoot);
    }
    log(
      verifyCommands.length
        ? `verify: ${verifyCommands.map((c) => (c.command.includes("\n") ? `${c.kind} (${c.source})` : c.command)).join("; ")}`
        : "verify: no checks detected",
    );

    writeLine({
      type: "meta",
      schemaVersion: RESULT_SCHEMA_VERSION,
      taskId,
      repo,
      workRoot,
      model,
      startedAt: startedAt.toISOString(),
      task,
      verifyCommands,
      options: {
        worktree: Boolean(options.worktree),
        noGate: Boolean(options.noGate),
        maxTurns: options.maxTurns ?? 40,
        timeoutMs: options.timeoutMs ?? null,
      },
    });

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
    const solve = deps.solve ?? (await import("@/lib/harness/solve")).solveTask;
    try {
      result = await solve({
        handle,
        task,
        model,
        runId: taskId,
        signal: controller.signal,
        emit: (event: OrchestrationEvent) => {
          eventCount += 1;
          writeLine({ type: "event", t: Date.now(), event });
        },
        budget: {
          maxTurns: options.maxTurns ?? 40,
          ...(options.timeoutMs ? { maxWallMs: options.timeoutMs } : {}),
        },
        verify: {
          enabled: !options.noGate,
          commands: verifyCommands,
          timeoutMs: options.verifyTimeoutMs ?? 10 * 60_000,
          baseline: !options.noGate,
        },
        useRepoRules: false,
        ...(options.review ? { review: true, ...(options.reviewModel ? { reviewModel: options.reviewModel } : {}) } : {}),
        ...(options.independentTest ? { independentTest: true } : {}),
      });
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`error: ${message}`);
    result = emptySolveResult("error", message);
    result.metrics.durationMs = Date.now() - startedAt.getTime();
  }

  // Delivery happens before the worktree is removed; its branch lives on in the repo.
  let delivery: HeadlessDelivery | undefined;
  if (options.deliver) {
    delivery = await deliverResult({ ...options, issueUrl: options.issueUrl ?? issueFromTask(options.task) }, workRoot, task, result, deps);
    log("error" in delivery ? `not delivered: ${delivery.error}` : `delivered: ${delivery.prUrl} (branch ${delivery.branch})`);
  }

  const exitCode = exitCodeFor(result.status);
  const json: HeadlessResultJson = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    taskId,
    exitCode,
    repo,
    workRoot,
    model,
    task,
    verifyCommands,
    startedAt: startedAt.toISOString(),
    ...result,
    ...(delivery ? { delivery } : {}),
  };
  writeLine({ type: "result", t: Date.now(), events: eventCount, result: json });
  await new Promise<void>((resolve) => trajectory.end(resolve));

  await Promise.all([
    writeFile(path.join(outDir, "result.json"), `${JSON.stringify(json, null, 2)}\n`),
    writeFile(path.join(outDir, "patch.diff"), result.diff),
    writeFile(
      path.join(outDir, "report.md"),
      renderReport({ taskId, task, repo, model, result, verifyCommands, exitCode }),
    ),
  ]);

  // Run memory: the next task on the same area sees what was fixed and why.
  if (result.status !== "error" && result.filesChanged.length) {
    try {
      recordFixNote(options.worktree ? repo : workRoot, {
        issue: task,
        files: result.filesChanged,
        rootCause: result.summary,
        verified: result.status === "resolved",
      });
    } catch {
      // Memory is best-effort; never fail a run over it.
    }
  }

  if (options.worktree && workRoot !== repo && !options.keepWorktree) {
    try {
      git(repo, ["worktree", "remove", "--force", workRoot]);
    } catch {
      log(`could not remove worktree ${workRoot}`);
    }
  }

  return { exitCode, outDir, result: json };
}

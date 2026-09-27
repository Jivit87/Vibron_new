/**
 * What a queued task does. `fix`: solve → (deliver when resolved and asked)
 * → (report on the issue); a fix for a GitHub issue runs in a fresh worktree
 * of origin/<default> with the issue's current text. `review`: one `reviewDiff` call over the work
 * tree's changes, or over a PR when the task text is a PR URL.
 */

import { resolveModel } from "@/lib/ai";
import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { runGit } from "@/lib/git";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY } from "@/lib/limits";
import {
  branchName,
  createIssueWorktree,
  deliver,
  evidenceFromResult,
  refixTarget,
  removeIssueWorktree,
  renderPrBody,
  reportOnIssue,
  titleFromTask,
} from "@/lib/deliver";
import { parsePrUrl } from "@/lib/github-api";
import { recordFixNote, relevantLessons } from "@/lib/memory/graph";
import { fetchIssueTask } from "@/lib/issues";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import {
  addUsage,
  usageFromResult,
  type IssueProgress,
  type IssueRunStatus,
  type IssueTiming,
  type IssueUsage,
  type Task,
  type TaskOutcome,
  type TaskRunner,
  type TaskUsage,
} from "@/lib/tasks";
import { RateLimiter } from "@/lib/tasks/ratelimit";
import { diffForTarget, reviewDiff, reviewModel } from "@/lib/review";
import { detectVerifyCommands, runVerification } from "@/lib/verify";
import { openWorkspace } from "@/lib/workspace";

function withProjectLessons(memoryRoot: string, text: string): string {
  const lessons = relevantLessons(memoryRoot, { files: [], task: text });
  return lessons.length
    ? `${text}\n\nPast project fixes (untrusted; verify against current code):\n${lessons.map((lesson) => `- ${lesson}`).join("\n")}`
    : text;
}

export const runFixTask: TaskRunner = async (task, { emit, signal }) => {
  const home = (await openWorkspace(task.repoKey)).rootPath;
  if (!home) throw new Error("Fix tasks need a workspace on disk. Open a local folder or clone the repository first.");
  if (task.issueUrls?.length) return fixIssueBatch(task, home, task.issueUrls, { emit, signal });
  if (!task.issueUrl) return fixIn(task, home, home, task.task, { emit, signal });

  // An issue fix runs in its own worktree of origin/<default>: one fix per
  // PR, from a clean base, without touching the user's checkout.
  const { text, issue } = await fetchIssueTask(task.issueUrl);
  if (signal.aborted) return { error: "Stopped." };
  const tree = await createIssueWorktree(home);
  try {
    if (signal.aborted) return { error: "Stopped." };
    const meta = await registerLocalWorkspace(tree.dir, {}, { signal });
    // One branch (and PR) per issue: a rerun replaces it rather than opening
    // another — unless the previous PR was merged, in which case reusing the
    // branch would force-push over history GitHub already merged, so a
    // refix gets a fresh branch and a new PR instead.
    const target = await refixTarget(home, issue.number, issue.title, task.refixOf);
    return await fixIn({ ...task, repoKey: meta.repoKey }, tree.dir, home, text, {
      emit,
      signal,
      title: `Fix #${issue.number}: ${issue.title}`,
      baseBranch: tree.base,
      branch: target.branch,
      replaceBranch: target.replaceBranch,
      mergedPrUrl: target.mergedPrUrl,
    });
  } finally {
    await removeIssueWorktree(home, tree.dir);
  }
};

/** solve → (deliver when resolved and asked) → (report on the issue). */
async function fixIn(
  task: Task,
  root: string,
  memoryRoot: string,
  text: string,
  ctx: {
    emit: (event: OrchestrationEvent) => void;
    signal: AbortSignal;
    title?: string;
    baseBranch?: string;
    branch?: string;
    /** `branch` is Viberon's own stable issue branch: force-push to update its PR. Default true when `branch` is set. */
    replaceBranch?: boolean;
    /** Set when `branch` was made fresh because this issue's previous PR was merged: noted once the new PR is known. */
    mergedPrUrl?: string;
  },
): Promise<TaskOutcome> {
  const handle = await openWorkspace(task.repoKey);
  const { solveTask } = await import("@/lib/harness/solve");
  const model = await resolveModel(task.model ?? "auto", { agenticOnly: true });
  const commands = await detectVerifyCommands(root).catch(() => []);
  const result = await solveTask({
    handle,
    task: memoryRoot === root ? text : withProjectLessons(memoryRoot, text),
    model,
    emit: ctx.emit,
    signal: ctx.signal,
    runId: task.id,
    budget: { maxTurns: SINGLE_MAX_TURNS, maxTokens: TASK_TOKEN_BUDGET },
    verify: { enabled: true, commands, timeoutMs: 300_000, baseline: true },
    useRepoRules: true,
    onSolved: (solved) => {
      if (!solved.filesChanged.length) return;
      recordFixNote(memoryRoot, {
        issue: ctx.title ?? task.task,
        files: solved.filesChanged,
        rootCause: solved.summary,
        verified: solved.status === "resolved",
      });
    },
  });
  // Stopped: nothing leaves the machine after the user said stop, even when
  // the solve finished its last step before noticing.
  if (ctx.signal.aborted) return { result, error: "Stopped." };
  if (result.status !== "resolved" && result.status !== "unverified") {
    return { result, error: result.error ?? `The fix ended ${result.status}: ${result.gate.reason || result.summary}`.slice(0, 500) };
  }
  if (!task.deliver) return { result };
  if (result.status !== "resolved") {
    return { result, note: "Not delivered: no check proved the change. Review it and deliver by hand." };
  }

  const evidence = evidenceFromResult(result);
  const outcome: TaskOutcome = { result };
  try {
    const pr = await deliver({
      root,
      title: ctx.title ?? titleFromTask(task.task),
      body: renderPrBody({ summary: result.summary, evidence, issueUrl: task.issueUrl }),
      expectedFiles: result.filesChanged,
      ...(ctx.baseBranch ? { baseBranch: ctx.baseBranch } : {}),
      ...(ctx.branch ? { branch: ctx.branch, replaceBranch: ctx.replaceBranch ?? true } : {}),
    });
    outcome.prUrl = pr.prUrl;
    if (ctx.mergedPrUrl) outcome.note = `Previous PR ${ctx.mergedPrUrl} was merged; opened new PR ${pr.prUrl}.`;
  } catch (error) {
    return { result, error: `Delivery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (task.issueUrl && !ctx.signal.aborted) {
    await reportOnIssue({ issueUrl: task.issueUrl, prUrl: outcome.prUrl!, summary: result.summary, evidence }).catch(
      (error: unknown) => {
        outcome.note = `The PR is open, but commenting on the issue failed: ${error instanceof Error ? error.message : String(error)}`;
      },
    );
  }
  return outcome;
}

interface BatchItem {
  url: string;
  number: number;
  title: string;
  state: "pending" | "running" | "resolved" | "failed" | "cancelled";
  detail?: string;
  /** The proven fix, committed on a detached HEAD (kept alive by a ref). */
  commit?: string;
  files?: string[];
  phase?: string;
  startedAt?: number;
  finishedAt?: number;
  timing: IssueTiming;
  usage: IssueUsage;
  /** Tokens this issue has spent (input + output), for the batch budget. */
  spent: number;
  /** Its token cap while it runs; unspent cap stays reserved for it. */
  cap: number;
  unproven?: boolean;
  fastPath?: boolean;
}

/**
 * Token ceiling for one task (a single fix, or a whole batch), counted like
 * the solver's own budget: input + output tokens (cache reads are cheap and
 * do not count). Small repos
 * should be fixed well inside it; an issue that cannot be proven within its
 * share stops instead of looping. `VIBERON_TASK_TOKEN_BUDGET` overrides it.
 */
export const TASK_TOKEN_BUDGET = Math.max(10_000, Number(process.env.VIBERON_TASK_TOKEN_BUDGET) || 100_000);
/** Agent turns for one solve: the fast path needs 1–2, a real fix rarely more than a dozen. */
const SINGLE_MAX_TURNS = 15;
const BATCH_MAX_TURNS = 12;
/** A batch issue is not started with less than this much budget left. */
const MIN_ISSUE_BUDGET = 8_000;

/** Tokens a `turn_usage` event spends against a budget (same count as the solver's). */
function turnTokens(event: OrchestrationEvent): number {
  if (event.type !== "turn_usage") return 0;
  return event.inputTokens + event.outputTokens;
}

/** Issues solved at once; each in its own worktree. */
const BATCH_CONCURRENCY = Math.max(
  MIN_CONCURRENCY,
  Math.min(MAX_CONCURRENCY, Number(process.env.VIBERON_ISSUE_CONCURRENCY) || DEFAULT_CONCURRENCY),
);

/**
 * Many GitHub issues → one pull request. The issues are solved in parallel,
 * each in its own worktree of the project's default branch; a proven fix is
 * committed there. The commits are then cherry-picked, in issue order, onto
 * one branch, the suite runs once on the result, and the branch is delivered
 * as one PR that closes the fixed issues. Progress is a `todos` checklist.
 */
async function fixIssueBatch(
  task: Task,
  home: string,
  urls: string[],
  ctx: { emit: (event: OrchestrationEvent) => void; signal: AbortSignal },
): Promise<TaskOutcome> {
  const startedAt = Date.now();
  const model = await resolveModel(task.model ?? "auto", { agenticOnly: true });
  const items: BatchItem[] = urls.map((url, index) => ({
    url,
    number: Number(/\/issues\/(\d+)/.exec(url)?.[1] ?? 0),
    title: task.issueTitles?.[index] ?? "Issue",
    state: "pending",
    timing: { modelMs: 0, toolsMs: 0, proofMs: 0 },
    usage: { input: 0, output: 0, cached: 0, calls: 0 },
    spent: 0,
    cap: 0,
  }));
  const status = (i: BatchItem): IssueRunStatus =>
    i.state === "resolved"
      ? "verified"
      : i.state === "running"
        ? "running"
        : i.state === "cancelled"
          ? "cancelled"
          : i.state === "failed"
            ? i.unproven ? "unproven" : "failed"
            : "queued";
  const progressItems = (): IssueProgress[] =>
    items.map((i) => ({
      url: i.url,
      number: i.number,
      title: i.title,
      status: status(i),
      ...(i.phase ? { phase: i.phase } : {}),
      ...(i.startedAt ? { startedAt: i.startedAt } : {}),
      ...(i.finishedAt ? { finishedAt: i.finishedAt } : {}),
      timing: { ...i.timing },
      usage: { ...i.usage },
      ...(i.fastPath !== undefined ? { fastPath: i.fastPath } : {}),
      ...(i.detail ? { detail: i.detail } : {}),
    }));
  const progress = () => ctx.emit({ type: "issue_progress", items: progressItems() } as unknown as OrchestrationEvent);
  const issueSteps = items.map((item) => ({
    id: `issue-${item.number}`,
    title: `Fix #${item.number}: ${item.title}`,
    role: "solver" as const,
    detail: `Read issue #${item.number} and its discussion. Use the symbol graph and project memory to locate the cause, implement the smallest complete fix, and prove it with the repository tests.`,
    files: [],
    dependsOn: [],
  }));
  const plan: RunPlan = {
    summary: task.instructions || `Fix ${items.length} open GitHub issues, then open one pull request for the proven fixes.`,
    steps: [
      ...issueSteps,
      {
        id: "deliver",
        title: "Combine fixes, verify, and open a pull request",
        role: "devops",
        detail: "Combine proven fixes on one branch, run the repository test suite, and open a draft pull request that closes the fixed issues.",
        files: [],
        dependsOn: issueSteps.map((step) => step.id),
      },
    ],
    waves: [issueSteps.map((step) => step.id), ["deliver"]],
  };
  const mark = (i: BatchItem) => (i.state === "resolved" ? "✓" : i.state === "failed" ? "✗" : "");
  const checklist = () => {
    progress();
    emitTodos();
  };
  const emitTodos = () =>
    ctx.emit({
      type: "todos",
      agentId: "issues",
      items: items.map((i) => ({
        id: String(i.number),
        content: `${mark(i)} #${i.number} ${i.title}${i.detail && i.state !== "cancelled" ? ` (${i.detail})` : ""}`.trim(),
        status:
          i.state === "resolved"
            ? "completed"
            : i.state === "running"
              ? "in_progress"
              : i.state === "cancelled"
                ? "cancelled"
                : "pending",
      })),
    });
  // Stop: every issue not yet fixed is cancelled at once (running solves
  // unwind in the background), so no row keeps spinning while they do.
  const cancelOpen = () => {
    let changed = false;
    for (const i of items) {
      if (i.state !== "pending" && i.state !== "running") continue;
      Object.assign(i, { state: "cancelled", detail: "cancelled" });
      changed = true;
    }
    if (changed) checklist();
  };
  ctx.signal.addEventListener("abort", cancelOpen, { once: true });
  const say = (text: string) => ctx.emit({ type: "agent_text", agentId: "issues", text: `${text}\n` });
  ctx.emit({ type: "run_start", runId: task.id, mode: "single", model, at: startedAt });
  ctx.emit({ type: "plan", plan, awaitingApproval: false });
  checklist();
  say(`Solving ${items.length} issues with ${model}, ${BATCH_CONCURRENCY} at a time, within ${Math.round(TASK_TOKEN_BUDGET / 1000)}k tokens.`);
  const limiter = new RateLimiter(BATCH_CONCURRENCY);
  let batchSpent = 0;

  // A setup problem (no usable model, no credentials) fails every issue the
  // same way: stop at the first one instead of burning through the rest.
  let fatal: string | null = null;
  let batchUsage: TaskUsage | undefined;
  const { solveTask } = await import("@/lib/harness/solve");
  let firstTree: ReturnType<typeof createIssueWorktree> | null = null;
  const issueTree = async () => {
    if (!firstTree) return await (firstTree = createIssueWorktree(home));
    return createIssueWorktree(home, { baseBranch: (await firstTree).base });
  };

  async function solveOne(item: BatchItem): Promise<void> {
    if (fatal || ctx.signal.aborted) return;
    // The batch shares one token budget: each issue gets an even share of
    // what is left, and none starts once too little remains.
    // Running issues keep what is left of their own caps reserved.
    const reserved = items
      .filter((i) => i.state === "running")
      .reduce((sum, i) => sum + Math.max(0, i.cap - i.spent), 0);
    const left = TASK_TOKEN_BUDGET - batchSpent - reserved;
    const waiting = items.filter((i) => i.state === "pending").length || 1;
    const share = Math.floor(left / waiting);
    if (share < MIN_ISSUE_BUDGET) {
      Object.assign(item, { state: "failed", unproven: true, detail: `skipped: token budget (${Math.round(TASK_TOKEN_BUDGET / 1000)}k) used up`, finishedAt: Date.now() });
      checklist();
      return;
    }
    item.state = "running";
    item.cap = share;
    item.startedAt = Date.now();
    item.phase = "reading issue";
    checklist();
    const began = Date.now();
    const toolStarts = new Map<string, number>();
    let lastProgress = 0;
    const stopped = () => {
      if (ctx.signal.aborted) throw new Error("cancelled");
    };
    try {
      const { text, issue } = await fetchIssueTask(item.url);
      stopped();
      item.title = issue.title;
      if (issue.state !== "open") throw new Error("issue is closed");
      item.phase = "indexing";
      checklist();
      const tree = await issueTree();
      try {
        stopped();
        // The signal also stops the worktree's scan and index midway.
        const handle = await openWorkspace((await registerLocalWorkspace(tree.dir, {}, { signal: ctx.signal })).repoKey);
        stopped();
        item.phase = "solving";
        progress();
        const result = await solveTask({
          handle,
          task: withProjectLessons(home, task.instructions
            ? `The user's request for this run: ${task.instructions}\n\nWork on this issue within that request.\n\n${text}`
            : text),
          model,
          // Parallel solves would interleave in one trace: the checklist and
          // one line per issue are the batch's view. Only token use goes
          // through, so the task shows what the whole batch costs.
          emit: (event) => {
            if (event.type === "turn_usage") {
              const spent = turnTokens(event);
              item.spent += spent;
              batchSpent += spent;
              item.usage.input += event.inputTokens;
              item.usage.output += event.outputTokens;
              item.usage.cached += event.cacheReadTokens;
              item.usage.calls += 1;
              ctx.emit(event);
            } else if (event.type === "agent_tool") {
              const key = event.callId ?? `${event.agentId}:${event.tool}`;
              if (event.phase === "start") toolStarts.set(key, Date.now());
              else {
                const at = toolStarts.get(key);
                if (at) item.timing.toolsMs += Date.now() - at;
                toolStarts.delete(key);
              }
            } else if (event.type === "verification") {
              item.timing.proofMs += event.durationMs;
              item.phase = "verifying";
            } else if (event.type === "agent_retry") {
              limiter.reportRateLimited();
            }
            // Model time is what is left of the wall clock once tools and proof are counted.
            item.timing.modelMs = Math.max(0, Date.now() - began - item.timing.toolsMs - item.timing.proofMs);
            if (Date.now() - lastProgress > 1_000) {
              lastProgress = Date.now();
              progress();
            }
          },
          signal: ctx.signal,
          runId: `${task.id}-${item.number}`,
          budget: { maxTurns: BATCH_MAX_TURNS, maxTokens: share, maxWallMs: 8 * 60_000 },
          verify: { enabled: true, commands: await detectVerifyCommands(tree.dir).catch(() => []), timeoutMs: 180_000, baseline: true },
          useRepoRules: true,
        });
        batchUsage = addUsage(batchUsage, usageFromResult(result));
        const fp = (result.metrics as { fastPath?: { used?: boolean; accepted?: boolean } }).fastPath;
        if (fp?.used) item.fastPath = Boolean(fp.accepted);
        stopped();
        if (result.status === "error" || (result.metrics.modelCalls === 0 && result.error)) {
          fatal = result.error ?? "the solver could not start";
          throw new Error(fatal);
        }
        if (result.status !== "resolved" || !result.filesChanged.length) {
          item.unproven = true;
          throw new Error(`no proof (${result.status}${result.gate.reason ? `: ${result.gate.reason.slice(0, 80)}` : ""})`);
        }
        await runGit(tree.dir, ["add", "-A", "--", ...result.filesChanged]);
        await runGit(tree.dir, ["commit", "-q", "-m", `Fix #${item.number}: ${issue.title}\n\n${result.summary.slice(0, 2000)}\n\nFixes #${item.number}`]);
        item.commit = (await runGit(tree.dir, ["rev-parse", "HEAD"])).stdout.trim();
        // The worktree goes away; a ref keeps the commit until it is picked.
        await runGit(home, ["update-ref", `refs/viberon/batch/${task.id}/${item.number}`, item.commit]);
        item.files = result.filesChanged;
        item.state = "resolved";
        limiter.reportSuccess();
        recordFixNote(home, { issue: `#${item.number} ${issue.title}`, files: result.filesChanged, rootCause: result.summary, verified: true });
        say(`✓ #${item.number} fixed in ${Math.round((Date.now() - began) / 1000)}s: ${result.filesChanged.join(", ")}`);
      } finally {
        await removeIssueWorktree(home, tree.dir);
      }
    } catch (error) {
      if (ctx.signal.aborted) {
        Object.assign(item, { state: "cancelled", detail: "cancelled" });
      } else {
        item.state = "failed";
        item.detail = (error instanceof Error ? error.message : String(error)).slice(0, 160);
        say(`✗ #${item.number} not fixed: ${item.detail}`);
      }
    }
    item.finishedAt = Date.now();
    item.phase = undefined;
    item.timing.modelMs = Math.max(0, item.finishedAt - began - item.timing.toolsMs - item.timing.proofMs);
    checklist();
  }

  // Issues run in parallel under one shared limiter (slots + a backoff every
  // start shares after a 429 burst); Stop rejects every queued start at once.
  await Promise.all(items.map((item) => limiter.run(() => solveOne(item), ctx.signal).catch(() => undefined)));
  ctx.signal.removeEventListener("abort", cancelOpen);
  if (ctx.signal.aborted) {
    cancelOpen();
    say("Stopped.");
  }
  if (fatal) {
    for (const i of items) if (i.state === "pending") Object.assign(i, { state: "failed", detail: "skipped" });
    checklist();
  }

  const outcome: TaskOutcome = {};
  let branch = "";
  let combinedSuitePassed = false;
  const fixed = () => items.filter((i) => i.state === "resolved");
  if (fatal) {
    outcome.error = `Stopped: ${fatal}`;
  } else if (ctx.signal.aborted) {
    outcome.error = "Cancelled before the pull request was opened.";
  } else if (!fixed().length) {
    outcome.error = "No issue could be fixed with proof, so no pull request was opened.";
  } else {
    // Combine the proven fixes on one branch, in issue order.
    const tree = await issueTree();
    try {
      const taken = (await runGit(tree.dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split("\n");
      branch = branchName(`Fix issues ${fixed().map((i) => `#${i.number}`).join(" ")}`, taken);
      await runGit(tree.dir, ["switch", "-c", branch]);
      for (const item of fixed()) {
        const pick = await runGit(tree.dir, ["cherry-pick", item.commit!], { allowFailure: true });
        if (pick.code !== 0) {
          await runGit(tree.dir, ["cherry-pick", "--abort"], { allowFailure: true });
          Object.assign(item, { state: "failed", detail: "its fix conflicts with another issue's fix" });
          say(`✗ #${item.number} left out: its fix conflicts with another issue's fix`);
        }
      }
      checklist();
      // Each fix was proven alone; prove they also hold together.
      const suite = (await detectVerifyCommands(tree.dir).catch(() => [])).find((c) => c.kind === "test");
      if (suite && fixed().length > 1) {
        say(`Running ${suite.command} on the combined fixes…`);
        const report = await runVerification(tree.dir, suite, { timeoutMs: 300_000, signal: ctx.signal });
        if (report.exitCode !== 0) outcome.error = `The combined fixes fail the test suite (${report.counts.failed} failing), so no pull request was opened. Branch: ${branch}.`;
        else combinedSuitePassed = true;
      }
      if (!outcome.error && ctx.signal.aborted) {
        outcome.error = "Cancelled before the pull request was opened.";
      } else if (!outcome.error && !task.deliver) {
        outcome.note = `Fixed ${fixed().length}/${items.length} on local branch ${branch}; not delivered.`;
      } else if (!outcome.error) {
        say("Opening the pull request…");
        const open = items.filter((i) => i.state !== "resolved");
        const body = [
          `Fixes ${fixed().length} of ${items.length} GitHub issues, one commit each. Each included fix passed its harness checks.${combinedSuitePassed ? " The combined test suite also passed." : ""}`,
          "",
          ...fixed().map((i) => `- Fixes #${i.number}: ${i.title} (${(i.files ?? []).join(", ")})`),
          ...(open.length ? ["", "Not fixed in this PR:", ...open.map((i) => `- #${i.number} ${i.title}${i.detail ? ` (${i.detail})` : ""}`)] : []),
          "",
          "Delivered by Viberon.",
        ].join("\n");
        try {
          const pr = await deliver({
            root: tree.dir,
            title: `Fix ${fixed().length} issue${fixed().length === 1 ? "" : "s"}: ${fixed().map((i) => `#${i.number}`).join(", ")}`,
            body,
            baseBranch: tree.base,
          });
          outcome.prUrl = pr.prUrl;
        } catch (error) {
          outcome.error = `Fixed ${fixed().length} issue(s) on branch ${branch}, but delivery failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } finally {
      await removeIssueWorktree(home, tree.dir);
    }
  }
  for (const item of items) {
    if (item.commit) await runGit(home, ["update-ref", "-d", `refs/viberon/batch/${task.id}/${item.number}`], { allowFailure: true });
  }

  const summary = [
    outcome.prUrl ? `Opened ${outcome.prUrl} fixing ${fixed().length}/${items.length} issues.` : (outcome.error ?? outcome.note ?? ""),
    "",
    ...items.map((i) => `${i.state === "resolved" ? "✓" : "✗"} #${i.number} ${i.title}${i.detail ? ` (${i.detail})` : ""}`),
  ].join("\n");
  ctx.emit({
    type: "run_done",
    status: ctx.signal.aborted ? "cancelled" : outcome.error ? "failed" : "done",
    summary,
    filesChanged: fixed().length,
    durationMs: Date.now() - startedAt,
    costUsd: batchUsage?.costUsd ?? 0,
  });
  // Which issues the PR really fixes: the others stay fixable (and visible
  // as failed with their reason), instead of all counting as "fixed in PR".
  outcome.issueResults = items.map((i) => ({
    url: i.url,
    fixed: i.state === "resolved" && Boolean(outcome.prUrl),
    ...(i.detail ? { detail: i.detail } : {}),
  }));
  outcome.issueProgress = progressItems();
  if (batchUsage) outcome.usage = batchUsage;
  return outcome;
}

export const runReviewTask: TaskRunner = async (task, { emit, signal }) => {
  const startedAt = Date.now();
  const prUrl = parsePrUrl(task.task.trim()) ? task.task.trim() : undefined;
  const root = prUrl ? null : (await openWorkspace(task.repoKey)).rootPath;
  const diff = await diffForTarget(root, prUrl ? { prUrl } : "working");
  if (!diff.trim()) throw new Error("Nothing to review: there are no uncommitted changes.");
  const model = await reviewModel(task.model);
  emit({ type: "run_start", runId: task.id, mode: "single", model, at: startedAt });
  const result = await reviewDiff({ diff, task: prUrl ? undefined : task.task, model, signal, root: root ?? undefined });
  emit({
    type: "run_done",
    status: "done",
    summary: result.summary,
    filesChanged: 0,
    durationMs: Date.now() - startedAt,
    costUsd: 0,
  });
  return { result };
};

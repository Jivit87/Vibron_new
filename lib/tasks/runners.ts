/**
 * What a queued task does. `fix`: solve → (deliver when resolved and asked)
 * → (report on the issue); a fix for a GitHub issue runs in a fresh worktree
 * of origin/<default> with the issue's current text. `review`: one `reviewDiff` call over the work
 * tree's changes, or over a PR when the task text is a PR URL.
 */

import { resolveModel } from "@/lib/ai";
import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { runGit } from "@/lib/git";
import {
  branchName,
  createIssueWorktree,
  deliver,
  evidenceFromResult,
  removeIssueWorktree,
  renderPrBody,
  reportOnIssue,
  titleFromTask,
} from "@/lib/deliver";
import { parsePrUrl } from "@/lib/github-api";
import { recordFixNote, relevantLessons } from "@/lib/memory/graph";
import { fetchIssueTask } from "@/lib/issues";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import type { Task, TaskOutcome, TaskRunner } from "@/lib/tasks";
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
  const tree = await createIssueWorktree(home);
  try {
    const meta = await registerLocalWorkspace(tree.dir);
    return await fixIn({ ...task, repoKey: meta.repoKey }, tree.dir, home, text, {
      emit,
      signal,
      title: `Fix #${issue.number}: ${issue.title}`,
      baseBranch: tree.base,
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
  ctx: { emit: (event: OrchestrationEvent) => void; signal: AbortSignal; title?: string; baseBranch?: string },
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
    budget: { maxTurns: 40 },
    verify: { enabled: true, commands, timeoutMs: 300_000, baseline: true },
    useRepoRules: true,
    review: true,
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
    });
    outcome.prUrl = pr.prUrl;
  } catch (error) {
    return { result, error: `Delivery failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (task.issueUrl) {
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
  state: "pending" | "running" | "resolved" | "failed";
  detail?: string;
  /** The proven fix, committed on a detached HEAD (kept alive by a ref). */
  commit?: string;
  files?: string[];
}

/** Issues solved at once; each in its own worktree. */
const BATCH_CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.VIBERON_ISSUE_CONCURRENCY) || 3));

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
  }));
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
  const checklist = () =>
    ctx.emit({
      type: "todos",
      agentId: "issues",
      items: items.map((i) => ({
        id: String(i.number),
        content: `${i.state === "resolved" ? "✓" : i.state === "failed" ? "✗" : ""} #${i.number} ${i.title}${i.detail ? ` (${i.detail})` : ""}`.trim(),
        status: i.state === "resolved" ? "completed" : i.state === "running" ? "in_progress" : "pending",
      })),
    });
  const say = (text: string) => ctx.emit({ type: "agent_text", agentId: "issues", text: `${text}\n` });
  ctx.emit({ type: "run_start", runId: task.id, mode: "single", model, at: startedAt });
  ctx.emit({ type: "plan", plan, awaitingApproval: false });
  checklist();
  say(`Solving ${items.length} issues with ${model}, ${BATCH_CONCURRENCY} at a time.`);

  // A setup problem (no usable model, no credentials) fails every issue the
  // same way: stop at the first one instead of burning through the rest.
  let fatal: string | null = null;
  const { solveTask } = await import("@/lib/harness/solve");
  let firstTree: ReturnType<typeof createIssueWorktree> | null = null;
  const issueTree = async () => {
    if (!firstTree) return await (firstTree = createIssueWorktree(home));
    return createIssueWorktree(home, { baseBranch: (await firstTree).base });
  };

  async function solveOne(item: BatchItem): Promise<void> {
    if (fatal || ctx.signal.aborted) return;
    item.state = "running";
    checklist();
    const began = Date.now();
    try {
      const { text, issue } = await fetchIssueTask(item.url);
      item.title = issue.title;
      if (issue.state !== "open") throw new Error("issue is closed");
      checklist();
      const tree = await issueTree();
      try {
        const handle = await openWorkspace((await registerLocalWorkspace(tree.dir)).repoKey);
        const result = await solveTask({
          handle,
          task: withProjectLessons(home, task.instructions
            ? `The user's request for this run: ${task.instructions}\n\nWork on this issue within that request.\n\n${text}`
            : text),
          model,
          // Parallel solves would interleave in one trace: the checklist and
          // one line per issue are the batch's view.
          emit: () => {},
          signal: ctx.signal,
          runId: `${task.id}-${item.number}`,
          budget: { maxTurns: 30, maxWallMs: 8 * 60_000 },
          verify: { enabled: true, commands: await detectVerifyCommands(tree.dir).catch(() => []), timeoutMs: 180_000, baseline: true },
          useRepoRules: true,
        });
        if (result.status === "error" || (result.metrics.modelCalls === 0 && result.error)) {
          fatal = result.error ?? "the solver could not start";
          throw new Error(fatal);
        }
        if (result.status !== "resolved" || !result.filesChanged.length) {
          throw new Error(`no proof (${result.status}${result.gate.reason ? `: ${result.gate.reason.slice(0, 80)}` : ""})`);
        }
        await runGit(tree.dir, ["add", "-A", "--", ...result.filesChanged]);
        await runGit(tree.dir, ["commit", "-q", "-m", `Fix #${item.number}: ${issue.title}\n\n${result.summary.slice(0, 2000)}\n\nFixes #${item.number}`]);
        item.commit = (await runGit(tree.dir, ["rev-parse", "HEAD"])).stdout.trim();
        // The worktree goes away; a ref keeps the commit until it is picked.
        await runGit(home, ["update-ref", `refs/viberon/batch/${task.id}/${item.number}`, item.commit]);
        item.files = result.filesChanged;
        item.state = "resolved";
        recordFixNote(home, { issue: `#${item.number} ${issue.title}`, files: result.filesChanged, rootCause: result.summary, verified: true });
        say(`✓ #${item.number} fixed in ${Math.round((Date.now() - began) / 1000)}s: ${result.filesChanged.join(", ")}`);
      } finally {
        await removeIssueWorktree(home, tree.dir);
      }
    } catch (error) {
      item.state = "failed";
      item.detail = (error instanceof Error ? error.message : String(error)).slice(0, 160);
      say(`✗ #${item.number} not fixed: ${item.detail}`);
    }
    checklist();
  }

  // A small worker pool over the issues, in order.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) await solveOne(items[next++]!);
    }),
  );
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
      if (!outcome.error && !task.deliver) {
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
    costUsd: 0,
  });
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

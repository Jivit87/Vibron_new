/**
 * Run history helpers shared by the /api/runs routes (ported from Pramana's
 * Studio `Run.summary()`): one compact row per run, so the history list costs
 * a few hundred bytes per run instead of shipping whole SolveResults.
 */

import type { SolveResult } from "@/lib/harness/solve-types";
import { usageTokens, type Task } from "@/lib/tasks";

/** A live agent run as the harness registry holds it (read-only view). */
export interface LiveAgentRun {
  runId: string;
  repoKey: string;
  startedAt: number;
  controller: AbortController;
}

export interface RunSummary {
  id: string;
  kind: "fix" | "review" | "agent";
  repoKey: string;
  title: string;
  /** Lifecycle: queued | running | cancelling | done | failed | cancelled. */
  status: string;
  /** Outcome: the solve's status (resolved, unverified, failed, ...) once known. */
  verdict: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Wall time in ms: finished - started, or elapsed so far while running. */
  wallMs: number | null;
  tokens: number | null;
  costUsd: number | null;
  model: string | null;
  prUrl: string | null;
  hasReport: boolean;
}

export function isSolveResult(result: unknown): result is SolveResult {
  return (
    Boolean(result) && typeof result === "object" && "gate" in (result as object) && "metrics" in (result as object)
  );
}

function verdictOf(task: Task): string | null {
  const r = task.result as { status?: unknown } | undefined;
  if (r && typeof r.status === "string") return r.status;
  if (task.kind === "review" && task.result) return "reviewed";
  return null;
}

export function titleOf(task: Pick<Task, "task" | "id">): string {
  return task.task.trim().split("\n")[0]!.slice(0, 120) || task.id;
}

export function summarizeTask(task: Task, now = Date.now()): RunSummary {
  const start = task.startedAt ?? null;
  const end = task.finishedAt ?? null;
  const solveMs = isSolveResult(task.result) ? task.result.metrics.durationMs : null;
  return {
    id: task.id,
    kind: task.kind,
    repoKey: task.repoKey,
    title: titleOf(task),
    status: task.state,
    verdict: verdictOf(task),
    createdAt: task.createdAt,
    startedAt: start,
    finishedAt: end,
    wallMs: start === null ? solveMs : (end ?? now) - start,
    tokens: task.usage ? usageTokens(task.usage) : null,
    costUsd: task.usage ? task.usage.costUsd : null,
    model: task.model ?? null,
    prUrl: task.prUrl ?? null,
    hasReport: Boolean(task.result) && task.state !== "queued" && task.state !== "running",
  };
}

export function summarizeAgentRun(run: LiveAgentRun, now = Date.now()): RunSummary {
  return {
    id: run.runId,
    kind: "agent",
    repoKey: run.repoKey,
    title: "Agent run",
    status: run.controller.signal.aborted ? "cancelling" : "running",
    verdict: null,
    createdAt: run.startedAt,
    startedAt: run.startedAt,
    finishedAt: null,
    wallMs: now - run.startedAt,
    tokens: null,
    costUsd: null,
    model: null,
    prUrl: null,
    hasReport: false,
  };
}

/**
 * Live agent runs of /api/agent. lib/harness/runs.ts keeps them in a
 * process-global registry but exports no listing yet, so read that registry
 * through its global symbol (read-only). Replace with `listRuns()` from
 * lib/harness/runs once it exists.
 */
export function liveAgentRuns(repoKey?: string): LiveAgentRun[] {
  const registry = (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("viberon.harness.runs")] as
    | { runs?: unknown }
    | undefined;
  const runs = registry?.runs instanceof Map ? [...(registry.runs as Map<string, LiveAgentRun>).values()] : [];
  return repoKey ? runs.filter((r) => r.repoKey === repoKey) : runs;
}

/**
 * The run registry.
 *
 * A run outlives the request that answers it: approvals arrive on
 * `POST /api/agent/approve`, Stop arrives on `POST /api/agent/cancel`, and
 * both must find the run the SSE stream belongs to. So every run registers
 * here with its abort controller and its own pending approvals, and the map
 * lives on globalThis to survive dev-mode HMR.
 *
 * Cancelling a run is total: the controller aborts every model stream and
 * tool, every approval the run is parked on is denied (not left to time
 * out), and every terminal session the run started is killed.
 */

import { randomUUID } from "node:crypto";

import type {
  ApprovalDecision,
  ApprovalKind,
  EventSink,
  OrchestrationEvent,
} from "@/lib/agents/events";
import { killSessionsByRun } from "@/lib/harness/workspace-services";

/** What an agent asks the user to approve. */
export interface ApprovalAsk {
  kind: ApprovalKind;
  /** Command text, "Edit src/x.ts", or the MCP tool name. */
  title: string;
  reason: string;
  detail?: Extract<OrchestrationEvent, { type: "approval_request" }>["detail"];
  /** Identity for "allow always": the command, the tool, or "edit". */
  alwaysKey?: string;
}

type Resolution = Extract<OrchestrationEvent, { type: "approval_resolved" }>["decision"];

interface PendingApproval {
  runId: string;
  resolve: (decision: Resolution) => void;
  timer: ReturnType<typeof setTimeout>;
  alwaysKey: string;
}

export interface RunRecord {
  runId: string;
  repoKey: string;
  controller: AbortController;
  signal: AbortSignal;
  emit: EventSink;
  startedAt: number;
  approvals: Set<string>;
}

interface Registry {
  runs: Map<string, RunRecord>;
  approvals: Map<string, PendingApproval>;
  /** repoKey → keys the user chose "allow always" for, for this process. */
  alwaysAllow: Map<string, Set<string>>;
}

const KEY = Symbol.for("viberon.harness.runs");
type GlobalWithRuns = typeof globalThis & { [KEY]?: Registry };
const host = globalThis as GlobalWithRuns;
const registry: Registry = host[KEY] ?? {
  runs: new Map(),
  approvals: new Map(),
  alwaysAllow: new Map(),
};
host[KEY] = registry;

/** Auto-deny after this long with no answer. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

export function createRun(repoKey: string, emit: EventSink): RunRecord {
  const controller = new AbortController();
  const run: RunRecord = {
    runId: randomUUID(),
    repoKey,
    controller,
    signal: controller.signal,
    emit,
    startedAt: Date.now(),
    approvals: new Set(),
  };
  registry.runs.set(run.runId, run);
  return run;
}

export function getRun(runId: string): RunRecord | undefined {
  return registry.runs.get(runId);
}

/** One run as `listRuns` reports it: the fields a history row needs, nothing internal. */
export interface RunListItem {
  id: string;
  runId: string;
  repoKey: string;
  /** Lifecycle: a run leaves the registry once it finishes, so only these two occur. */
  status: "running" | "cancelling";
  startedAt: number;
  /** Always null: a finished run is removed from the registry (see `finishRun`). */
  finishedAt: number | null;
  controller: AbortController;
}

/**
 * List live runs (optionally filtered to one repo), newest fields first for
 * history rows: id, status, repoKey, startedAt and finishedAt where known.
 * Runs that have finished are no longer in the registry, so `finishedAt` is
 * always null here.
 */
export function listRuns(repoKey?: string): RunListItem[] {
  const runs = [...registry.runs.values()];
  const filtered = repoKey ? runs.filter((r) => r.repoKey === repoKey) : runs;
  return filtered.map((r) => ({
    id: r.runId,
    runId: r.runId,
    repoKey: r.repoKey,
    status: r.signal.aborted ? "cancelling" : "running",
    startedAt: r.startedAt,
    finishedAt: null,
    controller: r.controller,
  }));
}

/** Point a run's events at a new sink (the stream opens after the run exists). */
export function setRunSink(runId: string, emit: EventSink): void {
  const run = registry.runs.get(runId);
  if (run) run.emit = emit;
}

function settle(approvalId: string, decision: Resolution): boolean {
  const entry = registry.approvals.get(approvalId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  registry.approvals.delete(approvalId);
  const run = registry.runs.get(entry.runId);
  run?.approvals.delete(approvalId);
  run?.emit({ type: "approval_resolved", approvalId, decision });
  entry.resolve(decision);
  return true;
}

/**
 * Ask the user. Resolves true only on an explicit allow; a deny, a timeout,
 * or the run being cancelled all resolve false. Keys the user already chose
 * "allow always" for pass straight through without a prompt.
 */
export function requestApproval(
  runId: string,
  agentId: string,
  ask: ApprovalAsk,
): Promise<boolean> {
  const run = registry.runs.get(runId);
  if (!run || run.signal.aborted) return Promise.resolve(false);

  const alwaysKey = ask.alwaysKey ?? `${ask.kind}:${ask.title}`;
  if (registry.alwaysAllow.get(run.repoKey)?.has(alwaysKey)) {
    return Promise.resolve(true);
  }

  const approvalId = randomUUID();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(
      () => settle(approvalId, "timeout"),
      APPROVAL_TIMEOUT_MS,
    );
    registry.approvals.set(approvalId, {
      runId,
      alwaysKey,
      timer,
      resolve: (decision) => resolve(decision === "allow"),
    });
    run.approvals.add(approvalId);
    run.emit({
      type: "approval_request",
      approvalId,
      agentId,
      kind: ask.kind,
      title: ask.title,
      command: ask.title,
      reason: ask.reason,
      detail: ask.detail,
    });
  });
}

/** Answer a pending approval. False when it no longer exists. */
export function resolveApproval(
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const entry = registry.approvals.get(approvalId);
  if (!entry) return false;
  if (decision === "allow_always") {
    const run = registry.runs.get(entry.runId);
    if (run) {
      const keys = registry.alwaysAllow.get(run.repoKey) ?? new Set<string>();
      keys.add(entry.alwaysKey);
      registry.alwaysAllow.set(run.repoKey, keys);
    }
  }
  return settle(approvalId, decision === "deny" ? "deny" : "allow");
}

/** Deny everything one run is waiting on. */
export function denyRunApprovals(runId: string): number {
  const run = registry.runs.get(runId);
  if (!run) return 0;
  let count = 0;
  for (const approvalId of [...run.approvals]) {
    if (settle(approvalId, "cancelled")) count += 1;
  }
  return count;
}

/**
 * Stop a run: abort its model streams and tools, deny its approvals, and
 * kill its terminal sessions. Idempotent; false for an unknown run.
 */
export function cancelRun(runId: string): boolean {
  const run = registry.runs.get(runId);
  if (!run) return false;
  run.controller.abort();
  denyRunApprovals(runId);
  killSessionsByRun(runId);
  return true;
}

/** Forget a finished run. Anything still pending is denied first. */
export function finishRun(runId: string): void {
  denyRunApprovals(runId);
  registry.runs.delete(runId);
}

/** Test helper: drop all state, including "allow always" grants. */
export function resetRunsForTests(): void {
  for (const runId of [...registry.runs.keys()]) finishRun(runId);
  registry.alwaysAllow.clear();
}

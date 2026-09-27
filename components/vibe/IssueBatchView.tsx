"use client";

/**
 * The batch view: several GitHub issues fixed at once, on one task. Shows a
 * live clock and where every issue's seconds went (model / tools / proof)
 * while it runs, then the proven fix's pull request. `startIssueBatch`
 * queues the task; `fetchTask` polls its `issueResults[]` (all fields
 * optional — the server ships them incrementally, see docs/PLAN-ISSUES.md).
 */

import { useEffect, useMemo, useState } from "react";
import { Ban, Check, ExternalLink, Loader2, Square, X } from "lucide-react";
import { toast } from "sonner";

import {
  batchIssueElapsedMs,
  batchIssueTotals,
  batchTimingPct,
  cancelTask,
  fetchTask,
  shortRef,
  taskUsageLine,
  type BatchIssueResult,
  type BatchIssueStatus,
  type TaskRow,
} from "@/lib/client/deliver";
import { startIssueBatch, type BatchStartOptions } from "@/lib/client/issues";
import { usePolling } from "@/lib/client/use-polling";
import { formatCost, formatDuration, formatTokens, Segmented, Switch, cx } from "@/components/vibe/primitives";

const POLL_MS = 2_500;
const CLOCK_MS = 1_000;

const STATUS_LABEL: Record<BatchIssueStatus, string> = {
  queued: "queued",
  running: "running",
  verified: "verified",
  unproven: "unproven",
  failed: "failed",
  cancelled: "cancelled",
};

const STATUS_COLOR: Record<BatchIssueStatus, string> = {
  queued: "var(--vb-text-faint)",
  running: "var(--vb-accent)",
  verified: "var(--vb-mint)",
  unproven: "var(--vb-amber)",
  failed: "var(--vb-rose)",
  cancelled: "var(--vb-text-dim)",
};

/** A batch row synthesized from a plain task when it carries no `issueResults` yet. */
function rowFromTask(task: TaskRow): BatchIssueResult {
  const status: BatchIssueStatus =
    task.state === "done" ? (task.prUrl ? "verified" : "unproven") : task.state === "cancelled" ? "cancelled" : task.state;
  return {
    url: task.issueUrl ?? task.id,
    title: task.task,
    status,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    usage: task.usage ? { input: task.usage.tokens, output: 0, cached: 0, calls: 0 } : undefined,
    prUrl: task.prUrl,
    detail: task.note ?? task.error,
  };
}

function rowsOf(task: TaskRow): BatchIssueResult[] {
  return task.issueResults && task.issueResults.length > 0 ? task.issueResults : [rowFromTask(task)];
}

/** True when nothing is left running or queued. */
function isSettled(rows: BatchIssueResult[]): boolean {
  return rows.every((r) => r.status !== "queued" && r.status !== "running");
}

export interface IssueBatchViewProps {
  repoKey: string | null;
  /** Issues to run when "Start batch" is pressed: a specific selection, or every open issue. */
  numbers: number[] | "all";
  model?: string;
  /** The task this view is already watching (e.g. one just queued elsewhere). */
  taskId: string | null;
  onTaskId: (id: string | null) => void;
}

/**
 * Several issues at once: a live clock and phase per issue, a time-breakdown
 * bar (model / tools / proof), tokens + calls, a "fast path: 1 call" badge,
 * and each proven fix's pull request — plus the batch's own header (model,
 * totals, one Stop) and the controls to start one.
 */
export function IssueBatchView({ repoKey, numbers, model, taskId, onTaskId }: IssueBatchViewProps) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [combined, setCombined] = useState<"per_issue" | "combined">("combined");
  const [autoPr, setAutoPr] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const rows = useMemo(() => (task ? rowsOf(task) : []), [task]);
  const active = rows.length > 0 && !isSettled(rows);

  const refresh = async () => {
    if (!taskId) return;
    const t = await fetchTask(taskId);
    if (t) setTask(t);
  };

  useEffect(() => {
    setTask(null);
    if (taskId) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  usePolling(refresh, POLL_MS, Boolean(taskId) && active);

  // A live per-second clock while anything is running; still ticks once when settled.
  useEffect(() => {
    if (!active) {
      setNow(Date.now());
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(id);
  }, [active]);

  const totals = useMemo(() => {
    const own = batchIssueTotals(rows);
    return {
      tokens: task?.usage?.tokens ?? own.tokens,
      costUsd: task?.usage?.costUsd ?? 0,
      calls: own.calls,
    };
  }, [rows, task]);

  const batchStart = task?.startedAt ?? task?.createdAt;
  const batchElapsed = batchStart ? Math.max(0, (task?.finishedAt ?? now) - batchStart) : 0;

  async function start() {
    if (!repoKey || starting) return;
    setStarting(true);
    const options: BatchStartOptions = { combined: combined === "combined", autoPr, model };
    const result = await startIssueBatch(repoKey, numbers, options);
    setStarting(false);
    if (result.ok === false) {
      toast.error(result.error);
      return;
    }
    onTaskId(result.taskId);
    toast.success(`Batch started: ${numbers === "all" ? "every open issue" : `${numbers.length} issue${numbers.length === 1 ? "" : "s"}`}.`);
  }

  async function stop() {
    if (!taskId || stopping) return;
    setStopping(true);
    const result = await cancelTask(taskId);
    setStopping(false);
    if (!result.ok) toast.error(result.error ?? "Could not stop the batch.");
    void refresh();
  }

  return (
    <div className="flex flex-col border-b" style={{ borderColor: "var(--vb-line-faint)" }}>
      {/* Controls: PR mode, auto-PR, start/stop. */}
      <div className="flex h-[26px] shrink-0 items-center gap-2 px-3 pt-1 text-[12px]" style={{ color: "var(--vb-text-mid)" }}>
        <span className="shrink-0" style={{ color: "var(--vb-text-dim)" }}>
          Batch
        </span>
        <Segmented<"per_issue" | "combined">
          value={combined}
          onChange={setCombined}
          options={[
            { value: "per_issue", label: "Per issue", title: "One pull request per proven issue" },
            { value: "combined", label: "Combined", title: "One pull request for every proven issue" },
          ]}
        />
        <Switch checked={autoPr} onChange={setAutoPr} label="Auto-PR proven fixes" />
        <span className="shrink-0">Auto-PR proven fixes</span>
        <div className="flex-1" />
        {taskId && active ? (
          <button
            type="button"
            className="vb-btn vb-btn-ghost"
            style={{ height: 22, padding: "0 8px", color: "var(--vb-rose)" }}
            disabled={stopping}
            title="Stop every issue in this batch"
            onClick={() => void stop()}
          >
            {stopping ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3" />}
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="vb-btn vb-btn-primary"
            style={{ height: 22, padding: "0 8px" }}
            disabled={!repoKey || starting}
            title={numbers === "all" ? "Fix every open issue" : `Fix ${numbers.length} selected issue${numbers.length === 1 ? "" : "s"}`}
            onClick={() => void start()}
          >
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Start batch{numbers !== "all" && numbers.length > 0 ? ` (${numbers.length})` : ""}
          </button>
        )}
      </div>

      {task && (
        <>
          {/* Header: model, totals, elapsed. */}
          <div className="flex h-[24px] shrink-0 items-center gap-3 px-3 font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            {task.model && <span>{task.model}</span>}
            <span>{formatDuration(batchElapsed)}</span>
            <span>
              {rows.filter((r) => r.status === "verified").length}/{rows.length} verified
            </span>
            {totals.tokens > 0 && <span>{formatTokens(totals.tokens)} tok</span>}
            {totals.calls > 0 && <span>{totals.calls} calls</span>}
            {totals.costUsd > 0 && <span>{formatCost(totals.costUsd)}</span>}
          </div>

          {/* One row per issue. */}
          <div className="flex flex-col pb-1">
            {rows.map((row, i) => (
              <BatchRow key={row.url || i} row={row} now={now} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function fastPathBadge(row: BatchIssueResult): string | null {
  if (!row.fastPath?.used) return null;
  return `fast path: ${row.fastPath.calls || 1} call${(row.fastPath.calls || 1) === 1 ? "" : "s"}`;
}

function StatusIcon({ status }: { status: BatchIssueStatus }) {
  const color = STATUS_COLOR[status];
  if (status === "running") return <Loader2 className="size-3 shrink-0 animate-spin" style={{ color }} />;
  if (status === "verified") return <Check className="size-3 shrink-0" style={{ color }} />;
  if (status === "failed") return <X className="size-3 shrink-0" style={{ color }} />;
  if (status === "cancelled") return <Ban className="size-3 shrink-0" style={{ color }} />;
  return <span className="size-[6px] shrink-0 rounded-full" style={{ background: color }} />;
}

/** The model/tools/proof bar: three segments, ms-proportional, ms in the title. */
function TimingBar({ row }: { row: BatchIssueResult }) {
  const { modelPct, toolsPct, proofPct } = batchTimingPct(row.timing);
  const t = row.timing;
  if (!t) return <div className="h-[5px] w-16 shrink-0 rounded-[2px]" style={{ background: "var(--vb-line-faint)" }} />;
  const title = `model ${t.modelMs}ms · tools ${t.toolsMs}ms · proof ${t.proofMs}ms`;
  return (
    <div className="flex h-[5px] w-16 shrink-0 overflow-hidden rounded-[2px]" title={title} style={{ background: "var(--vb-line-faint)" }}>
      <span style={{ width: `${modelPct}%`, background: "var(--vb-accent)" }} />
      <span style={{ width: `${toolsPct}%`, background: "var(--vb-amber)" }} />
      <span style={{ width: `${proofPct}%`, background: "var(--vb-mint)" }} />
    </div>
  );
}

function BatchRow({ row, now }: { row: BatchIssueResult; now: number }) {
  const elapsed = batchIssueElapsedMs(row, now);
  const badge = fastPathBadge(row);
  const tokens = row.usage ? row.usage.input + row.usage.output + row.usage.cached : 0;
  return (
    <div className="flex h-[24px] items-center gap-2 px-3 text-[12px]" title={row.detail}>
      <StatusIcon status={row.status} />
      <span className="w-14 shrink-0 font-mono text-[11px]" style={{ color: STATUS_COLOR[row.status] }}>
        {STATUS_LABEL[row.status]}
      </span>
      <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
        {row.number ? `#${row.number} ` : ""}
        {row.title ?? row.url}
      </span>
      {row.status === "running" && row.phase && (
        <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {row.phase}
        </span>
      )}
      <span className="w-12 shrink-0 text-right font-mono text-[11px] tabular-nums" style={{ color: "var(--vb-text-faint)" }}>
        {elapsed > 0 ? formatDuration(elapsed) : ""}
      </span>
      <TimingBar row={row} />
      <span className="w-24 shrink-0 text-right font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
        {taskUsageLine(tokens ? { tokens, costUsd: 0 } : undefined) || (row.usage?.calls ? `${row.usage.calls} calls` : "")}
      </span>
      {badge && (
        <span
          className="shrink-0 rounded-[2px] px-1 font-mono text-[10.5px]"
          style={{ background: "var(--vb-active)", color: "var(--vb-text-mid)" }}
        >
          {badge}
        </span>
      )}
      <div className="w-20 shrink-0 text-right">
        {row.prUrl ? (
          <a
            href={row.prUrl}
            target="_blank"
            rel="noreferrer"
            className={cx("inline-flex items-center gap-1 hover:underline")}
            style={{ color: "var(--vb-text-mid)" }}
            title={row.prUrl}
          >
            {shortRef(row.prUrl).includes("#") ? `PR #${shortRef(row.prUrl).split("#")[1]}` : "Open PR"}
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : null}
      </div>
    </div>
  );
}

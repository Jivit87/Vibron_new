"use client";

/**
 * The task queue: fix and review tasks queued from the UI, the CLI, the
 * local API or an issue. One running task per repo, FIFO. Selecting a
 * running task attaches its live event stream to the normal run view.
 * Stop (per row, or Stop all) cancels on the server: the model call is
 * aborted, the task's processes are killed and its worktree removed.
 */

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, Square } from "lucide-react";
import { toast } from "sonner";

import { attachedTask, attachTaskRun } from "@/lib/client/agent-stream";
import { cancelTask, listTasks, shortRef, stopAllTasks, taskUsageLine, type TaskRow, type TaskState } from "@/lib/client/deliver";
import { sameJson, usePolling } from "@/lib/client/use-polling";
import { useViberon } from "@/store/viberon";
import { cx, EmptyState, formatAgo, IconButton } from "@/components/vibe/primitives";

const STATE: Record<TaskState, { label: string; color: string }> = {
  running: { label: "running", color: "var(--vb-accent)" },
  queued: { label: "queued", color: "var(--vb-text-mid)" },
  done: { label: "done", color: "var(--vb-mint)" },
  failed: { label: "failed", color: "var(--vb-rose)" },
  cancelled: { label: "stopped", color: "var(--vb-text-faint)" },
};

const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;
const SMALL_BTN = { height: 20, padding: "0 6px", fontSize: 11.5 } as const;

/** What the state column says: a done task without a PR says why (its note). */
function stateLabel(task: TaskRow, stopping: boolean): string {
  if (stopping && (task.state === "running" || task.state === "queued")) return "stopping…";
  if (task.state === "done" && task.kind === "fix" && !task.prUrl && task.note) return "not delivered";
  return STATE[task.state].label;
}

export function TasksPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const streaming = useViberon((s) => s.streaming);
  const [tasks, setTasks] = useState<TaskRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);
  /** Tasks the user asked to stop that the server still reports active. */
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const [stoppingAll, setStoppingAll] = useState(false);

  const refresh = useCallback(
    async (manual = false) => {
      if (!repoKey) return;
      // Only a click spins the refresh icon; background polls stay quiet.
      if (manual) setLoading(true);
      const result = await listTasks(repoKey);
      if (manual) setLoading(false);
      if (result.ok) {
        const next = result.tasks ?? [];
        setTasks((prev) => (prev && sameJson(prev, next) ? prev : next));
        setError(null);
        setMissing(false);
        // A task that finished is no longer "stopping".
        setStopping((prev) => {
          if (!prev.size) return prev;
          const active = new Set(next.filter((t) => t.state === "running" || t.state === "queued").map((t) => t.id));
          const kept = new Set([...prev].filter((id) => active.has(id)));
          return kept.size === prev.size ? prev : kept;
        });
      } else {
        setError(result.error ?? "Could not load tasks");
        setMissing(Boolean(result.missing));
      }
    },
    [repoKey],
  );

  const active = tasks?.some((t) => t.state === "running" || t.state === "queued") ?? false;

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, active ? POLL_ACTIVE_MS : POLL_IDLE_MS, Boolean(repoKey) && !missing);

  async function stop(task: TaskRow) {
    setStopping((prev) => new Set(prev).add(task.id));
    const result = await cancelTask(task.id);
    if (!result.ok) {
      toast.error(result.error ?? "Could not stop the task.");
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
    void refresh();
  }

  async function stopAll() {
    if (!repoKey) return;
    setStoppingAll(true);
    const ids = (tasks ?? []).filter((t) => t.state === "running" || t.state === "queued").map((t) => t.id);
    setStopping((prev) => new Set([...prev, ...ids]));
    const result = await stopAllTasks(repoKey);
    setStoppingAll(false);
    if (!result.ok) toast.error(result.error ?? "Could not stop the tasks.");
    void refresh();
  }

  function attach(task: TaskRow) {
    if (streaming) {
      toast.error("A run is already showing. Stop it first.");
      return;
    }
    useViberon.getState().setAgentDockOpen(true);
    void attachTaskRun(task);
  }

  const attached = streaming ? attachedTask() : null;
  const counts = (tasks ?? []).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.state]: (acc[t.state] ?? 0) + 1 }), {});

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[26px] shrink-0 items-center gap-3 border-b px-3 font-mono text-[11px]" style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-dim)" }}>
        {(["running", "queued", "failed", "done"] as const).map((s) => (
          <span key={s}>
            <span style={{ color: counts[s] ? STATE[s].color : "var(--vb-text-faint)" }}>{counts[s] ?? 0}</span> {s}
          </span>
        ))}
        <div className="flex-1" />
        {active && (
          <button
            type="button"
            className="vb-btn vb-btn-ghost"
            style={{ ...SMALL_BTN, color: "var(--vb-rose)" }}
            disabled={stoppingAll}
            title="Stop every queued and running task of this repository"
            onClick={() => void stopAll()}
          >
            {stoppingAll ? <Loader2 className="size-3 animate-spin" /> : <Square className="size-3" />}
            Stop all
          </button>
        )}
        <IconButton title="Refresh" onClick={() => void refresh(true)}>
          <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !tasks ? (
          <EmptyState title={missing ? "The task queue is not available" : "Could not load tasks"} body={missing ? "This server does not expose /api/tasks yet." : error} />
        ) : !tasks ? (
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <div className="vb-shimmer h-3 w-2/3 rounded-[3px]" />
            <div className="vb-shimmer h-3 w-1/2 rounded-[3px]" />
          </div>
        ) : tasks.length === 0 ? (
          <EmptyState title="No tasks" body="Fix CI from a pull request, `viberon fix --queue`, or POST /api/tasks adds one here." />
        ) : (
          <table className="w-full table-fixed border-collapse text-[12px]" aria-label="Tasks">
            <thead>
              <tr className="text-left text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                <th className="w-[100px] py-0.5 pl-3 font-normal">state</th>
                <th className="py-0.5 font-normal">task</th>
                <th className="w-[52px] py-0.5 font-normal">kind</th>
                <th className="w-[52px] py-0.5 font-normal">source</th>
                <th className="w-[72px] py-0.5 font-normal">age</th>
                <th className="w-[116px] py-0.5 font-normal">tokens</th>
                <th className="w-[128px] py-0.5 font-normal">pull request</th>
                <th className="w-[32px] py-0.5" />
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const st = STATE[task.state];
                const first = task.task.split("\n").find((l) => l.trim()) ?? task.id;
                const live = task.state === "running";
                const isActive = live || task.state === "queued";
                const isStopping = stopping.has(task.id) && isActive;
                const isAttached = attached === task.id;
                const detail = task.error ?? (task.state === "done" && !task.prUrl ? task.note : undefined);
                return (
                  <tr
                    key={task.id}
                    className={cx("group h-[24px] border-t align-middle", live && !isStopping && "cursor-pointer hover:bg-[var(--vb-hover)]")}
                    style={{ borderColor: "var(--vb-line-faint)", background: isAttached ? "var(--vb-accent-soft)" : undefined }}
                    onClick={() => live && !isStopping && !isAttached && attach(task)}
                    title={[task.task, task.error ? `Error: ${task.error}` : "", task.note ? `Note: ${task.note}` : "", live ? "Click to watch the live run" : ""].filter(Boolean).join("\n\n")}
                  >
                    <td className="pl-3">
                      <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color: isStopping ? "var(--vb-text-mid)" : st.color }}>
                        {live && !isStopping ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <span className="size-[6px] rounded-full" style={{ background: isStopping ? "var(--vb-text-mid)" : st.color }} />
                        )}
                        {isAttached && !isStopping ? "watching" : stateLabel(task, isStopping)}
                      </span>
                    </td>
                    <td className="truncate pr-2" style={{ color: task.state === "cancelled" ? "var(--vb-text-dim)" : "var(--vb-text)" }}>
                      {task.issueUrl ? (
                        <a
                          href={task.issueUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="hover:underline"
                          style={{ color: "inherit" }}
                          title={task.issueUrl}
                        >
                          {first}
                        </a>
                      ) : (
                        first
                      )}
                      {detail && (
                        <span className="ml-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
                          {detail}
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
                      {task.kind}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
                      {task.source}
                    </td>
                    <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {task.createdAt ? formatAgo(task.createdAt) : ""}
                    </td>
                    <td className="truncate pr-2 font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }} title={task.usage ? `${task.usage.tokens.toLocaleString()} tokens, $${task.usage.costUsd.toFixed(4)}` : undefined}>
                      {taskUsageLine(task.usage)}
                    </td>
                    <td className="truncate pr-2">
                      {task.prUrl && (
                        <a
                          href={task.prUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex max-w-full items-center gap-1 font-mono text-[11px] hover:underline"
                          style={{ color: "var(--vb-text-mid)" }}
                        >
                          <span className="truncate">{shortRef(task.prUrl)}</span>
                          <ExternalLink className="size-3 shrink-0" />
                        </a>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {isActive && (
                        <IconButton title={isStopping ? "Stopping…" : "Stop this task"} tone="danger" disabled={isStopping} onClick={() => void stop(task)}>
                          <Square className="size-3" />
                        </IconButton>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

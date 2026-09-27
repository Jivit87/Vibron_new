"use client";

/**
 * Changes + checkpoints sidebar.
 *
 * A source-control-shaped view of what the agents did: every file the
 * current run touched, with a diff you can open, plus the snapshot list so
 * an entire run can be rolled back in one action.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Clock,
  FileCode2,
  GitCompare,
  History,
  Network,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { refreshWorkspace } from "@/lib/client/agent-stream";
import { focusFromFile, focusFromReceipt, focusFromRun } from "@/lib/client/graph-focus";
import { useViberon } from "@/store/viberon";
import {
  cx,
  DiffCounts,
  EmptyState,
  IconButton,
  PanelHeader,
  truncatePath,
} from "@/components/vibe/primitives";

interface CheckpointSummary {
  id: string;
  label: string;
  createdAt: number;
  fileCount: number;
  totalBytes: number;
}

export function ChangesPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const run = useViberon((s) => s.run);
  const conversationRuns = useViberon((s) => s.conversationRuns);
  const hasGraph = useViberon((s) => Boolean(s.graph));
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!repoKey) return;
    const response = await fetch(
      `/api/checkpoints?repoKey=${encodeURIComponent(repoKey)}`,
    );
    if (!response.ok) return;
    const body = (await response.json()) as { checkpoints: CheckpointSummary[] };
    setCheckpoints(body.checkpoints);
  }, [repoKey]);

  useEffect(() => {
    void load();
  }, [load, run?.status]);

  const changes = run?.changes ?? [];
  // One row per file, with the net line counts across every edit to it.
  const rows = (() => {
    const map = new Map<
      string,
      { path: string; kind: string; adds: number; removes: number; reverted: boolean }
    >();
    for (const change of changes) {
      const existing = map.get(change.path);
      if (existing) {
        existing.adds += change.adds;
        existing.removes += change.removes;
        existing.reverted = change.reverted;
      } else {
        map.set(change.path, {
          path: change.path,
          kind: change.kind,
          adds: change.adds,
          removes: change.removes,
          reverted: change.reverted,
        });
      }
    }
    return [...map.values()];
  })();

  async function snapshot() {
    setBusy(true);
    try {
      const response = await fetch("/api/checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, label: `Manual ${new Date().toLocaleTimeString()}` }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(body?.error ?? "Could not snapshot.");
        return;
      }
      await load();
      toast.success("Snapshot saved.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string, label: string) {
    if (!window.confirm(`Restore "${label}"? Files created since will be deleted.`)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/checkpoints", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, id }),
      });
      if (!response.ok) {
        toast.error("Restore failed.");
        return;
      }
      const body = (await response.json()) as { restored: number; deleted: number };
      toast.success(
        `Restored ${body.restored} file${body.restored === 1 ? "" : "s"}${
          body.deleted ? `, removed ${body.deleted}` : ""
        }.`,
      );
      await refreshWorkspace();
    } finally {
      setBusy(false);
    }
  }

  async function drop(id: string) {
    await fetch(
      `/api/checkpoints?repoKey=${encodeURIComponent(repoKey)}&id=${id}`,
      { method: "DELETE" },
    );
    await load();
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Changes"
        icon={<GitCompare className="size-3" />}
        actions={
          <IconButton title="Snapshot now" onClick={() => void snapshot()} disabled={busy}>
            <History className="size-3" />
          </IconButton>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {rows.length === 0 && checkpoints.length === 0 ? (
          <EmptyState
            icon={<GitCompare className="size-4" />}
            title="No changes yet"
            body="Files the agents create or edit appear here, with a one-click undo for the whole run."
          />
        ) : (
          <div className="flex flex-col gap-4">
            {rows.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between px-1 pb-1">
                  <span
                    className="text-[11px] font-semibold uppercase tracking-[0.04em]"
                    style={{ color: "var(--vb-text-faint)" }}
                  >
                    This run
                  </span>
                  <span className="flex items-center gap-1">
                    <DiffCounts
                      adds={rows.reduce((s, r) => s + r.adds, 0)}
                      removes={rows.reduce((s, r) => s + r.removes, 0)}
                    />
                    {run && hasGraph && (
                      <IconButton title="Show this run on the code graph" onClick={() => useViberon.getState().showOnGraph(focusFromRun(run))}>
                        <Network className="size-3.5" />
                      </IconButton>
                    )}
                  </span>
                </div>
                {rows.map((row) => (
                  <div key={row.path} className="group flex items-center rounded transition-colors hover:bg-[var(--vb-hover)]">
                  <button
                    type="button"
                    onClick={() => useViberon.getState().openTab(row.path)}
                    className={cx(
                      "flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left",
                      row.reverted && "opacity-45",
                    )}
                  >
                    <span
                      className="w-[30px] shrink-0 text-[11px] font-bold uppercase"
                      style={{
                        color:
                          row.kind === "create"
                            ? "var(--vb-add)"
                            : row.kind === "delete"
                              ? "var(--vb-del)"
                              : "var(--vb-text-faint)",
                      }}
                    >
                      {row.kind === "create"
                        ? "new"
                        : row.kind === "delete"
                          ? "del"
                          : "mod"}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-[11px]"
                      style={{ color: "var(--vb-text)" }}
                      title={row.path}
                    >
                      {truncatePath(row.path, 30)}
                    </span>
                    <DiffCounts adds={row.adds} removes={row.removes} />
                  </button>
                  {hasGraph && (
                    <button
                      type="button"
                      title="Show on the code graph"
                      aria-label={`Show ${row.path} on the code graph`}
                      onClick={() => useViberon.getState().showOnGraph(focusFromFile(row.path))}
                      className="mr-0.5 hidden size-5 shrink-0 items-center justify-center rounded-[3px] hover:bg-[var(--vb-active)] group-hover:inline-flex"
                      style={{ color: "var(--vb-text-dim)" }}
                    >
                      <Network className="size-3" />
                    </button>
                  )}
                  </div>
                ))}
              </section>
            )}

            {checkpoints.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <span
                  className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em]"
                  style={{ color: "var(--vb-text-faint)" }}
                >
                  Checkpoints
                </span>
                {checkpoints.map((checkpoint) => (
                  <div
                    key={checkpoint.id}
                    className="group flex items-center gap-2 rounded px-1.5 py-1 transition-colors hover:bg-[var(--vb-hover)]"
                  >
                    <Clock
                      className="size-3 shrink-0"
                      style={{ color: "var(--vb-text-faint)" }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[11px]"
                        style={{ color: "var(--vb-text)" }}
                        title={checkpoint.label}
                      >
                        {checkpoint.label}
                      </span>
                      <span
                        className="block font-mono text-[11px]"
                        style={{ color: "var(--vb-text-faint)" }}
                      >
                        {new Date(checkpoint.createdAt).toLocaleTimeString()} ·{" "}
                        {checkpoint.fileCount} files
                      </span>
                    </span>
                    <span className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <IconButton
                        title="Restore this snapshot"
                        onClick={() => void restore(checkpoint.id, checkpoint.label)}
                        disabled={busy}
                      >
                        <RotateCcw className="size-2.5" />
                      </IconButton>
                      <IconButton
                        title="Delete snapshot"
                        tone="danger"
                        onClick={() => void drop(checkpoint.id)}
                      >
                        <Trash2 className="size-2.5" />
                      </IconButton>
                    </span>
                  </div>
                ))}
              </section>
            )}

            {conversationRuns.length > 0 && (
              <section className="flex flex-col gap-0.5">
                <span
                  className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em]"
                  style={{ color: "var(--vb-text-faint)" }}
                >
                  This conversation
                </span>
                {[...conversationRuns].reverse().map((entry) => (
                  <div key={entry.id} className="group flex items-start rounded transition-colors hover:bg-[var(--vb-hover)]">
                  <button
                    type="button"
                    onClick={() => {
                      // Jump to the reply this run produced. Chat mode is
                      // where the answer lives, so switch there first.
                      useViberon.getState().setAppMode("chat");
                      if (entry.messageId) {
                        requestAnimationFrame(() =>
                          window.dispatchEvent(
                            new CustomEvent("viberon:scrollToMessage", {
                              detail: { messageId: entry.messageId },
                            }),
                          ),
                        );
                      }
                    }}
                    title={entry.prompt}
                    className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1 text-left"
                  >
                    {entry.status === "done" ? (
                      <Check
                        className="mt-0.5 size-3 shrink-0"
                        style={{ color: "var(--vb-mint)" }}
                      />
                    ) : (
                      <FileCode2
                        className="mt-0.5 size-3 shrink-0"
                        style={{ color: "var(--vb-text-faint)" }}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[11px]"
                        style={{ color: "var(--vb-text-dim)" }}
                      >
                        {entry.prompt}
                      </span>
                      <span
                        className="block font-mono text-[11px]"
                        style={{ color: "var(--vb-text-faint)" }}
                      >
                        {entry.intent === "ask"
                          ? "answered"
                          : `${entry.filesChanged.length} file${
                              entry.filesChanged.length === 1 ? "" : "s"
                            }`}
                        {entry.agentCount > 0 && ` · ${entry.agentCount} agents`}
                      </span>
                    </span>
                  </button>
                  {hasGraph && (entry.filesChanged.length > 0 || (entry.usage?.files.length ?? 0) > 0) && (
                    <button
                      type="button"
                      title="Show what this run read and changed on the code graph"
                      aria-label="Show run on the code graph"
                      onClick={() => {
                        const store = useViberon.getState();
                        const live = store.runHistory.find((r) => r.id === entry.id);
                        store.showOnGraph(live ? focusFromRun(live) : focusFromReceipt(entry));
                      }}
                      className="mr-0.5 mt-1 hidden size-5 shrink-0 items-center justify-center rounded-[3px] hover:bg-[var(--vb-active)] group-hover:inline-flex"
                      style={{ color: "var(--vb-text-dim)" }}
                    >
                      <Network className="size-3" />
                    </button>
                  )}
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ChangesPanel;

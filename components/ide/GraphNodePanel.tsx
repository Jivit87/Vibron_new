"use client";

/**
 * The selected graph node's side panel: what the project remembers about it
 * (anchored memory), what it cost (context tokens), and which runs and tasks
 * read or changed it. Every row links to where that thing lives.
 */

import { useEffect, useMemo, useState } from "react";
import { Brain, FileCode2, X } from "lucide-react";

import {
  focusFromReceipt,
  focusFromRun,
  focusFromTask,
  runsTouching,
  tokensFor,
  type NodeTouch,
} from "@/lib/client/graph-focus";
import { backlinksFor, readMemoryIndex, type AnchoredEntry } from "@/lib/client/memory-graph";
import { formatTok } from "@/lib/client/usage";
import { useUsage } from "@/components/vibe/usage-ui";
import { useLinks } from "@/store/links";
import { openUsagePanel, useUsageStore } from "@/store/usage";
import { useViberon } from "@/store/viberon";
import { cx, formatAgo, splitPath } from "@/components/vibe/primitives";

/** Memory entries per workspace, fetched once and shared by every selection. */
const entryCache = new Map<string, Promise<AnchoredEntry[]>>();

function useMemoryEntries(): AnchoredEntry[] {
  const repoKey = useViberon((s) => s.repoKey);
  const graph = useViberon((s) => s.graph);
  const rootPath = useViberon((s) => s.rootPath);
  // Re-read after the Memory panel saves (it replaces `memory` in the store).
  const memory = useViberon((s) => s.memory);
  const [entries, setEntries] = useState<AnchoredEntry[]>([]);
  useEffect(() => {
    if (!repoKey) return;
    let live = true;
    const key = `${repoKey}:${memory ? "m" : "-"}`;
    let pending = entryCache.get(key);
    if (!pending) {
      pending = fetch(`/api/memory?repoKey=${encodeURIComponent(repoKey)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
        .then((body) => readMemoryIndex(body, { graph: graph ?? null, rootPath }).entries);
      entryCache.set(key, pending);
    }
    void pending.then((list) => live && setEntries(list));
    return () => {
      live = false;
    };
  }, [repoKey, graph, rootPath, memory]);
  return entries;
}

const sectionTitle = "flex h-5 items-center gap-1.5 text-[11px]";
const rowClass = "flex h-[22px] w-full items-center gap-2 rounded-[3px] px-1 text-left text-[12px] hover:bg-[var(--vb-hover)]";

export function GraphNodePanel({ nodeId }: { nodeId: string }) {
  const graph = useViberon((s) => s.graph);
  const run = useViberon((s) => s.run);
  const runHistory = useViberon((s) => s.runHistory);
  const conversationRuns = useViberon((s) => s.conversationRuns);
  const focus = useViberon((s) => s.graphFocus);
  const sessionRuns = useUsageStore((s) => s.sessionRuns);
  const tasks = useLinks((s) => s.tasks);
  const entries = useMemoryEntries();
  const session = useUsage("session");
  const conversation = useUsage("conversation");
  // Session counts every run seen live; after a reload only the thread's receipts remain.
  const tokenScope = session.usage.runs > 0 ? session : conversation;

  const node = useMemo(() => graph?.nodes.find((n) => n.id === nodeId), [graph, nodeId]);
  const liveRuns = useMemo(() => (run ? [run, ...runHistory.filter((r) => r.id !== run.id)] : runHistory), [run, runHistory]);

  const touches = useMemo<NodeTouch[]>(() => {
    if (!node) return [];
    const receipts = [...conversationRuns, ...sessionRuns.filter((r) => !conversationRuns.some((c) => c.id === r.id))];
    const fromRuns = runsTouching(node.file, { runs: liveRuns, receipts });
    // Tasks that reported this file but never streamed here.
    const known = new Set(fromRuns.map((t) => t.taskId).filter(Boolean));
    const fromTasks: NodeTouch[] = tasks
      .filter((t) => !known.has(t.id) && t.files?.includes(node.file))
      .map((t) => ({
        kind: "task",
        id: t.id,
        label: t.task.split("\n")[0] ?? t.id,
        role: "changed",
        at: t.finishedAt ?? t.createdAt,
        tokens: 0,
        taskId: t.id,
      }));
    return [...fromRuns, ...fromTasks].sort((a, b) => b.at - a.at);
  }, [node, liveRuns, conversationRuns, sessionRuns, tasks]);

  if (!node) return null;

  const memory = backlinksFor(entries, { file: node.file, symbolId: node.id }, graph ?? null);
  const tokens = tokensFor(tokenScope.usage, node.file, node.id);
  const { name: fileName, dir } = splitPath(node.file);

  function openFile() {
    const store = useViberon.getState();
    store.openTab(node!.file, undefined, { preview: true });
  }

  function showTouch(touch: NodeTouch) {
    const store = useViberon.getState();
    if (touch.kind === "task" && touch.taskId) {
      const task = tasks.find((t) => t.id === touch.taskId) ?? { id: touch.taskId, task: touch.label };
      store.showOnGraph(focusFromTask(task, liveRuns));
      useLinks.getState().setReveal({ kind: "task", id: touch.taskId });
      store.setBottomPanel("tasks");
      return;
    }
    const live = liveRuns.find((r) => r.id === touch.id);
    if (live) {
      store.showOnGraph(focusFromRun(live));
      return;
    }
    const receipt = conversationRuns.find((r) => r.id === touch.id) ?? sessionRuns.find((r) => r.id === touch.id);
    if (receipt) store.showOnGraph(focusFromReceipt(receipt));
  }

  return (
    <aside
      className="pointer-events-auto absolute right-4 top-[84px] flex max-h-[calc(100%-6.5rem)] w-[288px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-[4px]"
      style={{ background: "var(--vb-bg-overlay)", border: "1px solid var(--vb-line)" }}
      aria-label={`${node.name} details`}
    >
      <div className="flex items-start gap-2 border-b px-2.5 py-2" style={{ borderColor: "var(--vb-line)" }}>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate font-mono text-[12.5px] font-medium" style={{ color: "var(--vb-text-hi)" }}>
              {node.name}
            </span>
            <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {node.kind}
            </span>
          </div>
          <button
            type="button"
            onClick={openFile}
            className="flex max-w-full items-center gap-1 truncate font-mono text-[11px] hover:underline"
            style={{ color: "var(--vb-text-dim)" }}
            title={`Open ${node.file}`}
          >
            <FileCode2 className="size-3 shrink-0" />
            <span className="truncate">
              {dir ? `${dir}/` : ""}
              <span style={{ color: "var(--vb-text-mid)" }}>{fileName}</span>:{node.startLine}
            </span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => useViberon.getState().selectNode(undefined)}
          className="rounded-[3px] p-0.5 hover:bg-[var(--vb-hover)]"
          style={{ color: "var(--vb-text-dim)" }}
          aria-label="Close details"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto px-2.5 py-2">
        <section>
          <div className={sectionTitle} style={{ color: "var(--vb-text-dim)" }}>
            Context tokens
            <span style={{ color: "var(--vb-text-faint)" }}>· {tokenScope.scope === "session" ? "this session" : "this conversation"}</span>
          </div>
          <button
            type="button"
            className={rowClass}
            onClick={() => openUsagePanel({ scope: tokenScope.scope, file: node.file })}
            title={`Show ${node.file} in the usage panel`}
          >
            {tokens.fileTokens > 0 || tokens.nodeTokens > 0 ? (
              <span className="flex min-w-0 flex-1 items-baseline gap-2 font-mono text-[11.5px] tabular-nums">
                {tokens.nodeTokens > 0 && <span style={{ color: "var(--vb-text-hi)" }}>{formatTok(tokens.nodeTokens)}</span>}
                {tokens.nodeTokens > 0 && <span style={{ color: "var(--vb-text-faint)" }}>symbol</span>}
                <span style={{ color: "var(--vb-text-hi)" }}>{formatTok(tokens.fileTokens)}</span>
                <span style={{ color: "var(--vb-text-faint)" }}>
                  file · {tokens.fileReads} read{tokens.fileReads === 1 ? "" : "s"}
                </span>
              </span>
            ) : (
              <span className="flex-1" style={{ color: "var(--vb-text-faint)" }}>
                No context sent yet
              </span>
            )}
          </button>
        </section>

        <section>
          <div className={sectionTitle} style={{ color: "var(--vb-text-dim)" }}>
            Runs and tasks
            <span className="font-mono" style={{ color: "var(--vb-text-faint)" }}>
              {touches.length}
            </span>
          </div>
          {touches.length === 0 ? (
            <p className="px-1 text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
              No run has read or changed {fileName} yet.
            </p>
          ) : (
            touches.slice(0, 8).map((touch) => {
              const active = focus && (focus.id === touch.id || focus.id === touch.taskId);
              return (
                <button
                  key={`${touch.kind}:${touch.id}`}
                  type="button"
                  onClick={() => showTouch(touch)}
                  className={cx(rowClass, active && "bg-[var(--vb-active)]")}
                  title={`${touch.label}\n${touch.kind === "task" ? "Show the task and what it touched" : "Show what this run read and changed"}`}
                >
                  <span
                    className="w-[46px] shrink-0 font-mono text-[11px]"
                    style={{ color: touch.role === "changed" ? "var(--vb-amber)" : "var(--vb-add)" }}
                  >
                    {touch.role}
                  </span>
                  <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
                    {touch.label}
                  </span>
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                    {touch.kind === "task" ? "task" : touch.tokens > 0 ? formatTok(touch.tokens) : formatAgo(touch.at)}
                  </span>
                </button>
              );
            })
          )}
        </section>

        <section>
          <div className={sectionTitle} style={{ color: "var(--vb-text-dim)" }}>
            Memory
            <span className="font-mono" style={{ color: "var(--vb-text-faint)" }}>
              {memory.length}
            </span>
          </div>
          {memory.length === 0 ? (
            <p className="px-1 text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
              Nothing remembered about {node.name}.
            </p>
          ) : (
            memory.slice(0, 6).map((entry, i) => (
              <button
                key={entry.id ?? i}
                type="button"
                onClick={() => {
                  const store = useViberon.getState();
                  store.setAppMode("ide");
                  store.setSidebarView("memory");
                }}
                className="flex w-full items-start gap-2 rounded-[3px] px-1 py-1 text-left text-[12px] hover:bg-[var(--vb-hover)]"
                title="Open in Project memory"
              >
                <Brain className="mt-[3px] size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 leading-snug" style={{ color: entry.stale ? "var(--vb-text-dim)" : "var(--vb-text)" }}>
                    {entry.text}
                  </span>
                  <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                    {entry.kind}
                    {entry.stale ? " · may be outdated" : ""}
                  </span>
                </span>
              </button>
            ))
          )}
        </section>
      </div>
    </aside>
  );
}

export default GraphNodePanel;

/**
 * Graph focus: what a run, task or file touched, projected onto the code
 * graph, and the reverse lookup (what touched a graph node).
 *
 * Pure. Built from data the store already holds: the ledger's per-file and
 * per-node attribution (what an agent read), `file_change` records and
 * stored receipts (what it changed), and usage summaries (tokens).
 */

import type { Graph } from "@/lib/graph";
import type { StoredRun } from "@/lib/client/conversations";
import type { RunState } from "@/lib/client/run-reducer";
import type { UsageSummary } from "@/lib/client/usage";

export type GraphFocusKind = "run" | "task" | "file";

export interface GraphFocus {
  kind: GraphFocusKind;
  /** Run id, task id or file path. */
  id: string;
  label: string;
  /** Files whose content went into a prompt. */
  read: string[];
  /** Files the run wrote (reverted edits excluded). */
  changed: string[];
  /** Graph node ids the ledger attributed context to. */
  nodeIds: string[];
}

const uniq = (values: Iterable<string>): string[] => [...new Set([...values].filter(Boolean))];

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? text).trim().slice(0, 120);
}

/** A live or finished run in memory: ledger attribution plus file changes. */
export function focusFromRun(run: RunState): GraphFocus {
  const ledger = run.ledger;
  const read = uniq([
    ...(ledger?.files ?? []).map((f) => f.path),
    ...(ledger?.events ?? []).flatMap((e) => e.paths ?? []),
  ]);
  const nodeIds = uniq([
    ...(ledger?.nodes ?? []).map((n) => n.id),
    ...(ledger?.events ?? []).flatMap((e) => e.nodeIds ?? []),
  ]);
  const changed = uniq(run.changes.filter((c) => !c.reverted).map((c) => c.path));
  return { kind: "run", id: run.id, label: firstLine(run.prompt), read, changed, nodeIds };
}

/** A stored receipt (a run from an earlier session). */
export function focusFromReceipt(receipt: StoredRun): GraphFocus {
  const usage = receipt.usage;
  return {
    kind: "run",
    id: receipt.id,
    label: firstLine(receipt.prompt),
    read: uniq((usage?.files ?? []).map((f) => f.key)),
    changed: uniq(receipt.filesChanged),
    nodeIds: uniq((usage?.nodes ?? []).map((n) => n.key)),
  };
}

/** A task: the run it streamed into this session, else the files it reported. */
export function focusFromTask(
  task: { id: string; task: string; files?: string[] },
  runs: readonly RunState[],
): GraphFocus {
  const run = runs.find((r) => r.taskId === task.id);
  const base = run ? focusFromRun(run) : null;
  return {
    kind: "task",
    id: task.id,
    label: firstLine(task.task),
    read: base?.read ?? [],
    changed: uniq([...(base?.changed ?? []), ...(task.files ?? [])]),
    nodeIds: base?.nodeIds ?? [],
  };
}

export function focusFromFile(path: string): GraphFocus {
  const name = path.split("/").pop() || path;
  return { kind: "file", id: path, label: name, read: [], changed: [path], nodeIds: [] };
}

/** Whether a focus has anything to draw. */
export function focusIsEmpty(focus: GraphFocus): boolean {
  return focus.read.length === 0 && focus.changed.length === 0 && focus.nodeIds.length === 0;
}

/**
 * Graph node ids a focus lights: `changed` holds every symbol in a changed
 * file; `read` holds attributed nodes and symbols of read files, minus
 * anything already in `changed` (a write outranks a read).
 */
export function focusNodes(
  focus: GraphFocus,
  graph: Pick<Graph, "nodes"> | null | undefined,
): { read: Set<string>; changed: Set<string> } {
  const changedFiles = new Set(focus.changed);
  const readFiles = new Set(focus.read);
  const changed = new Set<string>();
  const read = new Set<string>();
  const known = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    known.add(node.id);
    if (changedFiles.has(node.file)) changed.add(node.id);
    else if (readFiles.has(node.file)) read.add(node.id);
  }
  for (const id of focus.nodeIds) {
    if (known.has(id) && !changed.has(id)) read.add(id);
  }
  return { read, changed };
}

/* ------------------------------ reverse lookup ----------------------------- */

export interface NodeTouch {
  kind: GraphFocusKind;
  id: string;
  label: string;
  /** What the run did with this node's file. */
  role: "changed" | "read";
  at: number;
  /** Tokens attributed to this node's file in that run, when known. */
  tokens: number;
  taskId?: string;
}

/** Tokens attributed to a file (and to one symbol of it) in a usage summary. */
export function tokensFor(
  usage: Pick<UsageSummary, "files" | "nodes">,
  file: string | undefined,
  nodeId?: string,
): { fileTokens: number; fileReads: number; nodeTokens: number; nodeReads: number } {
  const f = file ? usage.files.find((s) => s.key === file) : undefined;
  const n = nodeId ? usage.nodes.find((s) => s.key === nodeId) : undefined;
  return {
    fileTokens: Math.round(f?.sentTokens ?? 0),
    fileReads: f?.reads ?? 0,
    nodeTokens: Math.round(n?.sentTokens ?? 0),
    nodeReads: n?.reads ?? 0,
  };
}

/**
 * Runs that read or changed a file, newest first. Live runs (with ledgers)
 * win over their stored receipts; receipts cover earlier sessions.
 */
export function runsTouching(
  file: string,
  input: { runs: readonly RunState[]; receipts: readonly StoredRun[] },
): NodeTouch[] {
  const out: NodeTouch[] = [];
  const seen = new Set<string>();
  for (const run of input.runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const focus = focusFromRun(run);
    const changed = focus.changed.includes(file);
    const read = focus.read.includes(file);
    if (!changed && !read) continue;
    const stat = run.ledger?.files?.find((f) => f.path === file);
    out.push({
      kind: run.taskId ? "task" : "run",
      id: run.taskId ?? run.id,
      label: focus.label,
      role: changed ? "changed" : "read",
      at: run.startedAt,
      tokens: Math.round(stat?.sentTokens ?? 0),
      ...(run.taskId ? { taskId: run.taskId } : {}),
    });
  }
  for (const receipt of input.receipts) {
    if (seen.has(receipt.id)) continue;
    seen.add(receipt.id);
    const changed = receipt.filesChanged.includes(file);
    const stat = receipt.usage?.files.find((f) => f.key === file);
    if (!changed && !stat) continue;
    out.push({
      kind: "run",
      id: receipt.id,
      label: firstLine(receipt.prompt),
      role: changed ? "changed" : "read",
      at: receipt.startedAt,
      tokens: Math.round(stat?.sentTokens ?? 0),
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

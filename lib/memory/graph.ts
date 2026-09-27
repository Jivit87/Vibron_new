/**
 * Graph-anchored project memory.
 *
 * Every fact, decision, convention, summary and run record is attached to
 * graph nodes (symbol ids) or file paths, and remembers the content hash of
 * each anchor at the time it was written. When an anchor's code changes the
 * entry turns `stale` and is rendered "(may be outdated)" — so nothing the
 * model once believed persists silently after the code moved on.
 *
 * Storage: `<root>/.viberon/memory.json`, canonical, rendered after every
 * write as an Obsidian vault in `<root>/.viberon/vault/` (lib/memory/vault.ts).
 * The vault is two-way: a note edited there (mtime newer than its entry) or
 * a new note dropped into `notes/` is imported on the next read. (git-excluded, never in a diff).
 * Roots that are not absolute paths (store workspaces) stay in-process.
 * The API is synchronous on purpose: it is read while building prompts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { GraphNode } from "@/lib/graph";
import type { MemoryEntryKind, ProjectMemory } from "@/lib/memory/types";
import {
  readVaultNotes,
  renderVault,
  updatedOf,
  vaultGraphOf,
  vaultPath,
  type VaultGraph,
} from "@/lib/memory/vault";
import { hashSource } from "@/lib/parser";
import { loadGraphIndexSync, type GraphIndexDoc } from "@/lib/workspace/graph-index";

export const MEMORY_GRAPH_VERSION = 1;

/**
 * `fix`: what a solve run changed and why; `lesson`: why an attempt was NOT
 * accepted (lib/memory/lessons.ts); `note`: written by hand in the vault;
 * `run`: legacy fix records.
 */
export type AnchoredKind = MemoryEntryKind | "fix" | "lesson" | "note" | "run" | "summary";

const VAULT_KINDS = new Set<string>(["decision", "fact", "suggestion", "convention", "fix", "lesson", "note"]);

export interface MemoryAnchor {
  /** What the caller passed: a graph node id or a repo-relative path. */
  ref: string;
  /** Repo-relative file the anchor lives in ("" when unresolved). */
  path: string;
  /** Symbol name for node anchors; lets us re-find a node whose id moved. */
  name?: string;
  /** Content hash of the node snippet / file when the entry was written. */
  hash: string;
}

export interface AnchoredEntry {
  id: string;
  kind: AnchoredKind;
  text: string;
  anchors: MemoryAnchor[];
  evidence?: string;
  createdAt: number;
  /** Last change (defaults to createdAt); vault notes carry it as their mtime. */
  updatedAt?: number;
  /** Vault note name (`notes/<slug>.md`), stable once assigned. */
  slug?: string;
  /** An anchor's content changed (or vanished) since this was written. */
  stale: boolean;
}

export interface AnchoredSummary {
  ref: string;
  text: string;
  anchor: MemoryAnchor;
  updatedAt: number;
  stale: boolean;
}

export interface RunRecord {
  id: string;
  issue: string;
  filesChanged: string[];
  rootCause: string;
  verified: boolean;
  at: number;
}

export interface MemoryGraph {
  version: number;
  entries: AnchoredEntry[];
  summaries: Record<string, AnchoredSummary>;
  runs: RunRecord[];
}

const MAX_ENTRIES = 400;
const MAX_RUNS = 50;

const cache = ((globalThis as { __viberonMemoryGraphs?: Map<string, MemoryGraph> })
  .__viberonMemoryGraphs ??= new Map<string, MemoryGraph>());

function isDiskRoot(root: string): boolean {
  return path.isAbsolute(root);
}

function memoryFile(root: string): string {
  return path.join(root, ".viberon", "memory.json");
}

function emptyGraph(): MemoryGraph {
  return { version: MEMORY_GRAPH_VERSION, entries: [], summaries: {}, runs: [] };
}

function load(root: string): MemoryGraph {
  const key = isDiskRoot(root) ? path.resolve(root) : root;
  const cached = cache.get(key);
  if (cached) return cached;
  let graph = emptyGraph();
  if (isDiskRoot(root)) {
    try {
      const file = memoryFile(root);
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as MemoryGraph;
        if (parsed.version === MEMORY_GRAPH_VERSION) graph = { ...emptyGraph(), ...parsed };
      }
    } catch {
      // Corrupt file: start fresh rather than break prompt building.
    }
  }
  cache.set(key, graph);
  return graph;
}

/** Bumped on every write, so derived views (lessons notes) can memoize cheaply. */
const revisions = new Map<string, number>();

function rootKey(root: string): string {
  return isDiskRoot(root) ? path.resolve(root) : root;
}

/** Monotonic per-root write counter (in-process). */
export function memoryRevision(root: string): number {
  return revisions.get(rootKey(root)) ?? 0;
}

function save(root: string, graph: MemoryGraph): void {
  revisions.set(rootKey(root), memoryRevision(root) + 1);
  if (!isDiskRoot(root)) return;
  try {
    const file = memoryFile(root);
    mkdirSync(path.dirname(file), { recursive: true });
    // Render first: it assigns slugs, which are persisted with the entries.
    renderVault(root, graph.entries, (rel) => (indexFor(root)?.files[rel]?.nodes ?? []).map((n) => n.name));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(graph, null, 1));
    renameSync(tmp, file);
  } catch {
    // Read-only workspace: memory still works for this process.
  }
}

/**
 * Import human edits from the vault: a note newer than its entry replaces
 * the entry's text/anchors/kind; an unknown note becomes a new entry.
 * Returns whether anything changed.
 */
function syncFromVault(root: string, graph: MemoryGraph): boolean {
  if (!isDiskRoot(root)) return false;
  const notes = readVaultNotes(root);
  if (!notes.length) return false;
  const doc = indexFor(root);
  const byId = new Map(graph.entries.map((e) => [e.id, e] as const));
  const bySlug = new Map(graph.entries.filter((e) => e.slug).map((e) => [e.slug!, e] as const));
  const anchorsOf = (refs: string[]) =>
    [...new Set(refs.map(normalizeRef).filter(Boolean))].map((ref) => resolveAnchor(root, ref, doc));
  let changed = false;
  for (const note of notes) {
    const entry = (note.id ? byId.get(note.id) : undefined) ?? bySlug.get(note.slug);
    const kind = note.kind && VAULT_KINDS.has(note.kind) ? (note.kind as AnchoredKind) : undefined;
    if (entry) {
      if (note.mtimeMs <= updatedOf(entry) + 1) continue;
      entry.text = note.text;
      if (kind) entry.kind = kind;
      if (note.anchors.join("\n") !== entry.anchors.map((a) => a.ref).join("\n")) entry.anchors = anchorsOf(note.anchors);
      entry.updatedAt = Math.ceil(note.mtimeMs);
      entry.stale = false;
    } else {
      const at = Math.ceil(note.mtimeMs);
      graph.entries.push({
        id: note.id ?? newId("not"),
        kind: kind ?? "note",
        text: note.text,
        anchors: anchorsOf(note.anchors),
        createdAt: at,
        updatedAt: at,
        slug: note.slug,
        stale: false,
      });
    }
    changed = true;
  }
  return changed;
}

/* ------------------------------ anchors ---------------------------------- */

const nodeIndexCache = new WeakMap<GraphIndexDoc, Map<string, GraphNode>>();

function nodesById(doc: GraphIndexDoc | null): Map<string, GraphNode> {
  if (!doc) return new Map();
  let index = nodeIndexCache.get(doc);
  if (!index) {
    index = new Map();
    for (const extract of Object.values(doc.files)) {
      for (const node of extract.nodes) index.set(node.id, node);
    }
    nodeIndexCache.set(doc, index);
  }
  return index;
}

function fileHash(root: string, relPath: string, doc: GraphIndexDoc | null): string | null {
  if (isDiskRoot(root)) {
    try {
      return hashSource(readFileSync(path.join(root, relPath), "utf8"));
    } catch {
      return null;
    }
  }
  return doc?.files[relPath]?.hash ?? null;
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/^\.\//, "").replace(/\\/g, "/");
}

function resolveAnchor(root: string, rawRef: string, doc: GraphIndexDoc | null): MemoryAnchor {
  const ref = normalizeRef(rawRef);
  const node = nodesById(doc).get(ref);
  if (node) return { ref, path: node.file, name: node.name, hash: hashSource(node.snippet) };
  const hash = fileHash(root, ref, doc);
  return { ref, path: hash === null && !ref.includes("/") && !ref.includes(".") ? "" : ref, hash: hash ?? "" };
}

/** Hash the anchor's code has now, or null when it no longer exists. */
function currentHash(root: string, anchor: MemoryAnchor, doc: GraphIndexDoc | null): string | null {
  if (anchor.name) {
    const byId = nodesById(doc).get(anchor.ref);
    if (byId) return hashSource(byId.snippet);
    // Lines shifted → new id; re-find the symbol by file + name.
    const moved = doc?.files[anchor.path]?.nodes.find((n) => n.name === anchor.name);
    return moved ? hashSource(moved.snippet) : null;
  }
  if (!anchor.path) return anchor.hash || null;
  return fileHash(root, anchor.path, doc);
}

function isStale(root: string, anchors: MemoryAnchor[], doc: GraphIndexDoc | null): boolean {
  // Store workspaces without an index cannot be checked; never guess stale.
  if (!isDiskRoot(root) && !doc) return false;
  return anchors.some((anchor) => anchor.hash !== "" && currentHash(root, anchor, doc) !== anchor.hash);
}

function indexFor(root: string): GraphIndexDoc | null {
  return isDiskRoot(root) ? loadGraphIndexSync(root) : null;
}

function refreshStaleness(root: string, graph: MemoryGraph): boolean {
  const doc = indexFor(root);
  let changed = false;
  for (const entry of graph.entries) {
    const stale = isStale(root, entry.anchors, doc);
    if (stale !== entry.stale) changed = true;
    entry.stale = stale;
  }
  for (const summary of Object.values(graph.summaries)) {
    summary.stale = isStale(root, [summary.anchor], doc);
  }
  return changed;
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* -------------------------------- API ------------------------------------ */

/** The whole memory graph: vault edits imported, staleness recomputed against current code. */
export function getMemoryGraph(root: string): MemoryGraph {
  const graph = load(root);
  const imported = syncFromVault(root, graph);
  if (refreshStaleness(root, graph) || imported) save(root, graph);
  return graph;
}

/**
 * Record a fact/decision/convention/suggestion (or run) anchored to node ids
 * or paths. The same text re-recorded refreshes its anchors instead of
 * duplicating.
 */
export function addEntry(
  root: string,
  input: { kind: AnchoredKind; text: string; anchors: string[]; evidence?: string },
): AnchoredEntry {
  const graph = load(root);
  const doc = indexFor(root);
  const text = input.text.trim();
  const anchors = [...new Set(input.anchors.map(normalizeRef).filter(Boolean))].map((ref) =>
    resolveAnchor(root, ref, doc),
  );
  const normalized = text.toLowerCase().replace(/\s+/g, " ");
  const existing = graph.entries.find(
    (e) => e.kind === input.kind && e.text.toLowerCase().replace(/\s+/g, " ") === normalized,
  );
  if (existing) {
    existing.anchors = anchors.length ? anchors : existing.anchors;
    existing.evidence = input.evidence ?? existing.evidence;
    existing.createdAt = Date.now();
    existing.updatedAt = existing.createdAt;
    existing.stale = false;
    save(root, graph);
    return existing;
  }
  const entry: AnchoredEntry = {
    id: newId(input.kind.slice(0, 3)),
    kind: input.kind,
    text,
    anchors,
    evidence: input.evidence,
    createdAt: Date.now(),
    stale: false,
  };
  graph.entries.push(entry);
  if (graph.entries.length > MAX_ENTRIES) {
    refreshStaleness(root, graph);
    // Evict stale entries first, then the oldest.
    graph.entries.sort((a, b) => Number(b.stale) - Number(a.stale) || a.createdAt - b.createdAt);
    graph.entries.splice(0, graph.entries.length - MAX_ENTRIES);
    graph.entries.sort((a, b) => a.createdAt - b.createdAt);
  }
  save(root, graph);
  return entry;
}

export function removeEntry(root: string, id: string): boolean {
  const graph = load(root);
  const before = graph.entries.length;
  graph.entries = graph.entries.filter((e) => e.id !== id);
  if (graph.entries.length === before) return false;
  save(root, graph);
  return true;
}

/** Cached summary of a symbol or file; `stale` when its code changed since. */
export function summaryFor(root: string, nodeIdOrPath: string): { text: string; stale: boolean } | null {
  const graph = load(root);
  const summary = graph.summaries[normalizeRef(nodeIdOrPath)];
  if (!summary) return null;
  summary.stale = isStale(root, [summary.anchor], indexFor(root));
  return { text: summary.text, stale: summary.stale };
}

export function setSummary(root: string, nodeIdOrPath: string, text: string): void {
  const graph = load(root);
  const ref = normalizeRef(nodeIdOrPath);
  graph.summaries[ref] = {
    ref,
    text: text.trim(),
    anchor: resolveAnchor(root, ref, indexFor(root)),
    updatedAt: Date.now(),
    stale: false,
  };
  save(root, graph);
}

/**
 * Entries most relevant to a set of nodes (ids or paths): exact anchor
 * match > same file > same directory. Stale entries rank lower and carry
 * `stale: true` so callers render them "(may be outdated)".
 */
export function relevantEntries(root: string, nodeIds: string[], limit = 8): AnchoredEntry[] {
  const graph = load(root);
  if (syncFromVault(root, graph)) save(root, graph);
  const doc = indexFor(root);
  const byId = nodesById(doc);
  const refs = new Set(nodeIds.map(normalizeRef));
  const paths = new Set<string>();
  for (const ref of refs) paths.add(byId.get(ref)?.file ?? ref);
  const dirs = new Set([...paths].map((p) => path.posix.dirname(p)));

  const scored: { entry: AnchoredEntry; score: number }[] = [];
  for (const entry of graph.entries) {
    let score = 0;
    for (const anchor of entry.anchors) {
      if (refs.has(anchor.ref)) score = Math.max(score, 3);
      else if (anchor.path && paths.has(anchor.path)) score = Math.max(score, 2);
      else if (anchor.path && dirs.has(path.posix.dirname(anchor.path))) score = Math.max(score, 0.5);
    }
    if (score === 0) continue;
    entry.stale = isStale(root, entry.anchors, doc);
    scored.push({ entry, score: entry.stale ? score / 2 : score });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.entry.createdAt - a.entry.createdAt)
    .slice(0, limit)
    .map((s) => s.entry);
}

/**
 * After a solve: one `fix` note (the issue, the root cause from the agent's
 * finish summary, the files, and whether a check proved it) anchored to the
 * changed files, so the next task on the same area recalls it.
 */
export function recordFixNote(
  root: string,
  input: { issue: string; rootCause: string; files: string[]; verified: boolean },
): AnchoredEntry {
  const graph = load(root);
  const title = input.issue.trim().split(/\r?\n/)[0]!.replace(/^#+\s*/, "").slice(0, 100);
  const record: RunRecord = {
    id: newId("run"),
    issue: title,
    filesChanged: input.files,
    rootCause: input.rootCause.trim().slice(0, 400),
    verified: input.verified,
    at: Date.now(),
  };
  graph.runs.push(record);
  if (graph.runs.length > MAX_RUNS) graph.runs.splice(0, graph.runs.length - MAX_RUNS);
  return addEntry(root, {
    kind: "fix",
    text: `Past fix (${input.verified ? "verified" : "unverified"}): ${title}${
      record.rootCause ? ` — ${record.rootCause}` : ""
    }`,
    anchors: input.files,
    evidence: input.verified ? "tests passed after the change" : undefined,
  });
}

/**
 * Past fixes relevant to a task, as lessons: `fix` notes anchored to the
 * candidate files first, then ones sharing words with the task.
 */
export function relevantLessons(root: string, input: { files: string[]; task: string }, limit = 3): string[] {
  const graph = load(root);
  if (syncFromVault(root, graph)) save(root, graph);
  const fixes = graph.entries.filter((e) => e.kind === "fix" || e.kind === "run");
  if (!fixes.length) return [];
  const doc = indexFor(root);
  const files = new Set(input.files.map(normalizeRef));
  const dirs = new Set([...files].map((f) => path.posix.dirname(f)));
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []);
  const taskWords = words(input.task);
  return fixes
    .map((entry) => {
      let score = 0;
      for (const a of entry.anchors) {
        if (files.has(a.path)) score = Math.max(score, 3);
        else if (a.path && dirs.has(path.posix.dirname(a.path))) score = Math.max(score, 1);
      }
      let overlap = 0;
      for (const w of words(entry.text)) if (taskWords.has(w)) overlap += 1;
      return { entry, score: score + Math.min(overlap, 6) * 0.5 };
    })
    .filter((s) => s.score >= 1.5)
    .sort((a, b) => b.score - a.score || updatedOf(b.entry) - updatedOf(a.entry))
    .slice(0, limit)
    .map(({ entry }) => `${entry.text}${isStale(root, entry.anchors, doc) ? " (may be outdated)" : ""}`);
}

/**
 * `fix` / `run` / `lesson` entries scored against a task (anchor match on
 * the candidate files > same directory, plus shared task words), with
 * staleness recomputed. Used by lib/memory/lessons.ts.
 */
export function scoredLessonEntries(
  root: string,
  input: { files: string[]; task: string },
): { entry: AnchoredEntry; score: number }[] {
  const graph = load(root);
  if (syncFromVault(root, graph)) save(root, graph);
  const pool = graph.entries.filter((e) => e.kind === "fix" || e.kind === "run" || e.kind === "lesson");
  if (!pool.length) return [];
  const doc = indexFor(root);
  const files = new Set(input.files.map(normalizeRef));
  const dirs = new Set([...files].map((f) => path.posix.dirname(f)));
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? []);
  const taskWords = words(input.task);
  const out: { entry: AnchoredEntry; score: number }[] = [];
  for (const entry of pool) {
    let score = 0;
    for (const a of entry.anchors) {
      if (files.has(a.path)) score = Math.max(score, 3);
      else if (a.path && dirs.has(path.posix.dirname(a.path))) score = Math.max(score, 1);
    }
    let overlap = 0;
    for (const w of words(entry.text)) if (taskWords.has(w)) overlap += 1;
    score += Math.min(overlap, 6) * 0.5;
    if (score < 1.5) continue;
    entry.stale = isStale(root, entry.anchors, doc);
    out.push({ entry, score });
  }
  return out.sort((a, b) => b.score - a.score || updatedOf(b.entry) - updatedOf(a.entry));
}

/** The vault as a graph for the UI: note nodes linked to code nodes. */
export function vaultGraph(root: string): VaultGraph {
  return vaultGraphOf(getMemoryGraph(root).entries);
}

export function vaultInfo(root: string): { path: string; notes: number } {
  return { path: vaultPath(root), notes: getMemoryGraph(root).entries.length };
}

/** One line per entry, for prompts. */
export function renderAnchoredEntries(entries: AnchoredEntry[]): string {
  return entries
    .map((e) => {
      const where = e.anchors.map((a) => a.path || a.ref).filter(Boolean).slice(0, 3).join(", ");
      return `- [${e.kind}] ${e.text}${where ? ` (${where})` : ""}${e.stale ? " (may be outdated)" : ""}`;
    })
    .join("\n");
}

/**
 * Carry learned entries from the store-backed `ProjectMemory` (the older
 * format the UI edits) into the anchored graph. Idempotent: same text dedupes.
 */
export function importLegacyEntries(root: string, memory: ProjectMemory): number {
  let imported = 0;
  const graph = load(root);
  const known = new Set(graph.entries.map((e) => `${e.kind}:${e.text.toLowerCase()}`));
  for (const entry of [...memory.conventions, ...memory.decisions, ...memory.facts]) {
    if (entry.resolved || known.has(`${entry.kind}:${entry.text.toLowerCase()}`)) continue;
    addEntry(root, { kind: entry.kind, text: entry.text, anchors: entry.files ?? [], evidence: entry.why });
    imported += 1;
  }
  return imported;
}

/** Drop the in-process cache (tests). */
export function clearMemoryGraphCache(): void {
  cache.clear();
  // `revisions` stays monotonic on purpose: a reset to 0 could match an old memo key.
}

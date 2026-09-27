/**
 * Cached, time-sliced lexical indexes for localization.
 *
 * Tokenizing every file of a 3000-file repo is hundreds of ms of CPU; done in
 * one synchronous pass it froze the server (a Stop request could not land).
 * Here the work is:
 *
 *  - cached by content: a file's term frequencies are keyed by a hash of its
 *    text, so a second localize on the same repo (or on a sibling issue
 *    worktree with the same files) re-tokenizes nothing, and a per-root
 *    `(mtime, size)` table skips even the read for unchanged files;
 *  - time-sliced with `lib/workers/yield` so what is left never blocks the
 *    event loop for more than one slice, and it stops on abort.
 *
 * Two indexes: files (BM25 over path + text) and symbols (BM25 over a
 * symbol's name words + its docstring/JSDoc), the latter cached per graph.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Graph, GraphNode } from "@/lib/graph";
import { timeSlicer } from "@/lib/workers/yield";

export type Tokenizer = (text: string) => string[];

export interface DocTerms {
  tf: Map<string, number>;
  len: number;
}

const MAX_FILE_BYTES = 400_000;
const CONTENT_CACHE_MAX = 40_000;
const ROOTS_MAX = 8;
const IO_BATCH = 128;

/** content hash → term frequencies (shared across roots/worktrees). */
const contentCache = new Map<string, DocTerms>();
/** root → rel → last seen stat + content hash. */
const statCache = new Map<string, Map<string, { mtimeMs: number; size: number; hash: string }>>();

function terms(tokens: string[]): DocTerms {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return { tf, len: tokens.length };
}

function remember(hash: string, doc: DocTerms): void {
  if (contentCache.size >= CONTENT_CACHE_MAX) {
    // Drop the oldest eighth (Map keeps insertion order).
    let drop = CONTENT_CACHE_MAX >> 3;
    for (const key of contentCache.keys()) {
      contentCache.delete(key);
      if ((drop -= 1) <= 0) break;
    }
  }
  contentCache.set(hash, doc);
}

function rootTable(root: string) {
  let table = statCache.get(root);
  if (table) {
    statCache.delete(root);
    statCache.set(root, table);
    return table;
  }
  table = new Map();
  statCache.set(root, table);
  while (statCache.size > ROOTS_MAX) statCache.delete(statCache.keys().next().value!);
  return table;
}

/** A cheap identity for `files` under `root` as last indexed by `fileTerms`. */
export function contentSignature(root: string, files: string[]): string {
  const table = statCache.get(root);
  const h = createHash("sha1");
  for (const rel of files) h.update(`${rel}\0${table?.get(rel)?.hash ?? "?"}\n`);
  return h.digest("base64");
}

/** Test seam. */
export function clearLexicalCache(): void {
  contentCache.clear();
  statCache.clear();
  symbolIndexes = new WeakMap();
}

/**
 * Term frequencies for every readable file (content only; path words are
 * added at scoring time since the content cache is shared across paths).
 */
export async function fileTerms(
  root: string,
  files: string[],
  tokenize: Tokenizer,
  signal?: AbortSignal,
): Promise<Map<string, DocTerms>> {
  const tick = timeSlicer();
  const table = rootTable(root);
  const out = new Map<string, DocTerms>();
  for (let i = 0; i < files.length; i += IO_BATCH) {
    const batch = files.slice(i, i + IO_BATCH);
    const loaded = await Promise.all(
      batch.map(async (rel) => {
        try {
          const abs = path.join(root, rel);
          const st = await stat(abs);
          if (st.size > MAX_FILE_BYTES) return null;
          const prev = table.get(rel);
          if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && contentCache.has(prev.hash)) {
            return { rel, hash: prev.hash, text: null as string | null };
          }
          const text = await readFile(abs, "utf8");
          const hash = createHash("sha1").update(text).digest("base64");
          table.set(rel, { mtimeMs: st.mtimeMs, size: st.size, hash });
          return { rel, hash, text };
        } catch {
          return null; // Unreadable: skip.
        }
      }),
    );
    for (const item of loaded) {
      if (!item) continue;
      await tick(signal);
      let doc = contentCache.get(item.hash);
      if (!doc && item.text !== null) {
        doc = terms(tokenize(item.text));
        remember(item.hash, doc);
      }
      if (doc) out.set(item.rel, doc);
    }
  }
  return out;
}

/** BM25 of `queryTokens` against the indexed files (path words count as text). */
export async function bm25Files(
  queryTokens: string[],
  docs: Map<string, DocTerms>,
  tokenize: Tokenizer,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const q = new Map<string, number>();
  for (const t of queryTokens) q.set(t, (q.get(t) ?? 0) + 1);
  if (!q.size || !docs.size) return scores;
  const tick = timeSlicer();
  const pathTf = new Map<string, Map<string, number>>();
  const lens = new Map<string, number>();
  const df = new Map<string, number>();
  let total = 0;
  for (const [rel, doc] of docs) {
    await tick(signal);
    const words = tokenize(rel.replace(/\//g, " "));
    const ptf = new Map<string, number>();
    for (const w of words) if (q.has(w)) ptf.set(w, (ptf.get(w) ?? 0) + 1);
    pathTf.set(rel, ptf);
    lens.set(rel, doc.len + words.length);
    total += doc.len + words.length;
    for (const t of q.keys()) if (doc.tf.has(t) || ptf.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const n = docs.size;
  const avg = total / n || 1;
  const k1 = 1.2;
  const b = 0.75;
  for (const [rel, doc] of docs) {
    await tick(signal);
    const dl = lens.get(rel) || 1;
    const ptf = pathTf.get(rel)!;
    let s = 0;
    for (const [t, qf] of q) {
      const f = (doc.tf.get(t) ?? 0) + (ptf.get(t) ?? 0);
      if (!f) continue;
      const d = df.get(t) ?? 0;
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      s += ((idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * dl) / avg))) * (1 + Math.log(qf));
    }
    if (s > 0) scores.set(rel, s);
  }
  return scores;
}

/* ------------------------------ symbols --------------------------------- */

interface SymbolIndex {
  nodes: GraphNode[];
  docs: DocTerms[];
  df: Map<string, number>;
  avg: number;
}

let symbolIndexes = new WeakMap<Graph, SymbolIndex>();

/** The docstring (Python) or JSDoc (JS/TS) of a symbol, from its snippet. */
export function docstringOf(snippet: string): string {
  const head = snippet.slice(0, 600);
  const py = /^[^\n]*:\s*\n\s*(?:[rbuRBU]{0,2})("""|''')([\s\S]*?)\1/.exec(head);
  if (py) return py[2].slice(0, 240);
  const js = /\/\*\*([\s\S]*?)\*\//.exec(head);
  return js ? js[1].slice(0, 240).replace(/^\s*\*/gm, "") : "";
}

async function symbolIndex(graph: Graph, tokenize: Tokenizer, skip: RegExp, signal?: AbortSignal): Promise<SymbolIndex> {
  const cached = symbolIndexes.get(graph);
  if (cached) return cached;
  const tick = timeSlicer();
  const nodes: GraphNode[] = [];
  const docs: DocTerms[] = [];
  const df = new Map<string, number>();
  let total = 0;
  for (const node of graph.nodes) {
    await tick(signal);
    if (skip.test(node.file)) continue;
    // Name words weigh double: they are what an issue quotes.
    const name = node.name.split(".").pop() ?? node.name;
    const toks = tokenize(`${name} ${name} ${node.name.replace(/\./g, " ")} ${docstringOf(node.snippet)}`);
    const doc = terms(toks);
    nodes.push(node);
    docs.push(doc);
    total += doc.len;
    for (const t of doc.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const index = { nodes, docs, df, avg: total / (nodes.length || 1) || 1 };
  symbolIndexes.set(graph, index);
  return index;
}

/** Top symbols by BM25 over name words + docstring. */
export async function bm25Symbols(
  graph: Graph,
  queryTokens: string[],
  tokenize: Tokenizer,
  skip: RegExp,
  limit: number,
  signal?: AbortSignal,
): Promise<{ node: GraphNode; score: number }[]> {
  const q = new Map<string, number>();
  for (const t of queryTokens) q.set(t, (q.get(t) ?? 0) + 1);
  if (!q.size || !graph.nodes.length) return [];
  const index = await symbolIndex(graph, tokenize, skip, signal);
  const n = index.nodes.length || 1;
  const idf = new Map<string, number>();
  for (const t of q.keys()) {
    const d = index.df.get(t) ?? 0;
    if (d) idf.set(t, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
  }
  if (!idf.size) return [];
  const tick = timeSlicer();
  const k1 = 1.2;
  const b = 0.75;
  const out: { node: GraphNode; score: number }[] = [];
  for (let i = 0; i < index.nodes.length; i += 1) {
    if ((i & 1023) === 0) await tick(signal);
    const doc = index.docs[i];
    let s = 0;
    for (const [t, w] of idf) {
      const f = doc.tf.get(t);
      if (!f) continue;
      s += ((w * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * doc.len) / index.avg))) * (1 + Math.log(q.get(t)!));
    }
    if (s > 0) out.push({ node: index.nodes[i], score: s });
  }
  return out.sort((a, b2) => b2.score - a.score).slice(0, limit);
}

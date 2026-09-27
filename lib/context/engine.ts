/**
 * The graph context engine — progressive disclosure over a code graph.
 *
 * The premise: an agent should almost never read a whole file. It should
 * navigate a *map* of the codebase and pull only the symbols it needs. That
 * is both cheaper and more accurate, because a 30-symbol graph slice with
 * real call/import edges beats 40k tokens of unstructured source.
 *
 * Four levels, cheapest first. Agents are told to climb only as far as the
 * task requires, and the tool descriptions push them down the ladder:
 *
 *   L0  skeleton      folder tree + entry points + stack       ~300 tokens
 *   L1  symbol index  every file → its exported symbols        ~1–3k tokens
 *   L2  graph slice   BFS from query seeds, signatures+bodies  ~1–4k tokens
 *   L3  file window   an explicit line range of one file       on demand
 *
 * Everything routes through a `ContextLedger`, so repeated requests collapse
 * to pointers and the savings are measured rather than asserted.
 */

import type { Graph, GraphNode, StoredFileInfo } from "@/lib/graph";
import type { ProjectMemory } from "@/lib/memory/types";
import { selectContext, tokenize as retrievalTokenize } from "@/lib/retrieval";
import { countTokens } from "@/lib/tokens";
import { ContextLedger } from "@/lib/context/ledger";

export { ContextLedger };
export type { LedgerSnapshot } from "@/lib/context/ledger";

export interface EngineInput {
  graph: Graph | null;
  memory: ProjectMemory;
  fileInfo: StoredFileInfo[];
  readFile: (path: string) => Promise<string | null>;
  ledger: ContextLedger;
}

/* ------------------------------- L0 ------------------------------------- */

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  files: { name: string; tokens: number }[];
}

function buildTree(paths: { path: string; tokens: number }[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map(), files: [] };
  for (const { path, tokens } of paths) {
    const segments = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const seg = segments[i];
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, children: new Map(), files: [] };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.files.push({ name: segments[segments.length - 1] ?? path, tokens });
  }
  return root;
}

function renderTree(
  node: TreeNode,
  depth: number,
  maxDepth: number,
  maxFilesPerDir: number,
  out: string[],
): void {
  const indent = "  ".repeat(depth);
  const dirs = [...node.children.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  for (const dir of dirs) {
    const total = countFiles(dir);
    if (depth >= maxDepth) {
      out.push(`${indent}${dir.name}/ (${total} files)`);
      continue;
    }
    out.push(`${indent}${dir.name}/`);
    renderTree(dir, depth + 1, maxDepth, maxFilesPerDir, out);
  }

  const files = node.files.sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files.slice(0, maxFilesPerDir)) {
    out.push(`${indent}${file.name}`);
  }
  if (files.length > maxFilesPerDir) {
    out.push(`${indent}… +${files.length - maxFilesPerDir} more files`);
  }
}

function countFiles(node: TreeNode): number {
  let total = node.files.length;
  for (const child of node.children.values()) total += countFiles(child);
  return total;
}

/**
 * L0 — the cheapest possible orientation. Always included in the cached
 * system prefix, so it costs full price exactly once per session.
 */
export function buildSkeleton(input: EngineInput): string {
  const files = Object.values(input.memory.files);
  if (files.length === 0) {
    return "## REPO MAP\n(empty workspace — no files yet)";
  }

  const tree = buildTree(files.map((f) => ({ path: f.path, tokens: f.tokens })));
  const lines: string[] = [];
  renderTree(tree, 0, 3, 12, lines);

  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const symbolCount = input.graph?.nodes.length ?? 0;

  return [
    "## REPO MAP",
    `${files.length} files · ${symbolCount} indexed symbols · ${totalTokens.toLocaleString()} tokens of source total.`,
    "",
    "```",
    ...lines,
    "```",
    "",
    "You have a symbol graph over this repo. Prefer `graph_search` and `symbol_outline`",
    "over `read_file` — the graph gives you signatures, call edges, and import edges for",
    "a fraction of the tokens. Read whole files only when you must edit something you",
    "cannot see from the graph.",
  ].join("\n");
}

/* ------------------------------- L1 ------------------------------------- */

export interface SymbolIndexOptions {
  /** Substring filter on paths. */
  filter?: string;
  /** Max files listed. */
  limit?: number;
  /** Include per-file import edges. Costs tokens; off by default. */
  withImports?: boolean;
}

/**
 * L1 — every file mapped to its exported symbols. This is the layer agents
 * should live in: it answers "where does X live?" without reading anything.
 */
export function buildSymbolIndex(
  input: EngineInput,
  options: SymbolIndexOptions = {},
): string {
  const filter = options.filter?.toLowerCase().trim();
  const limit = options.limit ?? 200;

  let files = Object.values(input.memory.files);
  if (filter) {
    files = files.filter(
      (f) =>
        f.path.toLowerCase().includes(filter) ||
        f.exports.some((e) => e.toLowerCase().includes(filter)),
    );
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const shown = files.slice(0, limit);
  const lines = shown.map((file) => {
    const parts = [`${file.path} (${file.tokens}t)`];
    if (file.purpose) parts.push(`— ${file.purpose}`);
    const body = file.exports.length
      ? `\n    exports: ${file.exports.join(", ")}`
      : "";
    const imports =
      options.withImports && file.imports.length
        ? `\n    imports: ${file.imports.join(", ")}`
        : "";
    return `  ${parts.join(" ")}${body}${imports}`;
  });

  const header = filter
    ? `## SYMBOL INDEX — filter "${options.filter}" (${files.length} matches)`
    : `## SYMBOL INDEX (${files.length} files)`;
  const more =
    files.length > shown.length
      ? `\n  … +${files.length - shown.length} more files (narrow with a filter)`
      : "";

  return `${header}\n${lines.join("\n")}${more}`;
}

/* ------------------------------- L2 ------------------------------------- */

export interface GraphSliceResult {
  text: string;
  nodeIds: string[];
  files: string[];
  /** Tokens the slice actually costs. */
  tokens: number;
  /** Tokens the same information would cost as raw files. */
  baselineTokens: number;
  deduped: boolean;
}

/**
 * L2 — a query-shaped slice of the graph: seed symbols found by TF-IDF, then
 * BFS across import and call edges, capped. Returns signatures and bodies
 * plus the relationships between the selected symbols, which is the part a
 * plain grep can never give you.
 */
export function buildGraphSlice(
  input: EngineInput,
  query: string,
  options: GraphSliceOptions = {},
): GraphSliceResult {
  const empty: GraphSliceResult = {
    text: "No indexed symbols matched. The workspace may be empty, or the code may be in a language the parser does not index (it handles TS/JS/TSX/JSX). Use `list_files` or `grep` instead.",
    nodeIds: [],
    files: [],
    tokens: 0,
    baselineTokens: 0,
    deduped: false,
  };
  if (!input.graph || input.graph.nodes.length === 0) return empty;

  const selection = selectContext(input.graph, query, input.fileInfo, {
    depth: options.depth,
    maxNodes: options.maxNodes,
  });
  if (selection.nodeIds.length === 0) return empty;

  const nodeById = new Map(input.graph.nodes.map((n) => [n.id, n] as const));
  const rendered = renderSlice(input, query, selection.nodeIds, nodeById, {
    maxTokens: options.maxTokens ?? DEFAULT_SLICE_TOKENS,
    maxBodies: options.maxBodies ?? DEFAULT_SLICE_BODIES,
  });
  const files: string[] = [];
  const seen = new Set<string>();
  for (const id of rendered.nodeIds) {
    const file = nodeById.get(id)?.file;
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  }

  // The naive alternative: dumping every file this slice touches.
  let baselineTokens = 0;
  for (const file of files) {
    const digest = input.memory.files[file];
    if (digest) {
      baselineTokens += digest.tokens;
      input.ledger.chargeBaseline(file, digest.tokens);
    }
  }

  const offered = input.ledger.offer(
    "graph_slice",
    `graph slice for "${query}"`,
    rendered.text,
    { paths: files, nodeIds: rendered.nodeIds },
  );
  if (!offered.deduped) {
    const shown = bodiesShown(input.ledger);
    for (const id of rendered.bodyIds) shown.add(id);
  }

  return {
    text: offered.text,
    nodeIds: rendered.nodeIds,
    files,
    tokens: offered.tokens,
    baselineTokens: Math.max(baselineTokens, selection.baselineTokens),
    deduped: offered.deduped,
  };
}

export interface GraphSliceOptions {
  depth?: number;
  maxNodes?: number;
  /** Token ceiling for one slice. Default 2000. */
  maxTokens?: number;
  /** Most symbols shown with a body; the rest get signatures. Default 5. */
  maxBodies?: number;
}

export const DEFAULT_SLICE_TOKENS = 2000;
export const DEFAULT_SLICE_BODIES = 5;
const SLICE_BODY_CHARS = 1200;
const SLICE_EDGE_LINES = 20;
const SLICE_FRONTIER_LINES = 6;
/** Words too common in prose to pick a symbol body on their own. */
const SLICE_WEAK_WORDS = new Set(
  "has have get set run use make with when then this that from into file files data value item list test tests error issue fix bug code line text type name path".split(" "),
);

/** Per agent ledger: node ids whose bodies this agent has already been shown. */
const shownBodies = new WeakMap<ContextLedger, Set<string>>();
function bodiesShown(ledger: ContextLedger): Set<string> {
  let set = shownBodies.get(ledger);
  if (!set) {
    set = new Set();
    shownBodies.set(ledger, set);
  }
  return set;
}

function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/**
 * Render a selection compactly under a token budget: the symbols the query
 * actually names get a body (they are what the agent came for), graph
 * neighbours get one signature line each, grouped by file. Symbols nested in
 * a shown body, duplicates, and bodies this agent already saw collapse.
 */
function renderSlice(
  input: EngineInput,
  query: string,
  ids: string[],
  nodeById: Map<string, GraphNode>,
  opts: { maxTokens: number; maxBodies: number },
): { text: string; nodeIds: string[]; bodyIds: string[] } {
  const queryWords = new Set(retrievalTokenize(query).flatMap((t) => [t, ...t.split("_")]));
  const seenBefore = bodiesShown(input.ledger);
  const nodes: GraphNode[] = [];
  const dup = new Set<string>();
  for (const id of ids) {
    const node = nodeById.get(id);
    if (!node) continue;
    const key = `${node.file}\0${node.name}\0${node.startLine}`;
    if (dup.has(key)) continue;
    dup.add(key);
    nodes.push(node);
  }
  // `ids` arrive best-first. Bodies go to query matches; if nothing matches by
  // name, the top-ranked symbol still gets one.
  // Short words ("has", "get") only count when they are the whole name, and
  // inline arrows (`(x) => …`) only when named exactly.
  const matches = (n: GraphNode) => {
    const leaf = n.name.split(".").pop()!.toLowerCase();
    if (queryWords.has(leaf)) return !SLICE_WEAK_WORDS.has(leaf);
    if (n.signature.trimStart().startsWith("(")) return false;
    return nameWords(n.name).some((w) => w.length > 3 && queryWords.has(w) && !SLICE_WEAK_WORDS.has(w));
  };
  let bodyCands = nodes.filter(matches);
  if (!bodyCands.length) bodyCands = nodes.slice(0, 1);

  const budget = Math.max(200, opts.maxTokens);
  const bodyBudget = Math.round(budget * 0.75);
  const bodies: GraphNode[] = [];
  const repeat: GraphNode[] = [];
  let used = 0;
  for (const node of bodyCands) {
    if (bodies.length >= opts.maxBodies) break;
    // A method whose class body is already shown adds nothing.
    if (bodies.some((b) => b.file === node.file && b.startLine <= node.startLine && b.endLine >= node.endLine)) continue;
    if (seenBefore.has(node.id)) {
      repeat.push(node);
      continue;
    }
    const cost = countTokens(formatBody(node));
    if (bodies.length && used + cost > bodyBudget) continue;
    bodies.push(node);
    used += cost;
  }
  // Drop bodies later found to be nested in a (larger) shown body.
  const bodySet = new Set(bodies.map((b) => b.id));
  const inside = (n: GraphNode) =>
    bodies.some((b) => b.id !== n.id && b.file === n.file && b.startLine <= n.startLine && b.endLine >= n.endLine);
  const finalBodies = bodies.filter((b) => !inside(b));

  const blocks: string[] = [];
  const nodeIds: string[] = [];
  for (const b of finalBodies) {
    blocks.push(formatBody(b));
    nodeIds.push(b.id);
  }
  for (const n of nodes) if (bodySet.has(n.id) && !finalBodies.includes(n)) nodeIds.push(n.id);

  // Neighbours: one signature line each, grouped by file, deduped by signature.
  const rest: GraphNode[] = [];
  for (const n of nodes) {
    if (bodySet.has(n.id)) continue;
    if (inside(n)) nodeIds.push(n.id); // delivered inside a shown body
    else rest.push(n);
  }
  const byFile = new Map<string, GraphNode[]>();
  for (const n of rest) byFile.set(n.file, [...(byFile.get(n.file) ?? []), n]);
  const sigLines: string[] = [];
  let omitted = 0;
  let sigUsed = 0;
  const sigBudget = budget - used - 150;
  for (const [file, list] of byFile) {
    const seenSig = new Set<string>();
    const rows: string[] = [];
    let chunkCost = countTokens(file) + 1;
    for (const n of list.sort((a, b) => a.startLine - b.startLine)) {
      const sig = oneLine(n.signature);
      if (seenSig.has(sig)) {
        nodeIds.push(n.id); // identical signature already listed
        continue;
      }
      const note = seenBefore.has(n.id) ? "  (body shown earlier)" : "";
      const leaf = n.name.split(".").pop()!;
      const row = `  ${n.startLine}-${n.endLine} ${sig.includes(leaf) ? sig : `${n.name}: ${sig}`}${note}`;
      const cost = countTokens(row) + 1;
      if (sigUsed + chunkCost + cost > sigBudget) {
        omitted += 1;
        continue;
      }
      seenSig.add(sig);
      rows.push(row);
      chunkCost += cost;
      nodeIds.push(n.id);
    }
    if (!rows.length) continue;
    sigLines.push(`${file}\n${rows.join("\n")}`);
    sigUsed += chunkCost;
  }
  for (const n of repeat) if (!nodeIds.includes(n.id)) nodeIds.push(n.id);
  if (sigLines.length) {
    blocks.push(`### neighbours (signatures; read_file a line range for a body)\n${sigLines.join("\n")}`);
  }

  // Relationships among what was shown, then a few edges leaving the slice.
  const graph = input.graph!;
  const shownSet = new Set(nodeIds);
  const label = (n: GraphNode) => `${n.name} (${n.file.split("/").pop()})`;
  // Only edges touching a shown body: neighbour-to-neighbour edges are noise.
  const edgeLines = new Set<string>();
  const frontier = new Set<string>();
  let edgeBudget = budget - used - sigUsed - 60;
  for (const e of graph.edges) {
    if (!bodySet.has(e.source) && !bodySet.has(e.target)) continue;
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (!s || !t || s.id === t.id) continue;
    const verb = e.kind === "call" ? "calls" : "imports";
    const inside2 = shownSet.has(e.source) && shownSet.has(e.target);
    const line = inside2 ? `- ${label(s)} ${verb} ${label(t)}` : `- ${s.name} (${s.file}) ${verb} ${t.name} (${t.file})`;
    const target = inside2 ? edgeLines : frontier;
    if (target.has(line) || target.size >= (inside2 ? SLICE_EDGE_LINES : SLICE_FRONTIER_LINES)) continue;
    const cost = countTokens(line) + 1;
    if (cost > edgeBudget) break;
    edgeBudget -= cost;
    target.add(line);
  }
  if (edgeLines.size) blocks.push(`### relationships\n${[...edgeLines].join("\n")}`);
  if (frontier.size) blocks.push(`### edges leaving the slice\n${[...frontier].join("\n")}`);

  const fileCount = new Set(nodeIds.map((id) => nodeById.get(id)?.file)).size;
  const header =
    `### graph slice for "${query.length > 120 ? `${query.slice(0, 117)}…` : query}" — ${nodeIds.length} symbols in ${fileCount} files, ${finalBodies.length} with bodies` +
    (repeat.length ? `; ${repeat.length} bodies already shown earlier (scroll up)` : "") +
    (omitted ? `; ${omitted} more symbols omitted for size (narrow the query)` : "");
  return { text: [header, ...blocks].join("\n\n"), nodeIds, bodyIds: finalBodies.map((b) => b.id) };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

function formatBody(node: GraphNode): string {
  const truncated = node.snippet.length > SLICE_BODY_CHARS;
  const body = node.snippet.slice(0, SLICE_BODY_CHARS);
  return [
    `### ${node.kind} ${node.name}  (${node.file}:${node.startLine}-${node.endLine})`,
    "```",
    truncated ? `${body}\n… (${node.snippet.length - SLICE_BODY_CHARS} more chars; read_file ${node.file} for the rest)` : body,
    "```",
  ].join("\n");
}

/* ------------------------------- L3 ------------------------------------- */

export interface FileWindowResult {
  text: string;
  tokens: number;
  deduped: boolean;
  truncated: boolean;
}

/** Hard ceiling on a single read, so one enormous file cannot blow context. */
const MAX_WINDOW_LINES = 1200;

/**
 * L3 — an explicit window of one file. Line-addressed rather than "the whole
 * file", which is what stops a 4,000-line component from costing 50k tokens.
 */
export async function buildFileWindow(
  input: EngineInput,
  path: string,
  range?: { start?: number; end?: number },
): Promise<FileWindowResult> {
  const source = await input.readFile(path);
  if (source === null) {
    return {
      text: `File not found: ${path}. Use \`symbol_outline\` or \`list_files\` to find the right path.`,
      tokens: 0,
      deduped: false,
      truncated: false,
    };
  }

  const digest = input.memory.files[path];
  if (digest) input.ledger.chargeBaseline(path, digest.tokens);

  const lines = source.split("\n");
  const start = Math.max(1, range?.start ?? 1);
  const requestedEnd = range?.end ?? lines.length;
  const end = Math.min(lines.length, Math.max(start, requestedEnd));
  const capped = Math.min(end, start + MAX_WINDOW_LINES - 1);
  const truncated = capped < end;

  const body = lines
    .slice(start - 1, capped)
    .map((line, i) => `${String(start + i).padStart(5, " ")}│ ${line}`)
    .join("\n");

  const header =
    start === 1 && capped === lines.length
      ? `${path} (${lines.length} lines)`
      : `${path} lines ${start}-${capped} of ${lines.length}`;

  const text =
    `### ${header}\n\`\`\`\n${body}\n\`\`\`` +
    (truncated
      ? `\n[truncated at ${MAX_WINDOW_LINES} lines — request a further range to continue]`
      : "");

  // Symbols whose bodies fall inside the window, for per-symbol attribution.
  const nodeIds = (input.graph?.nodes ?? [])
    .filter((n) => n.file === path && n.startLine <= capped && n.endLine >= start)
    .map((n) => n.id);
  const offered = input.ledger.offer("read_file", path, text, { paths: [path], nodeIds });
  return {
    text: offered.text,
    tokens: offered.tokens,
    deduped: offered.deduped,
    truncated,
  };
}

/* ------------------------- symbol outline -------------------------------- */

/**
 * A middle rung between L1 and L2: the full symbol table for one file, with
 * signatures and line ranges but no bodies. Usually enough to plan an edit,
 * at roughly a tenth of the file's token cost.
 */
export function buildSymbolOutline(input: EngineInput, path: string): string {
  const digest = input.memory.files[path];
  if (digest) input.ledger.chargeBaseline(path, digest.tokens);

  const nodes = (input.graph?.nodes ?? []).filter((n) => n.file === path);
  if (nodes.length === 0) {
    return digest
      ? `### ${path}\nNo indexed symbols (not a TS/JS module, or it exports nothing). ${digest.tokens} tokens of source. Use \`read_file\` with a line range if you need the contents.`
      : `File not found: ${path}.`;
  }

  const sorted = [...nodes].sort((a, b) => a.startLine - b.startLine);
  const lines = sorted.map(
    (n) =>
      `  ${n.kind} ${n.name} — lines ${n.startLine}-${n.endLine} (${n.loc} LOC)\n    ${n.signature}`,
  );

  const graph = input.graph;
  let relations = "";
  if (graph) {
    const ids = new Set(sorted.map((n) => n.id));
    const inbound = graph.edges.filter((e) => ids.has(e.target) && !ids.has(e.source));
    const outbound = graph.edges.filter((e) => ids.has(e.source) && !ids.has(e.target));
    const nameById = new Map(graph.nodes.map((n) => [n.id, `${n.name} (${n.file})`] as const));
    const fmt = (list: typeof inbound, dir: "from" | "to") =>
      [...new Set(list.map((e) => nameById.get(dir === "from" ? e.source : e.target)))]
        .filter(Boolean)
        .slice(0, 12)
        .map((s) => `    ${s}`)
        .join("\n");
    if (inbound.length) relations += `\n  used by:\n${fmt(inbound, "from")}`;
    if (outbound.length) relations += `\n  depends on:\n${fmt(outbound, "to")}`;
  }

  const outline = `### ${path} — ${nodes.length} symbols${
    digest ? ` (${digest.tokens} tokens of source)` : ""
  }\n${lines.join("\n")}${relations}`;
  input.ledger.record("symbol_outline", path, outline, {
    paths: [path],
    nodeIds: sorted.map((n) => n.id),
  });
  return outline;
}

/**
 * Attribution for a tool result made of `path:line…` rows (grep hits,
 * symbol lookups): the files it quotes, and the graph nodes whose ranges
 * contain the quoted lines.
 */
export function attributeRows(
  input: Pick<EngineInput, "graph" | "memory">,
  text: string,
): { paths: string[]; nodeIds: string[] } {
  const paths = new Set<string>();
  const nodeIds = new Set<string>();
  const byFile = new Map<string, GraphNode[]>();
  for (const node of input.graph?.nodes ?? []) {
    const list = byFile.get(node.file);
    if (list) list.push(node);
    else byFile.set(node.file, [node]);
  }
  for (const match of text.matchAll(/^([^\s:]+):(\d+)/gm)) {
    const path = match[1];
    if (!input.memory.files[path] && !byFile.has(path)) continue;
    paths.add(path);
    const line = Number(match[2]);
    for (const node of byFile.get(path) ?? []) {
      if (node.startLine <= line && node.endLine >= line) nodeIds.add(node.id);
    }
  }
  return { paths: [...paths], nodeIds: [...nodeIds] };
}

/* --------------------------- misc helpers -------------------------------- */

/** Cheap literal/regex search that returns matching lines, never whole files. */
export async function searchCode(
  input: EngineInput,
  pattern: string,
  options: { glob?: string; maxResults?: number; regex?: boolean } = {},
): Promise<string> {
  const maxResults = options.maxResults ?? 60;
  let matcher: (line: string) => boolean;
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (error) {
      return `Invalid regex: ${error instanceof Error ? error.message : String(error)}`;
    }
    matcher = (line) => re.test(line);
  } else {
    const needle = pattern.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(needle);
  }

  const globFilter = options.glob?.toLowerCase();
  const results: string[] = [];
  let scanned = 0;

  for (const digest of Object.values(input.memory.files)) {
    if (results.length >= maxResults) break;
    if (globFilter && !matchGlob(digest.path.toLowerCase(), globFilter)) continue;
    const source = await input.readFile(digest.path);
    if (source === null) continue;
    scanned += 1;
    const lines = source.split("\n");
    for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
      if (!matcher(lines[i])) continue;
      results.push(`${digest.path}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
    }
  }

  if (results.length === 0) {
    return `No matches for "${pattern}" across ${scanned} files.`;
  }
  const text = `${results.length} match${results.length === 1 ? "" : "es"} for "${pattern}" (scanned ${scanned} files):\n${results.join("\n")}${
    results.length >= maxResults ? "\n… result cap reached; narrow the pattern." : ""
  }`;
  // Grep hits bypass dedupe; record them for per-file attribution only.
  input.ledger.record("grep", `grep "${pattern}"`, text, attributeRows(input, text));
  return text;
}

/** Minimal glob: supports `*` and `**`, which covers the realistic cases. */
export function matchGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

/** Total source tokens — the true "dump everything" baseline. */
export function naiveBaselineTokens(memory: ProjectMemory): number {
  return Object.values(memory.files).reduce((sum, f) => sum + f.tokens, 0);
}

export function summarizeNodes(nodes: GraphNode[]): string {
  return nodes.map((n) => `${n.name} (${n.file}:${n.startLine})`).join(", ");
}

export function tokensOf(text: string): number {
  return countTokens(text);
}

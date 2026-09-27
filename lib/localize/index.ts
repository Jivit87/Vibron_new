/**
 * Deterministic fault localization, zero model tokens (ported from Pramana
 * `repo/localize.py`). Signals, strongest first:
 *
 *  - traceback frames and file paths quoted in the issue (and in the output
 *    of the issue's own code, run on the ORIGINAL tree);
 *  - identifiers from the issue (backticked code, dotted names, CamelCase,
 *    snake_case, calls) resolved through the symbol graph;
 *  - BM25 between the issue and each file (identifiers split into words);
 *  - second hop: the source files the best-matching tests import.
 *
 * The result is a short ranked hint list, never a constraint, plus past
 * `fix` notes on the same area as lessons.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { isSourceFilePath, type RepoFile } from "@/lib/github";
import type { Graph, GraphNode } from "@/lib/graph";
import { loadPathAliases } from "@/lib/lang/tsconfig";
import { bm25Files, bm25Symbols, contentSignature, fileTerms } from "@/lib/localize/lexical";
import { runSnippets } from "@/lib/localize/snippets";
import { relevantLessons } from "@/lib/memory/graph";
import { extractFile, goModuleOf, linkGraphAsync, type FileExtract } from "@/lib/parser";
import { listRepoPaths, relatedTestFiles, type ShellRunner } from "@/lib/verify";
import { timeSlicer } from "@/lib/workers/yield";

export { extractSnippets, runSnippets, type Snippet, type SnippetRun } from "@/lib/localize/snippets";
export { clearLexicalCache } from "@/lib/localize/lexical";

export interface LocalizedFile {
  path: string;
  score: number;
  why: string[];
}

export interface LocalizeResult {
  files: LocalizedFile[];
  /** `qualname (path:line)` for the symbols behind the top files. */
  symbols: string[];
  snippetRun?: { code: string; output: string; exitCode: number | null };
  testFiles: string[];
  /** Past `fix` notes on the same area (untrusted, may be outdated). */
  lessons: string[];
}

export interface LocalizeOptions {
  runSnippets?: boolean;
  timeoutMs?: number;
  topK?: number;
  /** Test seam for snippet runs. */
  run?: ShellRunner;
  signal?: AbortSignal;
}

const STOP = new Set(
  `a an the and or but if then else when while for to of in on at by with from as is are was were be been being it its
  this that these those there here i we you he she they them my our your their me us not no yes do does did done have has
  had can could should would will shall may might must also just only very more most less least so such than too into out
  up down over under again further once all any both each few other some same own what which who whom why how where
  about above after before below between during through until against among because use used using get gets got
  set sets new old one two three first second last next example expected actual output input result results error errors
  issue bug fix fixes problem work works working worked happen happens code line lines file files function method class
  value values return returns returned call calls called true false none null self cls def import print str int float
  bool list dict tuple type types object objects string strings number test tests see seems seem like want need please
  thanks thank hi hello following follow version versions python run running ran instead however currently now make
  makes made way case cases etc const let var require console log`.split(/\s+/),
);
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const DOTTED_RE = /\b[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+\b/g;
const BACKTICK_RE = /`{1,3}([^`]+?)`{1,3}/g;
const TRACE_RE = /File "([^"]+)", line (\d+)(?:, in ([\w<>]+))?/g;
const JS_TRACE_RE = /at (?:[\w.$<>]+ )?\(?([\w./\\-]+\.(?:js|ts|mjs|cjs|jsx|tsx)):(\d+):\d+\)?/g;
const PATH_RE =
  /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:py|pyi|js|jsx|ts|tsx|mjs|cjs|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|toml|cfg|ini|yaml|yml|json))\b/g;
const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
const CODE_EXTS = /\.(py|pyi|js|jsx|mjs|cjs|ts|tsx|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|scala)$/;
const VENDOR_RE = /(^|\/)(vendor|vendored|third_party|thirdparty|node_modules|static|dist|build|_vendor)(\/|$)|\.min\.(js|css)$/i;

function splitIdent(tok: string): string[] {
  return tok
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((p) => p.length > 1);
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const [tok] of text.matchAll(IDENT_RE)) {
    const low = tok.toLowerCase();
    if (low.length > 2 && !STOP.has(low)) out.push(low);
    if (tok.includes("_") || /[a-z][A-Z]/.test(tok)) out.push(...splitIdent(tok).filter((p) => !STOP.has(p) && p.length > 2));
  }
  return out;
}

export function isTestPath(p: string): boolean {
  const low = p.toLowerCase();
  return (
    /(^|\/)(tests?|testing|spec|__tests__)(\/|$)/.test(low) ||
    /(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+)$/.test(low)
  );
}

/** Plain lowercase words name dozens of things; snake_case/CamelCase don't. */
function specificity(name: string): number {
  if (name.replace(/^_+|_+$/g, "").includes("_") || /[a-z][A-Z]/.test(name) || /^[A-Z][a-z]+[A-Z]/.test(name)) return 1;
  if (/^[A-Z]/.test(name)) return 0.8;
  return name.length <= 12 ? 0.25 : 0.6;
}

export interface IssueSignals {
  strong: string[];
  dotted: string[];
  frames: { file: string; line: number; func: string }[];
  paths: string[];
}

export function extractSignals(text: string): IssueSignals {
  const strong: string[] = [];
  for (const m of text.matchAll(BACKTICK_RE)) strong.push(...(m[1].match(IDENT_RE) ?? []));
  for (const m of text.matchAll(CALL_RE)) strong.push(m[1]);
  for (const [tok] of text.matchAll(IDENT_RE)) {
    if (tok.replace(/^_+|_+$/g, "").includes("_") || /[a-z][A-Z]/.test(tok) || /^[A-Z][a-z]+[A-Z]\w*$/.test(tok)) strong.push(tok);
  }
  const frames: IssueSignals["frames"] = [];
  for (const m of text.matchAll(TRACE_RE)) frames.push({ file: m[1], line: Number(m[2]), func: m[3] ?? "" });
  for (const m of text.matchAll(JS_TRACE_RE)) frames.push({ file: m[1], line: Number(m[2]), func: "" });
  const seen = new Set<string>();
  const uniq = strong.filter((s) => {
    if (STOP.has(s.toLowerCase()) || s.length < 3 || seen.has(s)) return false;
    seen.add(s);
    return true;
  });
  return {
    strong: uniq.slice(0, 80),
    dotted: [...new Set(text.match(DOTTED_RE) ?? [])].slice(0, 60),
    frames: frames.slice(-40),
    paths: [...new Set([...text.matchAll(PATH_RE)].map((m) => m[1]))].slice(0, 40),
  };
}

function matchPath(ref: string, suffixIndex: Map<string, string[]>): string[] {
  const clean = ref.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  const cands = suffixIndex.get(clean.split("/").pop()!) ?? [];
  if (clean.includes("/")) {
    for (const depth of [3, 2]) {
      const tail = clean.split("/").slice(-depth).join("/");
      const exact = cands.filter((f) => f === tail || f.endsWith(`/${tail}`));
      if (exact.length) return exact;
    }
  }
  return cands.length <= 3 ? cands : [];
}

interface Candidate {
  path: string;
  score: number;
  why: string[];
  /** symbol label → weight, so the short list is ranked, not insertion-ordered. */
  symbols: Map<string, number>;
}

/** `name (path:start-end)`: a line range the agent can read directly. */
function symbolLabel(node: GraphNode): string {
  return `${node.name} (${node.file}:${node.startLine}-${node.endLine})`;
}

/** The innermost symbol whose range contains `line`. */
function enclosing(nodes: GraphNode[] | undefined, line: number): GraphNode | undefined {
  let best: GraphNode | undefined;
  for (const n of nodes ?? []) {
    if (n.startLine <= line && n.endLine >= line && (!best || n.endLine - n.startLine < best.endLine - best.startLine)) best = n;
  }
  return best;
}

/** Repo source files a test imports (Python absolute imports, JS/TS relative imports). */
function importedSources(testRel: string, text: string, fileSet: Set<string>): string[] {
  const out: string[] = [];
  if (testRel.endsWith(".py")) {
    for (const m of text.slice(0, 200_000).matchAll(/^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w.]+)/gm)) {
      const mod = (m[1] ?? m[2]).replace(/^\.+|\.+$/g, "");
      if (!mod || /^(os|sys|re|unittest|pytest|typing)\b/.test(mod)) continue;
      const parts = mod.split(".");
      search: for (let cut = parts.length; cut > 0; cut -= 1) {
        const base = parts.slice(0, cut).join("/");
        for (const cand of [`${base}.py`, `${base}/__init__.py`, `src/${base}.py`, `src/${base}/__init__.py`]) {
          if (fileSet.has(cand)) {
            out.push(cand);
            break search;
          }
        }
      }
    }
  } else {
    for (const m of text.matchAll(/(?:require\(\s*|from\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(testRel), m[1]));
      for (const ext of ["", ".js", ".ts", ".mjs", ".cjs", ".jsx", ".tsx", "/index.js", "/index.ts"]) {
        if (fileSet.has(base + ext)) {
          out.push(base + ext);
          break;
        }
      }
    }
  }
  return [...new Set(out)].slice(0, 12);
}

async function readText(root: string, rel: string): Promise<string> {
  try {
    const abs = path.join(root, rel);
    if ((await stat(abs)).size > 400_000) return "";
    return await readFile(abs, "utf8");
  } catch {
    return "";
  }
}

/** Fallback graph when the caller has none: parsed off the hot path, cached by content. */
const fallbackGraphs = new Map<string, { sig: string; graph: Graph }>();

async function fallbackGraph(root: string, files: string[], signal?: AbortSignal): Promise<Graph> {
  const sig = contentSignature(root, files);
  const hit = fallbackGraphs.get(root);
  if (hit && hit.sig === sig) return hit.graph;
  const tick = timeSlicer();
  const repoFiles: RepoFile[] = [];
  for (let i = 0; i < files.length; i += 128) {
    const batch = files.slice(i, i + 128);
    const texts = await Promise.all(batch.map((rel) => readText(root, rel)));
    batch.forEach((rel, j) => {
      if (texts[j]) repoFiles.push({ path: rel, source: texts[j] });
    });
  }
  const sourceFiles = repoFiles.filter((f) => isSourceFilePath(f.path));
  const extracts: FileExtract[] = [];
  for (const file of sourceFiles) {
    await tick(signal);
    extracts.push(extractFile(file));
  }
  const graph = await linkGraphAsync(
    extracts,
    {
      repoRef: "unknown/repo@local",
      knownFiles: new Set(sourceFiles.map((f) => f.path)),
      aliases: loadPathAliases(repoFiles),
      goModule: goModuleOf(repoFiles),
    },
    tick,
    signal,
  );
  fallbackGraphs.set(root, { sig, graph });
  while (fallbackGraphs.size > 4) fallbackGraphs.delete(fallbackGraphs.keys().next().value!);
  return graph;
}

/** Rank the files most likely to need the change for `task`. */
export async function localize(
  root: string,
  task: string,
  graph: Graph | null,
  opts: LocalizeOptions = {},
): Promise<LocalizeResult> {
  const topK = opts.topK ?? 8;
  const tick = timeSlicer();
  const files = listRepoPaths(root).filter((f) => CODE_EXTS.test(f) && !VENDOR_RE.test(f)).slice(0, 12_000);
  const fileSet = new Set(files);
  const suffixIndex = new Map<string, string[]>();
  for (const f of files) {
    const base = f.split("/").pop()!;
    const list = suffixIndex.get(base);
    if (list) list.push(f);
    else suffixIndex.set(base, [f]);
  }

  let snippetRun: LocalizeResult["snippetRun"];
  let text = task;
  if (opts.runSnippets !== false) {
    try {
      const runs = await runSnippets(root, task, { timeoutMs: opts.timeoutMs, run: opts.run, signal: opts.signal });
      const pick = runs.find((r) => r.exitCode !== 0) ?? runs[0];
      if (pick) {
        snippetRun = { code: pick.code, output: pick.output, exitCode: pick.exitCode };
        // The traceback the issue's own code prints is the strongest signal we can get for free.
        text = `${task}\n${runs.map((r) => r.output).join("\n")}`;
      }
    } catch {
      // Snippets are a bonus; never fail localization over them.
    }
  }

  // Cached by content and time-sliced: no multi-hundred-ms stall on big repos.
  const docs = await fileTerms(root, files, tokenize, opts.signal);
  const symbolGraph = graph?.nodes.length ? graph : await fallbackGraph(root, files, opts.signal);
  const byName = new Map<string, GraphNode[]>();
  const nodesByFile = new Map<string, GraphNode[]>();
  for (const node of symbolGraph.nodes) {
    await tick(opts.signal);
    if (VENDOR_RE.test(node.file)) continue;
    const leaf = node.name.split(".").pop()!;
    for (const key of new Set([node.name, leaf])) {
      const list = byName.get(key);
      if (list) list.push(node);
      else byName.set(key, [node]);
    }
    const inFile = nodesByFile.get(node.file);
    if (inFile) inFile.push(node);
    else nodesByFile.set(node.file, [node]);
  }

  const cands = new Map<string, Candidate>();
  const bump = (p: string, score: number, reason: string, sym?: string) => {
    const c = cands.get(p) ?? { path: p, score: 0, why: [], symbols: new Map<string, number>() };
    cands.set(p, c);
    c.score += score;
    if (reason && !c.why.includes(reason) && c.why.length < 4) c.why.push(reason);
    if (sym && (c.symbols.has(sym) || c.symbols.size < 6)) c.symbols.set(sym, (c.symbols.get(sym) ?? 0) + score);
  };

  const { strong, dotted, frames, paths } = extractSignals(text);
  frames.forEach((frame, i) => {
    const last = i === frames.length - 1;
    for (const rel of matchPath(frame.file, suffixIndex)) {
      // The frame's line names the function to fix, with its range.
      const node = enclosing(nodesByFile.get(rel), frame.line);
      const sym = node ? symbolLabel(node) : `${frame.func || "frame"} (${rel}:${frame.line})`;
      bump(rel, 6 + (last ? 3 : 0) + (node ? 1 : 0), "in traceback", sym);
    }
  });
  for (const ref of paths) for (const rel of matchPath(ref, suffixIndex)) bump(rel, 5, "path mentioned in issue");
  for (const name of dotted) {
    await tick(opts.signal);
    const parts = name.split(".");
    for (let cut = parts.length; cut > 0; cut -= 1) {
      const mod = parts.slice(0, cut).join("/");
      const hits = [...(suffixIndex.get(`${parts[cut - 1]}.py`) ?? []), ...(suffixIndex.get("__init__.py") ?? [])].filter(
        (f) => f.endsWith(`${mod}.py`) || f.endsWith(`${mod}/__init__.py`),
      );
      if (hits.length && hits.length <= 3) {
        for (const h of hits) bump(h, 3, `module \`${parts.slice(0, cut).join(".")}\``);
        break;
      }
    }
    const leaf = parts[parts.length - 1];
    const qual = parts.slice(-2).join(".");
    for (const node of (byName.get(qual) ?? byName.get(leaf) ?? []).slice(0, 6)) {
      bump(node.file, 3.5 * Math.max(specificity(leaf), 0.5), `defines \`${node.name}\``, symbolLabel(node));
    }
  }
  for (const name of strong) {
    const defs = (byName.get(name) ?? []).filter((n) => n.name === name || n.name.endsWith(`.${name}`));
    if (!defs.length || defs.length > 25) continue;
    const w = (4 * specificity(name)) / Math.sqrt(defs.length);
    for (const node of defs.slice(0, 10)) bump(node.file, w, `defines \`${node.name}\``, symbolLabel(node));
  }

  const queryTokens = tokenize(text);
  const lex = await bm25Files(queryTokens, docs, tokenize, opts.signal);
  if (lex.size) {
    let max = 0;
    for (const s of lex.values()) if (s > max) max = s;
    for (const [rel, s] of [...lex].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      bump(rel, (4 * s) / max, "");
      const c = cands.get(rel)!;
      if (!c.why.length) c.why.push("text similarity");
    }
  }

  // Symbol names + docstrings: finds `def total_price` for "the total price is wrong".
  const symHits = await bm25Symbols(symbolGraph, queryTokens, tokenize, VENDOR_RE, 12, opts.signal);
  if (symHits.length) {
    const max = symHits[0].score;
    for (const { node, score } of symHits) {
      if (score < max * 0.35) break;
      bump(node.file, (2.5 * score) / max, `matches \`${node.name}\``, symbolLabel(node));
    }
  }

  // Second hop: the tests that best match the issue import the code they exercise.
  const byScore = () => [...cands.values()].sort((a, b) => b.score - a.score);
  const testCands = byScore().filter((c) => isTestPath(c.path)).slice(0, 3);
  const topTest = testCands[0]?.score || 1;
  for (const tc of testCands) {
    const testDirs = new Set(path.posix.dirname(tc.path).split("/").filter((d) => !["tests", "test", "testing", "src", "."].includes(d)));
    const stem = path.posix.basename(tc.path).replace(/\.[^.]+$/, "").replace(/^test_|_test$|\.(test|spec)$/g, "");
    for (const mod of importedSources(tc.path, await readText(root, tc.path), fileSet)) {
      if (isTestPath(mod) || mod.endsWith("__init__.py")) continue;
      let affinity = 1;
      if (path.posix.dirname(mod).split("/").some((d) => testDirs.has(d))) affinity += 0.6;
      if (path.posix.basename(mod).replace(/\.[^.]+$/, "") === stem) affinity += 0.6;
      bump(mod, (2 + (2 * tc.score) / topTest) * affinity, `imported by related test ${path.posix.basename(tc.path)}`);
    }
  }

  const ranked = byScore();
  const src = ranked.filter((c) => !isTestPath(c.path)).slice(0, topK);
  let testFiles = ranked.filter((c) => isTestPath(c.path)).slice(0, 4).map((c) => c.path);
  if (!testFiles.length && src.length) {
    testFiles = await relatedTestFiles(root, src.slice(0, 3).map((c) => c.path), symbolGraph, 4).catch(() => []);
  }

  let lessons: string[] = [];
  try {
    lessons = relevantLessons(root, { files: src.map((c) => c.path), task });
  } catch {
    // Memory is advisory.
  }

  // Ranked short list: best file first, its strongest symbols first.
  const symbols: string[] = [];
  for (const c of src) {
    for (const [sym] of [...c.symbols].sort((a, b) => b[1] - a[1])) if (!symbols.includes(sym)) symbols.push(sym);
  }

  return {
    files: src.map((c) => ({ path: c.path, score: Math.round(c.score * 100) / 100, why: c.why.length ? c.why : ["text similarity"] })),
    symbols: symbols.slice(0, 12),
    snippetRun,
    testFiles,
    lessons,
  };
}

/** Compact text for a prompt. */
export function renderLocalization(result: LocalizeResult): string {
  if (!result.files.length && !result.testFiles.length) return "(no strong signals; start with find_symbols / grep)";
  const lines = result.files.map((f, i) => `${i + 1}. ${f.path}  [${f.why.join("; ")}]`);
  if (result.symbols.length) lines.push(`Symbols: ${result.symbols.slice(0, 8).join(", ")}`);
  if (result.testFiles.length) lines.push(`Related tests: ${result.testFiles.join(", ")}`);
  if (result.lessons.length) lines.push(`Past fixes nearby (untrusted, may be outdated):\n${result.lessons.map((l) => `- ${l}`).join("\n")}`);
  return lines.join("\n");
}

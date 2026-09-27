/**
 * Agent-facing code search with token-bounded output (port of Pramana
 * `tools/search.py`): ripgrep → `git grep` → JS walk, results grouped per
 * file, non-test files first, capped so one broad query cannot flood the
 * context window. Every backend runs through `execFile` with a fixed argv and
 * the pattern after `-e`, so nothing from the model becomes an option.
 */

import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { globToRegExp } from "@/lib/search/index";

export const MAX_MATCHES = 80;
export const MAX_PER_FILE = 12;
export const MAX_FILES_LISTED = 100;
const LINE_CAP = 220;
const RAW_LINE_CAP = 300;
const MAX_FILE_BYTES = 2_000_000;

/** Directories never walked by the JS fallback. */
export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "out", "coverage", "__pycache__",
  ".venv", "venv", "target", "vendor", ".turbo", ".cache", ".pramana",
]);

export type Hit = [file: string, line: number, text: string];

export interface CompactSearchOptions {
  path?: string;
  glob?: string;
  fixed?: boolean;
  ignoreCase?: boolean;
  maxMatches?: number;
  maxPerFile?: number;
  timeoutMs?: number;
  /** Force a backend (tests / environments without rg). */
  backends?: ("rg" | "git" | "js")[];
}

interface RunResult { code: number | null; stdout: string; stderr: string; missing: boolean }

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({
        code: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
        missing: e?.code === "ENOENT",
      });
    });
  });
}

function parseLines(stdout: string): Hit[] {
  const out: Hit[] = [];
  for (const line of stdout.split("\n")) {
    const a = line.indexOf(":");
    if (a < 0) continue;
    const b = line.indexOf(":", a + 1);
    if (b < 0) continue;
    const n = line.slice(a + 1, b);
    if (!/^\d+$/.test(n)) continue;
    out.push([line.slice(0, a).replace(/^\.\//, ""), Number(n), line.slice(b + 1, b + 1 + RAW_LINE_CAP)]);
  }
  return out;
}

async function rgSearch(root: string, pattern: string, o: CompactSearchOptions, fixed: boolean): Promise<Hit[] | null> {
  const args = ["--no-heading", "--line-number", "--color", "never", "--max-columns", "300",
    "--max-columns-preview", "--max-count", "200", "--hidden", "-g", "!.git", "-g", "!.pramana"];
  if (fixed) args.push("-F");
  if (o.ignoreCase) args.push("-i");
  if (o.glob) args.push("-g", o.glob);
  args.push("-e", pattern, "--");
  if (o.path) args.push(o.path);
  const r = await run("rg", args, root, o.timeoutMs ?? 60_000);
  if (r.missing) return null;
  if (r.code !== 0 && r.code !== 1) {
    if (!fixed && r.stderr.includes("regex parse error")) return rgSearch(root, pattern, o, true);
    return null;
  }
  return parseLines(r.stdout);
}

async function gitGrep(root: string, pattern: string, o: CompactSearchOptions, fixed: boolean): Promise<Hit[] | null> {
  if (!existsSync(path.join(root, ".git"))) return null;
  const args = ["grep", "-n", "-I", "--untracked", "--no-color", "--full-name", fixed ? "-F" : "-E"];
  if (o.ignoreCase) args.push("-i");
  args.push("-e", pattern, "--");
  if (o.path) args.push(o.path);
  if (o.glob) args.push(o.glob.includes("/") || o.glob.startsWith("!") ? o.glob : `*${o.glob.replace(/^\*+/, "")}`);
  args.push(":(exclude).pramana");
  const r = await run("git", args, root, o.timeoutMs ?? 60_000);
  if (r.missing) return null;
  if (r.code !== 0 && r.code !== 1) {
    const err = r.stderr.toLowerCase();
    if (!fixed && (err.includes("regex") || err.includes("invalid"))) return gitGrep(root, pattern, o, true);
    return null;
  }
  return parseLines(r.stdout);
}

/** Walk `base` (repo-relative POSIX paths), skipping ignored and dot dirs. */
export async function walkFiles(root: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  const abs = path.join(root, base);
  const st = await fs.stat(abs).catch(() => null);
  if (!st) return out;
  if (st.isFile()) return [base.split(path.sep).join("/")];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(".")) stack.push(p);
      } else if (e.isFile()) {
        out.push(path.relative(root, p).split(path.sep).join("/"));
      }
    }
  }
  return out.sort();
}

function globMatch(glob: string, rel: string): boolean {
  const re = globToRegExp(glob.replace(/^\//, ""));
  return re.test(path.posix.basename(rel)) || re.test(rel);
}

export function compileSearchRegex(pattern: string, fixed: boolean, ignoreCase: boolean): RegExp {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = ignoreCase ? "i" : "";
  if (fixed) return new RegExp(esc(pattern), flags);
  try {
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp(esc(pattern), flags);
  }
}

async function jsSearch(root: string, pattern: string, o: CompactSearchOptions): Promise<Hit[]> {
  const rx = compileSearchRegex(pattern, !!o.fixed, !!o.ignoreCase);
  const neg = o.glob?.startsWith("!");
  const glob = neg ? o.glob!.slice(1) : o.glob;
  const files = (await walkFiles(root, o.path ?? "")).filter((f) => !glob || globMatch(glob, f) !== neg);
  const out: Hit[] = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st || st.size > MAX_FILE_BYTES) continue;
    const buf = await fs.readFile(abs).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue; // binary
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) out.push([rel, i + 1, lines[i].slice(0, RAW_LINE_CAP)]);
    }
  }
  return out;
}

/** Raw hits via rg → git grep → JS. `git grep -E` lacks Perl classes, so those skip it. */
export async function searchHits(root: string, pattern: string, o: CompactSearchOptions = {}): Promise<Hit[]> {
  const backends = o.backends ?? ["rg", "git", "js"];
  const fixed = !!o.fixed;
  let hits: Hit[] | null = null;
  if (backends.includes("rg")) hits = await rgSearch(root, pattern, o, fixed);
  const perlOnly = !fixed && /\\[dwsbDWSB]|\(\?/.test(pattern);
  if (hits === null && backends.includes("git") && !o.glob?.startsWith("!") && !perlOnly) {
    hits = await gitGrep(root, pattern, o, fixed);
  }
  if (hits === null) hits = await jsSearch(root, pattern, o);
  return hits;
}

const isTest = (f: string) => f.toLowerCase().includes("test");

/** Group + cap hits into the compact text block the model sees. */
export function formatHits(hits: Hit[], pattern: string, o: CompactSearchOptions = {}): string {
  const where = (o.path ? ` in ${o.path}` : "") + (o.glob ? ` (glob ${o.glob})` : "");
  if (!hits.length) return `No matches for ${JSON.stringify(pattern)}${where}.`;
  const maxMatches = o.maxMatches ?? MAX_MATCHES;
  const perFile = o.maxPerFile ?? MAX_PER_FILE;
  const byFile = new Map<string, [number, string][]>();
  for (const [f, ln, text] of hits) {
    let arr = byFile.get(f);
    if (!arr) byFile.set(f, (arr = []));
    arr.push([ln, text]);
  }
  const order = [...byFile.keys()].sort((a, b) =>
    Number(isTest(a)) - Number(isTest(b)) || byFile.get(b)!.length - byFile.get(a)!.length || (a < b ? -1 : a > b ? 1 : 0));
  const lines = [`${hits.length} matches in ${byFile.size} files for ${JSON.stringify(pattern)}:`];
  let shown = 0;
  let shownFiles = 0;
  for (const f of order) {
    if (shown >= maxMatches) break;
    const entries = byFile.get(f)!;
    lines.push(`${f}  (${entries.length} match${entries.length !== 1 ? "es" : ""})`);
    for (const [ln, text] of entries.slice(0, perFile)) {
      lines.push(`  ${ln}: ${text.trim().slice(0, LINE_CAP)}`);
      shown++;
    }
    if (entries.length > perFile) lines.push(`  ... ${entries.length - perFile} more in this file`);
    shownFiles++;
  }
  const rest = order.slice(shownFiles);
  if (rest.length) lines.push(`... results capped; ${rest.length} more files matched: ${rest.slice(0, 30).join(", ")}`);
  return lines.join("\n");
}

/** Normalise/validate `path` against `root`; returns an error string or the relative path. */
function resolveScope(root: string, p: string | undefined): { rel?: string; error?: string } {
  if (!p?.trim()) return {};
  let rel = p.trim();
  if (path.isAbsolute(rel)) {
    const r = path.relative(path.resolve(root), path.resolve(rel));
    if (r.startsWith("..") || path.isAbsolute(r)) return { error: `error: path ${rel} is outside the repository` };
    rel = r || ".";
  }
  const r = path.relative(path.resolve(root), path.resolve(root, rel));
  if (r.startsWith("..")) return { error: `error: path ${rel} is outside the repository` };
  if (!existsSync(path.join(root, rel))) return { error: `error: path does not exist: ${rel}` };
  return { rel: rel.split(path.sep).join("/") };
}

/** Compact, grouped, capped search — the agent tool entry point. */
export async function searchCode(root: string, pattern: string, o: CompactSearchOptions = {}): Promise<string> {
  if (!pattern) return "error: pattern is required";
  const scope = resolveScope(root, o.path);
  if (scope.error) return scope.error;
  const opts = { ...o, path: scope.rel };
  return formatHits(await searchHits(root, pattern, opts), pattern, opts);
}

/** List files matching a glob (rg --files → walk), capped at 100 lines. */
export async function findFiles(root: string, pattern: string, o: { backends?: ("rg" | "js")[]; timeoutMs?: number } = {}): Promise<string> {
  if (!pattern) return "error: pattern is required";
  let files: string[] = [];
  if ((o.backends ?? ["rg", "js"]).includes("rg")) {
    const r = await run("rg", ["--files", "-g", pattern, "-g", "!.git"], root, o.timeoutMs ?? 60_000);
    if (!r.missing && r.code === 0) files = r.stdout.split("\n").filter(Boolean).map((f) => f.replace(/^\.\//, "")).sort();
  }
  if (!files.length) files = (await walkFiles(root)).filter((f) => globMatch(pattern, f));
  if (!files.length) return `No files match ${JSON.stringify(pattern)}.`;
  const more = files.length > MAX_FILES_LISTED ? `\n... and ${files.length - MAX_FILES_LISTED} more` : "";
  return `${files.length} files match ${JSON.stringify(pattern)}:\n${files.slice(0, MAX_FILES_LISTED).join("\n")}${more}`;
}

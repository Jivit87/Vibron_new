/**
 * Language-aware symbol index + `findDefinition` (port of Pramana
 * `repo/symbols.py`). Python gets an indentation-aware pass (qualified
 * `Class.method` names, spans, signatures); everything else uses the same
 * per-line regex table as the Python harness. No external binaries.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { walkFiles } from "@/lib/search/compact";

export const CODE_EXTS = new Set([
  ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".go", ".rs", ".java", ".kt", ".kts",
  ".scala", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".cs", ".swift", ".m",
  ".mm", ".lua", ".pl", ".pm", ".sh", ".bash", ".zsh", ".ex", ".exs", ".erl", ".hs", ".ml", ".r", ".R",
  ".jl", ".dart", ".vue", ".svelte", ".sql", ".groovy", ".clj", ".cljs",
]);

export interface CodeSymbol {
  name: string;
  qualname: string;
  kind: string;
  /** Repo-relative POSIX path. */
  path: string;
  line: number;
  endLine?: number;
  signature: string;
}

export function renderSymbol(s: CodeSymbol): string {
  const span = `${s.line}${s.endLine && s.endLine !== s.line ? `-${s.endLine}` : ""}`;
  return `${s.path}:${span}  ${s.kind} ${s.qualname}${s.signature ? `  ${s.signature}` : ""}`;
}

const REGEX_PATTERNS: [RegExp, string][] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/, "function"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/, "func"],
  [/^type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "type"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, "fn"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z_]\w*)/, "type"],
  [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/, "def"],
  [/^\s*(?:class|module)\s+([A-Z]\w*)/, "class"],
  [/^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized)\s+)+[\w<>[\],.? ]+\s+([A-Za-z_]\w*)\s*\([^;]*$/, "method"],
  [/^\s*(?:public\s+|private\s+|protected\s+)?(?:static\s+)?function\s+&?([A-Za-z_]\w*)\s*\(/, "function"],
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "return", "catch", "new"]);

export function regexSymbols(source: string, rel: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 400) continue;
    for (const [rx, kind] of REGEX_PATTERNS) {
      const m = rx.exec(line);
      if (!m) continue;
      if (!KEYWORDS.has(m[1])) out.push({ name: m[1], qualname: m[1], kind, path: rel, line: i + 1, signature: line.trim().slice(0, 120) });
      break;
    }
  }
  return out;
}

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)\s*(\([^)]*\)?)?/;
const PY_CONST = /^([A-Z][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/;

/** Indentation-aware Python symbols (stand-in for `ast`): qualnames, spans, arg-name signatures. */
export function pythonSymbols(source: string, rel: string): CodeSymbol[] {
  const lines = source.split(/\r?\n/);
  const out: CodeSymbol[] = [];
  const stack: { indent: number; qual: string; sym: CodeSymbol }[] = [];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const close = (indent: number, endLine: number) => {
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()!.sym.endLine = endLine;
  };
  let lastCode = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const ind = indentOf(line);
    close(ind, lastCode);
    lastCode = i + 1;
    const m = PY_DEF.exec(line);
    if (m) {
      const [, , kw, name, rawArgs] = m;
      const prefix = stack.length ? stack[stack.length - 1].qual : "";
      const kind = kw === "class" ? "class" : prefix ? "method" : "def";
      let sig = "";
      if (rawArgs) {
        const inner = rawArgs.replace(/^\(|\)$/g, "");
        sig = kw === "class"
          ? (inner.trim() ? `(${inner.trim()})` : "")
          : `(${inner.split(",").map((a) => a.split(/[:=]/)[0].trim()).filter((a) => a && a !== "/" && a !== "*" ).join(", ")})`;
      }
      const qual = prefix ? `${prefix}.${name}` : name;
      const sym: CodeSymbol = { name, qualname: qual, kind, path: rel, line: i + 1, signature: sig };
      out.push(sym);
      if (stack.length < 4) stack.push({ indent: ind, qual, sym });
      continue;
    }
    if (ind === 0) {
      const c = PY_CONST.exec(line);
      if (c) out.push({ name: c[1], qualname: c[1], kind: "var", path: rel, line: i + 1, signature: "" });
    }
  }
  close(0, lastCode);
  return out;
}

export function fileSymbols(rel: string, source: string): CodeSymbol[] {
  const ext = path.extname(rel);
  return ext === ".py" || ext === ".pyi" ? pythonSymbols(source, rel) : regexSymbols(source, rel);
}

const DEF_KINDS = new Set(["class", "def", "function", "func", "fn", "method"]);

/** Lazily built index over the repo's code files. */
export class SymbolIndex {
  private byNameMap: Map<string, CodeSymbol[]> | null = null;
  private readonly byFile = new Map<string, CodeSymbol[]>();
  readonly files: string[];

  constructor(readonly root: string, files: Iterable<string>) {
    this.files = [...files].filter((f) => CODE_EXTS.has(path.extname(f)));
  }

  static async forRoot(root: string): Promise<SymbolIndex> {
    return new SymbolIndex(root, await walkFiles(root));
  }

  async build(): Promise<Map<string, CodeSymbol[]>> {
    if (this.byNameMap) return this.byNameMap;
    const byName = new Map<string, CodeSymbol[]>();
    for (const rel of this.files) {
      const syms = await this.symbolsIn(rel);
      for (const s of syms) {
        const arr = byName.get(s.name);
        if (arr) arr.push(s);
        else byName.set(s.name, [s]);
      }
    }
    this.byNameMap = byName;
    return byName;
  }

  async symbolsIn(rel: string): Promise<CodeSymbol[]> {
    const cached = this.byFile.get(rel);
    if (cached) return cached;
    const abs = path.join(this.root, rel);
    const st = await fs.stat(abs).catch(() => null);
    const syms = st && st.size <= 1_500_000 ? fileSymbols(rel, await fs.readFile(abs, "utf8").catch(() => "")) : [];
    this.byFile.set(rel, syms);
    return syms;
  }

  async lookup(query: string, limit = 20): Promise<CodeSymbol[]> {
    const q = query.trim().replace(/^[`'"()]+|[`'"()]+$/g, "");
    if (!q) return [];
    const byName = await this.build();
    const parts = q.split(/[.:#]+/).filter(Boolean);
    const leaf = parts[parts.length - 1] ?? q;
    let cands = [...(byName.get(leaf) ?? [])];
    if (parts.length > 1) {
      const suffix = parts.slice(-2).join(".");
      const narrowed = cands.filter((s) => s.qualname.endsWith(suffix));
      const hint = parts.slice(0, -1).join("/");
      const byPath = cands.filter((s) => s.path.replace(/\.py$/, "").includes(hint));
      cands = narrowed.length ? narrowed : byPath.length ? byPath : cands;
    }
    if (!cands.length) {
      const low = leaf.toLowerCase();
      for (const [name, syms] of byName) if (name.toLowerCase() === low) cands.push(...syms);
    }
    const rank = (s: CodeSymbol): [number, number, number] =>
      [Number(s.path.toLowerCase().includes("test")), Number(!DEF_KINDS.has(s.kind)), s.path.length];
    cands.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2];
    });
    return cands.slice(0, limit);
  }

  invalidate(rel: string): void {
    this.byFile.delete(rel);
    this.byNameMap = null;
  }
}

/** Compact `find_definition` output: one line per candidate. */
export async function findDefinition(index: SymbolIndex, query: string, limit = 10): Promise<string> {
  const hits = await index.lookup(query, limit);
  if (!hits.length) return `No definition found for ${JSON.stringify(query)}.`;
  return hits.map(renderSymbol).join("\n");
}

/** Compact per-file outline (`symbols_in`). */
export async function outlineFile(index: SymbolIndex, rel: string): Promise<string> {
  const syms = await index.symbolsIn(rel);
  if (!syms.length) return `No symbols in ${rel}.`;
  return syms.map((s) => `${s.line}${s.endLine && s.endLine !== s.line ? `-${s.endLine}` : ""}  ${s.kind} ${s.qualname}${s.kind === "def" || s.kind === "method" || s.kind === "class" ? s.signature : ""}`).join("\n");
}

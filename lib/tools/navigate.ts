/**
 * Structural navigation for the solver's `view` and `find_symbols` tools.
 *
 * - `renderView`: small files and explicit ranges come back numbered; a
 *   large file comes back as a symbol outline with only the sections that
 *   mention the agent's recent search terms expanded (the Rovo Dev pattern:
 *   structure first, detail where the agent is already looking).
 * - `findSymbols`: definitions from the code graph with their callers,
 *   falling back to a definition-shaped grep for files the graph lacks.
 * - `searchTerms`: the identifiers a grep/rg/find command was looking for,
 *   which feed the expansion above.
 */

import { searchCode, type EngineInput } from "@/lib/context/engine";
import { numberLines } from "@/lib/tools/editor";

export const VIEW_FULL_MAX_LINES = 400;
const VIEW_RANGE_MAX = 400;
const SECTION_MAX = 120;
const OUTLINE_MAX = 200;

const DEF_RE =
  /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:def|class|function\*?|interface|type|enum|struct|impl|fn|func|trait|module)\s+[A-Za-z_$][\w$]*|^(\s*)(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\(|function|[A-Za-z_$][\w$]*\s*=>)|^(\s+)(?:(?:public|private|protected|static|async|get|set|override|readonly)\s+)*(?!(?:if|for|while|switch|catch|return|else|do|with)\b)[A-Za-z_$][\w$]*\s*\([^)]*\)\s*(?::[^={]+)?\{\s*$/;
const TERM_STOP = new Set([
  "def", "class", "function", "const", "let", "var", "import", "from", "return", "self", "async", "await",
  "true", "false", "none", "null", "the", "and", "for", "with", "export", "type", "interface",
]);

interface Section {
  start: number;
  end: number;
  indent: number;
}

function indentWidth(line: string): number {
  return (line.match(/^[ \t]*/)?.[0] ?? "").replace(/\t/g, "    ").length;
}

/**
 * Definition lines and the block each one spans (0-based, inclusive): up to
 * the first later line indented no deeper than the definition, which is
 * included when it closes the block (`}`, `end`).
 */
function sections(lines: string[]): Section[] {
  const out: Section[] = [];
  lines.forEach((text, start) => {
    if (!DEF_RE.test(text)) return;
    const indent = indentWidth(text);
    let end = lines.length - 1;
    for (let k = start + 1; k < lines.length; k += 1) {
      const next = lines[k];
      if (!next.trim() || indentWidth(next) > indent) continue;
      end = /^\s*(?:[}\])]|end\b)/.test(next) ? k : k - 1;
      break;
    }
    while (end > start && !lines[end].trim()) end -= 1;
    out.push({ start, end, indent });
  });
  return out;
}

function mentions(line: string, terms: string[]): boolean {
  const low = line.toLowerCase();
  return terms.some((t) => low.includes(t.toLowerCase()));
}

/** A file for the `view` tool: numbered, a numbered range, or an outline with relevant sections expanded. */
export function renderView(path: string, source: string, options: { start?: number; end?: number; terms?: string[] } = {}): string {
  const lines = source.replace(/^﻿/, "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const n = lines.length;

  if (options.start !== undefined || options.end !== undefined) {
    const start = Math.max(1, options.start ?? 1);
    if (start > n) return `Error: start_line ${start} is past the end of ${path} (${n} lines).`;
    let end = Math.min(n, options.end === undefined || options.end === -1 ? n : Math.max(start, options.end));
    let note = "";
    if (end - start + 1 > VIEW_RANGE_MAX) {
      end = start + VIEW_RANGE_MAX - 1;
      note = `\n[range capped at ${VIEW_RANGE_MAX} lines; request the next range to continue]`;
    }
    return `${path} (lines ${start}-${end} of ${n})\n${numberLines(lines.slice(start - 1, end), start)}${note}`;
  }
  if (n <= VIEW_FULL_MAX_LINES) return `${path} (${n} lines)\n${numberLines(lines)}`;

  const secs = sections(lines);
  const terms = (options.terms ?? []).filter(Boolean);
  const shown = new Set<number>();
  for (const s of secs.slice(0, OUTLINE_MAX)) shown.add(s.start);
  const expanded: string[] = [];
  if (terms.length) {
    for (let i = 0; i < n; i += 1) {
      if (!mentions(lines[i], terms)) continue;
      // The innermost definition around the hit; a long one shows a window instead.
      const around = secs.filter((s) => s.start <= i && i <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      const [lo, hi] =
        around && around.end - around.start < SECTION_MAX ? [around.start, around.end] : [Math.max(0, i - 15), Math.min(n - 1, i + 15)];
      for (let k = lo; k <= hi; k += 1) shown.add(k);
      if (expanded.length < 8) expanded.push(`${lo + 1}-${hi + 1}`);
    }
  }
  if (!expanded.length) for (let k = 0; k < Math.min(n, 30); k += 1) shown.add(k);

  const out: string[] = [];
  let prev = -1;
  for (const i of [...shown].sort((a, b) => a - b)) {
    if (prev >= 0 && i > prev + 1) out.push("     ⋮");
    out.push(numberLines([lines[i]], i + 1));
    prev = i;
  }
  if (prev < n - 1) out.push("     ⋮");
  const head = expanded.length
    ? `${path} is long (${n} lines). Outline, with the sections matching your recent searches (${terms.slice(0, 6).join(", ")}) expanded at lines ${expanded.join(", ")}:`
    : `${path} is long (${n} lines). Outline (definition lines) and the first 30 lines:`;
  return `${head}\n${out.join("\n")}\n[Use view with start_line/end_line to read any other region.]`;
}

/** Definitions of a symbol: graph first, grep for what the graph does not cover. */
export async function findSymbols(engine: EngineInput, query: string): Promise<string> {
  const parts = query.trim().split(/[.:#\s]+/).filter(Boolean);
  const name = parts.at(-1) ?? "";
  if (!name) return "Error: `query` is required.";
  const qualifier = parts.length > 1 ? parts[parts.length - 2].toLowerCase() : "";
  const nodes = engine.graph?.nodes ?? [];
  let hits = nodes.filter((n) => n.name === name || n.name.endsWith(`.${name}`));
  if (!hits.length) hits = nodes.filter((n) => n.name.toLowerCase().includes(name.toLowerCase()));
  if (qualifier) {
    const q = (n: (typeof hits)[number]) => (`${n.file} ${n.name}`.toLowerCase().includes(qualifier) ? 0 : 1);
    hits = [...hits].sort((a, b) => q(a) - q(b));
  }
  if (hits.length) {
    const edges = engine.graph?.edges ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n] as const));
    const rows = hits.slice(0, 12).map((n) => {
      const callers = [
        ...new Set(
          edges
            .filter((e) => e.target === n.id && e.kind === "call")
            .map((e) => byId.get(e.source))
            .filter((c): c is NonNullable<typeof c> => Boolean(c))
            .map((c) => `${c.name} (${c.file}:${c.startLine})`),
        ),
      ];
      const used = callers.length ? `\n    called by: ${callers.slice(0, 6).join(", ")}${callers.length > 6 ? ", …" : ""}` : "";
      return `${n.file}:${n.startLine}-${n.endLine}  ${n.kind} ${n.name}\n    ${n.signature.split("\n")[0].slice(0, 200)}${used}`;
    });
    const more = hits.length > 12 ? `\n… ${hits.length - 12} more; qualify the name (e.g. Class.method).` : "";
    const text = `${hits.length} definition(s) for ${query}:\n${rows.join("\n")}${more}`;
    const shown = hits.slice(0, 12);
    engine.ledger.record("find_symbols", query, text, {
      paths: shown.map((n) => n.file),
      nodeIds: shown.map((n) => n.id),
    });
    return text;
  }
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = `\\b(def|class|function|interface|type|enum|struct|fn|func)\\s+${esc}\\b|\\b(const|let|var)\\s+${esc}\\s*=|^\\s*${esc}\\s*[:=]`;
  const found = await searchCode(engine, pattern, { regex: true, maxResults: 20 });
  return found.startsWith("No matches")
    ? `No definition found for ${query}. Try run_command with \`grep -rn "${name}" .\` to find where it is used.`
    : `Definitions found by text search (the code graph does not index them):\n${found}`;
}

const SEARCH_TOOLS = /^(grep|egrep|fgrep|rg|ag|ack|find)$/;
const ARG_FLAGS = new Set(["-e", "--regexp", "-name", "-iname", "-path", "-ipath", "-regex"]);
const SKIP_FLAGS = new Set(["-A", "-B", "-C", "-m", "-g", "--glob", "-t", "--type", "--include", "--exclude", "-type", "-maxdepth", "-mindepth"]);

/** Identifiers a grep/rg/find command searched for. */
export function searchTerms(command: string): string[] {
  const terms: string[] = [];
  for (const segment of command.split(/\||&&|;/)) {
    const tokens = [...segment.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    let i = tokens.findIndex((t) => SEARCH_TOOLS.test(t) || t === "git");
    if (i < 0) continue;
    if (tokens[i] === "git") {
      if (tokens[i + 1] !== "grep") continue;
      i += 1;
    }
    const isFind = tokens[i] === "find";
    let pattern: string | null = null;
    for (let k = i + 1; k < tokens.length; k += 1) {
      const t = tokens[k];
      if (ARG_FLAGS.has(t)) {
        pattern = tokens[k + 1] ?? null;
        break;
      }
      if (SKIP_FLAGS.has(t)) k += 1;
      else if (!t.startsWith("-") && !isFind) {
        pattern = t;
        break;
      }
    }
    if (!pattern) continue;
    for (const word of pattern.replace(/\\[bswdBSWD]/g, " ").match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
      if (!TERM_STOP.has(word.toLowerCase()) && !(isFind && /^(py|js|ts|tsx|jsx|go|rs)$/.test(word))) terms.push(word);
    }
  }
  return [...new Set(terms)];
}

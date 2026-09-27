/**
 * The tolerant `str_replace` editor behind `edit_file` (ported from Pramana
 * `tools/editor.py`). Three features matter most for weaker models:
 *
 * 1. **Tolerant matching.** When `find` is not present verbatim, retry with
 *    (a) line-number prefixes pasted from a view removed, (b) trailing
 *    whitespace ignored, (c) indentation ignored — the replacement is then
 *    re-indented to the file's style. Only a UNIQUE match is ever applied.
 * 2. **Helpful misses.** With no match, show the most similar region of the
 *    file with line numbers, so the model corrects itself in one step.
 * 3. **Lint gate.** An edit that turns a parseable file into an unparseable
 *    one (py / json / js / ts) is rejected before it lands, with the error.
 *
 * Plus: back-and-forth edits (a file returning to an earlier version) are
 * flagged, and CRLF line endings and a UTF-8 BOM are preserved.
 */

import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { parse as babelParse, type ParserPlugin } from "@babel/parser";

/** Per-run editor state: created/touched files and oscillation. */
export interface EditSession {
  states: Map<string, string[]>;
  touched: string[];
  created: string[];
  oscillations: number;
}

export function createEditSession(): EditSession {
  return { states: new Map(), touched: [], created: [], oscillations: 0 };
}

/** A line-number column pasted from `view` (tab) or `read_file` (box bar). */
const LINE_NO_RE = /^\s*\d+(?:\t|\u2502 ?)/;

/* ------------------------------ text style ------------------------------- */

export interface TextStyle {
  ending: "\n" | "\r\n";
  bom: boolean;
}

/** Normalize to `\n` without BOM, remembering the original style. */
export function splitStyle(raw: string): { text: string; style: TextStyle } {
  const bom = raw.startsWith("\ufeff");
  const body = bom ? raw.slice(1) : raw;
  const crlf = (body.match(/\r\n/g) ?? []).length;
  const lf = (body.match(/\n/g) ?? []).length;
  const ending = crlf > 0 && crlf >= lf - crlf ? "\r\n" : "\n";
  return { text: body.replace(/\r\n/g, "\n"), style: { ending, bom } };
}

/** Write back in the file's original style, so the diff stays minimal. */
export function applyStyle(text: string, style: TextStyle): string {
  const body = style.ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
  return style.bom ? `\ufeff${body}` : body;
}

/* ------------------------------ matching --------------------------------- */

function indentOf(s: string): string {
  return s.slice(0, s.length - s.replace(/^[ \t]+/, "").length);
}

function width(s: string): number {
  return indentOf(s).replace(/\t/g, "    ").length;
}

/** Map the indentation scheme the model used onto the file's, level by level. */
export function reindent(newLines: string[], oldLines: string[], fileWindow: string[]): string[] {
  const mapping = new Map<number, string>();
  for (let i = 0; i < Math.min(oldLines.length, fileWindow.length); i += 1) {
    const o = oldLines[i];
    const f = fileWindow[i];
    if (o.trim() && f.trim() && !mapping.has(width(o))) mapping.set(width(o), indentOf(f));
  }
  const keys = [...mapping.keys()].sort((a, b) => a - b);
  let ratio = 1;
  for (const k of keys) {
    const pre = mapping.get(k)!;
    if (k > 0 && !pre.includes("\t")) {
      ratio = pre.length / k;
      break;
    }
  }
  return newLines.map((line) => {
    if (!line.trim()) return "";
    const w = width(line);
    let pre: string;
    if (mapping.has(w)) pre = mapping.get(w)!;
    else {
      const lower = keys.filter((k) => k <= w);
      if (lower.length) {
        const base = lower[lower.length - 1];
        const extra = Math.round((w - base) * ratio);
        const basePre = mapping.get(base)!;
        pre = basePre + (basePre.includes("\t") ? "\t".repeat(Math.max(1, Math.floor(extra / 4))) : " ".repeat(extra));
      } else pre = indentOf(line);
    }
    return pre + line.replace(/^[ \t]+/, "");
  });
}

export function numberLines(lines: string[], start = 1): string {
  return lines
    .map((line, i) => {
      const shown = line.length > 500 ? `${line.slice(0, 500)} …[line truncated]` : line;
      return `${String(i + start).padStart(6)}\t${shown}`;
    })
    .join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function tolerant(content: string, oldStr: string, newStr: string): { after: string; note: string } | null {
  let oldLines = oldStr.split("\n");
  let find = oldStr;
  let replacement = newStr;
  // (a) Line-number prefixes pasted from view output.
  if (oldLines.every((l) => LINE_NO_RE.test(l) || !l.trim()) && oldLines.some((l) => LINE_NO_RE.test(l))) {
    find = oldLines.map((l) => l.replace(LINE_NO_RE, "")).join("\n");
    const newLines = newStr.split("\n");
    if (newLines.some((l) => LINE_NO_RE.test(l))) {
      replacement = newLines.map((l) => l.replace(LINE_NO_RE, "")).join("\n");
    }
    if (countOccurrences(content, find) === 1) {
      return {
        after: content.replace(find, () => replacement),
        note: "(matched after removing pasted line numbers)",
      };
    }
    oldLines = find.split("\n");
  }

  const fileLines = content.split("\n");
  while (oldLines.length && !oldLines[0].trim()) oldLines = oldLines.slice(1);
  while (oldLines.length && !oldLines[oldLines.length - 1].trim()) oldLines = oldLines.slice(0, -1);
  if (!oldLines.length) return null;
  const k = oldLines.length;

  const windows = (norm: (s: string) => string): number[] => {
    const target = oldLines.map(norm);
    const hits: number[] = [];
    for (let i = 0; i + k <= fileLines.length; i += 1) {
      if (norm(fileLines[i]) !== target[0]) continue;
      let ok = true;
      for (let j = 1; j < k; j += 1) {
        if (norm(fileLines[i + j]) !== target[j]) {
          ok = false;
          break;
        }
      }
      if (ok) hits.push(i);
    }
    return hits;
  };

  // (b) Trailing whitespace.
  let hits = windows((s) => s.trimEnd());
  if (hits.length === 1) {
    const i = hits[0];
    const out = [...fileLines.slice(0, i), ...replacement.split("\n"), ...fileLines.slice(i + k)];
    return { after: out.join("\n"), note: "(matched ignoring trailing whitespace)" };
  }
  // (c) Indentation-insensitive; re-indent the replacement.
  hits = windows((s) => s.trim());
  if (hits.length === 1) {
    const i = hits[0];
    const block = reindent(replacement.split("\n"), oldLines, fileLines.slice(i, i + k));
    const out = [...fileLines.slice(0, i), ...block, ...fileLines.slice(i + k)];
    return {
      after: out.join("\n"),
      note: "(matched ignoring indentation; replacement re-indented to the file's style)",
    };
  }
  return null;
}

function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i += 1) {
    const g = s.slice(i, i + 2);
    map.set(g, (map.get(g) ?? 0) + 1);
  }
  return map;
}

/** Dice coefficient over character bigrams: cheap and good enough to point at a region. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** A miss report shows the similar region whole up to this many lines. */
const MISS_MAX_LINES = 30;

function missReport(content: string, oldStr: string, rel: string): string {
  const fileLines = content.split("\n");
  const oldLines = oldStr.split("\n");
  const k = Math.max(1, oldLines.length);
  const target = oldLines.map((l) => l.trim()).join("\n");
  const firstTok = oldLines[0]?.trim().slice(0, 12) ?? "";
  let best = 0;
  let bestI = -1;
  for (let i = 0; i < Math.max(1, fileLines.length - k + 1); i += 1) {
    const window = fileLines
      .slice(i, i + k)
      .map((l) => l.trim())
      .join("\n");
    let r = similarity(target, window);
    if (firstTok && window.includes(firstTok)) r += 0.02;
    if (r > best) {
      best = r;
      bestI = i;
    }
  }
  let message = `Error: \`find\` text was not found in ${rel} (not even ignoring whitespace/indentation).`;
  if (bestI >= 0 && best > 0.45) {
    const lo = Math.max(0, bestI - 2);
    const hi = Math.min(fileLines.length, bestI + k + 2);
    // A long `find` must not come back whole: show its ends only.
    const region = hi - lo > MISS_MAX_LINES ? changeSnippet(fileLines, bestI, bestI + k - 1) : numberLines(fileLines.slice(lo, hi), lo + 1);
    message += `\nThe most similar region (${Math.round(Math.min(1, best) * 100)}% similar) is lines ${bestI + 1}-${bestI + k}:\n${region}\nCopy the exact current text from the file (without the line-number column) into \`find\`.`;
  } else {
    message += " Read the relevant lines again to copy the exact current text.";
  }
  return message;
}

export type ReplaceOutcome =
  | { ok: true; after: string; note: string; occurrences: number }
  | { ok: false; error: string };

/** Apply a str_replace to normalized (`\n`) text with Pramana's tolerance rules. */
export function strReplace(
  content: string,
  find: string,
  replace: string,
  options: { replaceAll?: boolean; path?: string } = {},
): ReplaceOutcome {
  const rel = options.path ?? "the file";
  const oldStr = find.replace(/\r\n/g, "\n");
  const newStr = replace.replace(/\r\n/g, "\n");
  if (!oldStr) {
    return { ok: false, error: "Error: `find` must be non-empty (use create_file to create a file)." };
  }
  if (oldStr === newStr) {
    return { ok: false, error: "Error: `find` and `replace` are identical; nothing to change." };
  }
  const count = countOccurrences(content, oldStr);
  if (count === 0) {
    const t = tolerant(content, oldStr, newStr);
    if (!t) return { ok: false, error: missReport(content, oldStr, rel) };
    return { ok: true, after: t.after, note: t.note, occurrences: 1 };
  }
  if (count > 1 && !options.replaceAll) {
    const lines: number[] = [];
    let start = 0;
    for (let i = 0; i < count && lines.length < 10; i += 1) {
      const idx = content.indexOf(oldStr, start);
      lines.push(content.slice(0, idx).split("\n").length);
      start = idx + 1;
    }
    return {
      ok: false,
      error: `Error: \`find\` matches ${count} times in ${rel} (starting at lines ${lines.join(", ")}). Include more surrounding lines to make it unique, or set replace_all: true.`,
    };
  }
  const after = options.replaceAll
    ? content.split(oldStr).join(newStr)
    : content.replace(oldStr, () => newStr);
  return { ok: true, after, note: "", occurrences: count };
}

export interface EditSpec {
  oldStr: string;
  newStr: string;
  replaceAll?: boolean;
}

/**
 * Apply several str_replaces in order, all or nothing: each edit sees the
 * result of the ones before it, and the first failure aborts the batch with
 * its 1-based index, so nothing is half-applied.
 */
export function multiReplace(
  content: string,
  edits: EditSpec[],
  path?: string,
): { ok: true; after: string; notes: string[]; occurrences: number } | { ok: false; error: string } {
  let current = content;
  const notes: string[] = [];
  let occurrences = 0;
  for (const [i, edit] of edits.entries()) {
    const outcome = strReplace(current, edit.oldStr, edit.newStr, { replaceAll: edit.replaceAll, path });
    if ("error" in outcome) {
      return {
        ok: false,
        error: `Error: edit ${i + 1} of ${edits.length} failed, so NONE of the edits were applied.\n${outcome.error.replace(/^Error: /, "")}`,
      };
    }
    current = outcome.after;
    occurrences += outcome.occurrences;
    if (outcome.note) notes.push(`edit ${i + 1} ${outcome.note}`);
  }
  return { ok: true, after: current, notes, occurrences };
}

/* ------------------------------ lint gate -------------------------------- */

let pythonAvailable: boolean | null = null;

function hasPython(): boolean {
  if (pythonAvailable === null) {
    try {
      pythonAvailable = spawnSync("python3", ["-c", "pass"], { timeout: 5000 }).status === 0;
    } catch {
      pythonAvailable = false;
    }
  }
  return pythonAvailable;
}

const PY_CHECK =
  "import ast,sys\nsrc=sys.stdin.read()\ntry:\n ast.parse(src)\nexcept SyntaxError as e:\n print(f'SyntaxError: {e.msg} (line {e.lineno})');print('    '+(e.text or '').rstrip());sys.exit(1)";

function checkPython(content: string): Promise<string | null> {
  if (!hasPython()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const child = execFile("python3", ["-c", PY_CHECK], { timeout: 15_000 }, (error, stdout) => {
      if (!error) return resolve(null);
      const text = String(stdout ?? "").trim();
      resolve(text || null);
    });
    child.stdin?.end(content);
  });
}

function babelPlugins(ext: string): ParserPlugin[] | null {
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") return ["typescript"];
  if (ext === ".tsx") return ["typescript", "jsx"];
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return ["jsx"];
  return null;
}

/** A human-readable syntax error for supported file types, else null. */
export async function syntaxError(filePath: string, content: string): Promise<string | null> {
  const dot = filePath.lastIndexOf(".");
  const ext = dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  if (ext === ".py" || ext === ".pyi") return checkPython(content);
  if (ext === ".json") {
    try {
      JSON.parse(content);
      return null;
    } catch (error) {
      return `JSON error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const plugins = babelPlugins(ext);
  if (plugins) {
    try {
      babelParse(content, {
        sourceType: "unambiguous",
        plugins: [...plugins, "decorators-legacy", "classProperties", "topLevelAwait"],
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        errorRecovery: false,
      });
      return null;
    } catch (error) {
      const e = error as { message?: string; loc?: { line: number; column: number } };
      const line = e.loc ? content.split("\n")[e.loc.line - 1] ?? "" : "";
      return `SyntaxError: ${e.message ?? String(error)}${line ? `\n    ${line}` : ""}`;
    }
  }
  return null;
}

/* ------------------------------ commit ----------------------------------- */

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export function recordWrite(session: EditSession | undefined, path: string, created: boolean): void {
  if (!session) return;
  if (!session.touched.includes(path)) session.touched.push(path);
  if (created && !session.created.includes(path)) session.created.push(path);
}

/** Lines of a changed region shown in full; a longer one shows only its ends. */
const SNIPPET_MAX_LINES = 12;

/**
 * Numbered context around lines `first..last` (0-based) of `lines`. A large
 * change never comes back whole: the model just wrote it, and echoing it
 * doubles its cost in the transcript.
 */
export function changeSnippet(lines: string[], first: number, last: number): string {
  const lo = Math.max(0, first - 4);
  const hi = Math.min(lines.length, Math.max(last + 1, first + 1) + 4);
  if (hi - lo <= SNIPPET_MAX_LINES + 8) return numberLines(lines.slice(lo, hi), lo + 1);
  const headEnd = first + 4;
  const tailStart = Math.max(headEnd, last - 3);
  return `${numberLines(lines.slice(lo, headEnd), lo + 1)}\n     …\t[${tailStart - headEnd} lines not shown]\n${numberLines(lines.slice(tailStart, hi), tailStart + 1)}`;
}

export type CommitCheck = { ok: true; message: string } | { ok: false; error: string };

/**
 * Lint-gate an edit and describe it: rejected when it would make a parseable
 * file unparseable; otherwise returns the result message with a numbered
 * snippet around the change and an oscillation warning when the file returns
 * to a version it already had.
 */
export async function checkEdit(
  session: EditSession | undefined,
  path: string,
  before: string,
  after: string,
  note = "",
): Promise<CommitCheck> {
  const [beforeErr, afterErr] = await Promise.all([syntaxError(path, before), syntaxError(path, after)]);
  if (afterErr && !beforeErr) {
    return {
      ok: false,
      error: `Error: edit NOT applied: it would make ${path} unparseable.\n${afterErr}\nFix the replacement text (check indentation, brackets, quotes) and try again.`,
    };
  }

  let revisit = false;
  if (session) {
    const states = session.states.get(path) ?? [hash(before)];
    const h = hash(after);
    revisit = states.slice(0, -1).includes(h);
    states.push(h);
    session.states.set(path, states);
    if (revisit) session.oscillations += 1;
  }

  const a = before.split("\n");
  const b = after.split("\n");
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first += 1;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= first && endB >= first && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const added = Math.max(0, endB - first + 1);
  const removed = Math.max(0, endA - first + 1);
  let message = `Edited ${path} (+${added} -${removed} lines, now ${b.length})${note ? ` ${note}` : ""}. Result:\n${changeSnippet(b, first, endB)}`;
  if (afterErr && beforeErr) message += `\nNote: the file was already unparseable before this edit:\n${afterErr}`;
  if (revisit) {
    message +=
      "\nNOTE: this edit returns the file to a version it already had earlier - you are going back and forth. Stop editing and re-think: re-read the issue, and use `compare` to check whether the failure you are chasing already existed before your changes (then it is not yours to fix).";
  }
  return { ok: true, message };
}

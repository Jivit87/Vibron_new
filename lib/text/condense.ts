/**
 * Issue-text condensing, applied once at intake (Pramana `repo/issue.py`).
 *
 * The issue text is part of the solver's first message, so it is re-sent on
 * every model turn. Its prose and short code carry the signal; long pasted
 * outputs (CI logs, `pip freeze` / `npm ls` dumps, deep tracebacks) mostly do
 * not. Those are cut to their start and end, keeping what matters: a
 * traceback's last frames and its error line, a log's first and last lines.
 *
 * Pure and deterministic: the same text always condenses to the same bytes,
 * so a cached prompt prefix built from it stays stable.
 */

/** A fenced block longer than this (chars) is shortened. */
export const BLOCK_LIMIT = 1800;
/** Default cap on the whole condensed text. */
export const ISSUE_MAX_CHARS = 12_000;

const FENCE_RE = /(^|\n)([ \t]*(`{3,}|~{3,})[^\n]*\n)([\s\S]*?)(\n[ \t]*\3[ \t]*)(?=\n|$)/g;
/** `name 1.2.3`, `name==1.2.3`, `name@1.2.3`, `├── name@1.2.3`: one line of a package list. */
const PKG_LINE_RE = /^[\s│├└─`|+\\-]*@?[A-Za-z0-9_.\-[\]/]+(\s+v?|\s*[=~<>!]=\s*|@)v?\d+(\.[\w\-+]+)*\s*$/;
const TRACEBACK_START_RE = /^\s*(Traceback \(most recent call last\):|Exception in thread|Caused by:)/;
const JS_FRAME_RE = /^\s+at\s+\S/;
const PY_FRAME_RE = /^\s*File "[^"]*", line \d+/;

function elided(count: number, what: string): string {
  return `[... ${count} lines of ${what} elided ...]`;
}

/** Keep `head` and `tail` lines; elide the middle when that saves real space. */
export function elideLines(lines: string[], head: number, tail: number, what: string): string[] {
  if (lines.length <= head + tail + 4) return lines;
  return [...lines.slice(0, head), elided(lines.length - head - tail, what), ...lines.slice(lines.length - tail)];
}

function isPackageLine(line: string): boolean {
  return PKG_LINE_RE.test(line);
}

function isFrameLine(line: string): boolean {
  return JS_FRAME_RE.test(line) || PY_FRAME_RE.test(line);
}

/**
 * A long traceback / stack trace: keep the header, the last frames (where
 * the fault usually is) and the error line after them. JS stacks put the
 * error line first, so the start is kept too.
 */
function condenseTraces(lines: string[], keepFrames = 3): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    // A run of frames: Python frames come with their source line indented under them.
    if (isFrameLine(lines[i]!)) {
      const start = i;
      const frames: number[] = [];
      while (i < lines.length && (isFrameLine(lines[i]!) || (frames.length > 0 && /^\s{4,}\S/.test(lines[i]!) && !isFrameLine(lines[i]!)))) {
        if (isFrameLine(lines[i]!)) frames.push(i);
        i += 1;
      }
      if (frames.length > keepFrames * 2 + 2) {
        const firstKept = frames[1]!; // the entry frame, then the last `keepFrames`
        const lastStart = frames[frames.length - keepFrames]!;
        out.push(...lines.slice(start, firstKept));
        out.push(`    [... ${frames.length - 1 - keepFrames} frames elided ...]`);
        out.push(...lines.slice(lastStart, i));
      } else {
        out.push(...lines.slice(start, i));
      }
      continue;
    }
    out.push(lines[i]!);
    i += 1;
  }
  return out;
}

/** Shorten one long block of pasted output. */
function condenseBlock(body: string, limit: number): string {
  // A package list is noise at any length past a screenful.
  const bodyLines = body.split("\n");
  if (bodyLines.length > 20 && bodyLines.filter(isPackageLine).length > bodyLines.length * 0.5) {
    return elideLines(bodyLines, 5, 3, "package list").join("\n");
  }
  if (body.length <= limit) return body;
  let lines = condenseTraces(body.split("\n"));
  if (lines.join("\n").length <= limit) return lines.join("\n");
  const pkg = lines.filter(isPackageLine).length;
  const hasTrace = lines.some((l) => TRACEBACK_START_RE.test(l) || isFrameLine(l));
  const what = pkg > lines.length * 0.5 ? "package list" : hasTrace ? "traceback" : "output";
  // A traceback's error line is last: keep more of the end than the start.
  lines = elideLines(lines, hasTrace ? 12 : 25, hasTrace ? 25 : 15, what);
  let text = lines.join("\n");
  // Very long single lines (minified output, a JSON blob) survive line elision.
  if (text.length > limit * 2) {
    const half = limit;
    text = `${text.slice(0, half)}\n[... ${text.length - half * 2} chars elided ...]\n${text.slice(-half)}`;
  }
  return text;
}

/**
 * Condense issue text for a model prompt: prose and short code stay intact;
 * long fenced blocks, unfenced package lists and huge tracebacks are cut to
 * start + end. The result is capped at `maxChars` (start and end kept).
 */
export function condenseIssueText(text: string, maxChars: number = ISSUE_MAX_CHARS): string {
  if (!text) return text;
  let out = text.replace(/\r\n/g, "\n");

  // 1. Long fenced blocks.
  out = out.replace(FENCE_RE, (_m, lead: string, open: string, _fence: string, body: string, close: string) =>
    `${lead}${open}${condenseBlock(body, BLOCK_LIMIT)}${close}`,
  );

  // 2. Unfenced runs: package lists and stack traces pasted without a fence.
  const lines = out.split("\n");
  const kept: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) kept.push(...(run.length > 12 ? elideLines(run, 3, 2, "package list") : run));
    run = [];
  };
  let inFence = false;
  for (const line of lines) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    if (!inFence && isPackageLine(line)) {
      run.push(line);
      continue;
    }
    flush();
    kept.push(line);
  }
  flush();
  out = condenseTraces(kept).join("\n");

  // 3. Hard cap: keep the start (the report) and the end (often the error).
  if (out.length > maxChars) {
    const tail = Math.floor(maxChars * 0.3);
    const head = maxChars - tail;
    out = `${out.slice(0, head)}\n[... ${out.length - head - tail} chars of issue text elided ...]\n${out.slice(out.length - tail)}`;
  }
  return out;
}

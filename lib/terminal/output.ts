/**
 * Pure terminal-output helpers, shared by the server registry and the
 * client. No Node or DOM imports — everything here is unit-testable.
 */

/* ------------------------------- ANSI ------------------------------------ */

/**
 * CSI, OSC, and the handful of two-byte escapes. The literal ESC prefix is
 * load-bearing: without it the pattern also eats ordinary bracketed text
 * such as `[exited with code 0]`.
 */
const ANSI_PATTERN =
  /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEHMNOc]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/* --------------------------- output buffer ------------------------------- */

/**
 * A capped, append-only text log with absolute offsets.
 *
 * `end` counts every character ever written, so a client that saw output up
 * to offset N can reconnect and ask for exactly what it missed — as long as
 * that range has not been evicted. Eviction is by character count rather
 * than chunk count: a single `cat` of a large file is one chunk, and a
 * chunk-count cap would let it hold megabytes.
 */
export class OutputBuffer {
  private text = "";
  /** Absolute offset of `text[0]`. */
  private base = 0;

  constructor(private readonly maxChars = 512 * 1024) {}

  append(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    const overflow = this.text.length - this.maxChars;
    if (overflow > 0) {
      // Drop a little extra so we do not re-slice on every append once full.
      const drop = Math.min(this.text.length, overflow + Math.floor(this.maxChars / 8));
      this.text = this.text.slice(drop);
      this.base += drop;
    }
  }

  clear(): void {
    this.base += this.text.length;
    this.text = "";
  }

  /** Absolute offset one past the last character written. */
  get end(): number {
    return this.base + this.text.length;
  }

  /** Absolute offset of the oldest retained character. */
  get start(): number {
    return this.base;
  }

  toString(): string {
    return this.text;
  }

  /**
   * Everything from absolute offset `since`. `complete` is false when part of
   * that range was already evicted (or cleared) — the caller should treat the
   * result as a reset rather than a delta.
   */
  since(offset: number): { text: string; complete: boolean } {
    if (offset >= this.end) return { text: "", complete: true };
    if (offset < this.base) return { text: this.text, complete: false };
    return { text: this.text.slice(offset - this.base), complete: true };
  }
}

/* ---------------------------- URL detection ------------------------------ */

const URL_PATTERN =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>`]*)?/gi;

/** Normalize a detected dev-server URL so an iframe can load it. */
export function normalizeLocalUrl(raw: string): string {
  return raw
    .replace(/[.,;:)\]}>]+$/, "")
    .replace(/\/\/(?:0\.0\.0\.0|\[::1?\])/, "//localhost");
}

/** Every localhost URL in `text`, ANSI stripped and normalized, in order. */
export function findLocalUrls(text: string): string[] {
  const plain = stripAnsi(text);
  const out: string[] = [];
  for (const match of plain.matchAll(URL_PATTERN)) {
    const url = normalizeLocalUrl(match[0]);
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

export function detectLocalUrl(text: string): string | null {
  const urls = findLocalUrls(text);
  return urls.length ? urls[urls.length - 1] : null;
}

/**
 * Streaming URL detector. Output arrives in arbitrary chunks, and a URL (or
 * the escape sequence colouring it) can straddle a chunk boundary, so the
 * detector re-scans a short tail of the previous chunk alongside each new
 * one. Returns a URL only when it differs from the last one reported.
 */
export class UrlDetector {
  private tail = "";
  private last: string | null = null;

  constructor(initial: string | null = null) {
    this.last = initial;
  }

  push(chunk: string): string | null {
    const window = this.tail + chunk;
    this.tail = window.slice(-256);
    // Only consider URLs that end inside the new chunk — otherwise a URL
    // fully contained in the carried tail would be re-reported.
    const plainChunkEnd = stripAnsi(window);
    const found = findLocalUrls(plainChunkEnd);
    if (!found.length) return null;
    const url = found[found.length - 1];
    if (url === this.last) return null;
    // A truncated URL at the very end of the window might still be growing
    // (`http://localhost:30` then `00/`). Defer if the window ends mid-URL.
    if (/https?:\/\/[^\s]*$/.test(plainChunkEnd) && !/[\s]$/.test(plainChunkEnd)) {
      const trailing = plainChunkEnd.match(/https?:\/\/[^\s]*$/)?.[0] ?? "";
      if (normalizeLocalUrl(trailing) === url && !/:\d{2,5}/.test(trailing)) {
        return null;
      }
    }
    this.last = url;
    return url;
  }

  get current(): string | null {
    return this.last;
  }
}

/* --------------------------- output trimming ----------------------------- */

/**
 * Model-facing cleanup (Pramana `clean_output`): strip ANSI and collapse
 * carriage-return progress bars to their final state. A `pip install` or
 * `npm ci` progress bar is thousands of redraws that carry no information.
 */
export function cleanTerminalOutput(text: string): string {
  return stripAnsi(text)
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter((s) => s.trim());
      return segments.length ? segments[segments.length - 1] : "";
    })
    .join("\n");
}

/**
 * Cap text for a model's context, keeping the head (the command and early
 * errors) and the tail (the summary and exit code). The marker says how
 * much was dropped and how to see it, so the model narrows the command
 * instead of re-running it blind (Pramana `truncate`, 45/55 split).
 */
export function trimHeadTail(
  full: string,
  cap: number,
): { output: string; truncated: boolean; omittedLines: number } {
  if (full.length <= cap) return { output: full, truncated: false, omittedLines: 0 };
  const head = Math.floor(cap * 0.45);
  const tail = cap - head;
  const omitted = full.slice(head, full.length - tail);
  const omittedLines = omitted.split("\n").length - 1;
  return {
    output:
      `${full.slice(0, head)}\n… [${omittedLines} lines / ${omitted.length} chars trimmed to save context. ` +
      `Narrow the command (grep, head, tail, -k, -x) to see a specific part] …\n${full.slice(-tail)}`,
    truncated: true,
    omittedLines,
  };
}

/* ---------------------------- line tracking ------------------------------ */

/**
 * Best-effort reconstruction of the line being typed into a PTY, so the
 * hard-block safety classifier still sees commands in interactive mode.
 *
 * Raw keystrokes do not map cleanly onto the shell's line editor (history
 * recall, tab completion, cursor movement), so once any escape sequence or
 * completion key appears the line is marked `uncertain` and the caller
 * should not trust it. Printable input, backspace, Ctrl+U and Ctrl+C are
 * tracked exactly.
 */
export class LineTracker {
  private line = "";
  private uncertain = false;

  /**
   * Feed raw input. Returns each line submitted with Enter, in order, along
   * with whether it was reconstructed reliably.
   */
  feed(data: string): { line: string; certain: boolean }[] {
    const submitted: { line: string; certain: boolean }[] = [];
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      const code = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") {
        submitted.push({ line: this.line, certain: !this.uncertain });
        this.line = "";
        this.uncertain = false;
        // Treat CRLF as one submit.
        if (ch === "\r" && data[i + 1] === "\n") i++;
      } else if (code === 0x7f || code === 0x08) {
        this.line = this.line.slice(0, -1);
      } else if (code === 0x15 || code === 0x03) {
        // Ctrl+U kills the line; Ctrl+C abandons it.
        this.line = "";
        this.uncertain = false;
      } else if (code === 0x1b) {
        // Arrow keys, history recall, etc. Skip the sequence body.
        this.uncertain = true;
        if (data[i + 1] === "[" || data[i + 1] === "O") {
          i += 2;
          while (i < data.length && !/[@-~]/.test(data[i])) i++;
        }
      } else if (code === 0x09 || code < 0x20) {
        // Tab completion and other control keys edit the line invisibly.
        this.uncertain = true;
      } else {
        this.line += ch;
      }
    }
    return submitted;
  }

  get current(): string {
    return this.line;
  }
}

/* --------------------------- shell cwd capture --------------------------- */

/**
 * Wrap a command for the pipe (non-PTY) shell so its final working
 * directory is reported on fd 3. This is what lets `cd packages/web` in one
 * command carry over to the next, the way a real shell would.
 */
export function wrapWithCwdReport(command: string): string {
  return `${command}\n__vb_ec=$?; { pwd >&3; } 2>/dev/null; exit $__vb_ec`;
}

/** The last non-empty line written to the cwd-report fd. */
export function parseCwdReport(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/** Short, human display of `cwd` relative to the workspace root. */
export function displayCwd(cwd: string, rootPath: string | null): string {
  if (!rootPath) return cwd;
  const root = rootPath.replace(/\/+$/, "");
  if (cwd === root) return "~";
  if (cwd.startsWith(`${root}/`)) return `~/${cwd.slice(root.length + 1)}`;
  return cwd;
}

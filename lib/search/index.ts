/**
 * Workspace text search: ripgrep when it is installed, a JS scan otherwise
 * (and always for store-backed workspaces with no folder on disk).
 *
 * ripgrep runs through `spawn` with a fixed argv — the query is passed with
 * `-e` and paths after `--`, so nothing the client sends becomes an option.
 */

import { spawn } from "node:child_process";
import path from "node:path";

export interface SearchMatch {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in characters. */
  col: number;
  /** The matching line, trimmed to `MAX_LINE_CHARS`. */
  text: string;
}

export interface SearchOptions {
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Comma-separated or array of globs; `!` negates. */
  globs?: string[];
  maxResults?: number;
  timeoutMs?: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  truncated: boolean;
}

export const MAX_LINE_CHARS = 300;
const DEFAULT_MAX = 2000;

export class SearchInputError extends Error {}

/* --------------------------------- globs ---------------------------------- */

/** Minimal glob → RegExp: `**`, `*`, `?`, `{a,b}`, `[...]`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  let inBrace = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more directories.
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
        continue;
      }
      re += "[^/]*";
    } else if (ch === "?") {
      re += "[^/]";
    } else if (ch === "{") {
      inBrace++;
      re += "(?:";
    } else if (ch === "}" && inBrace > 0) {
      inBrace--;
      re += ")";
    } else if (ch === "," && inBrace > 0) {
      re += "|";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
      } else {
        re += `[${glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else {
      re += ch.replace(/[.+^$()|\\]/g, "\\$&");
    }
    i++;
  }
  return new RegExp(`^${re}$`);
}

/** ripgrep semantics: a glob without `/` matches the basename anywhere. */
export function makeGlobFilter(globs: string[]): (filePath: string) => boolean {
  const include: ((p: string) => boolean)[] = [];
  const exclude: ((p: string) => boolean)[] = [];
  for (const raw of globs) {
    const negated = raw.startsWith("!");
    const glob = negated ? raw.slice(1) : raw;
    if (!glob) continue;
    const anchored = glob.includes("/");
    const re = globToRegExp(anchored ? glob.replace(/^\//, "") : glob);
    const test = (p: string) => re.test(anchored ? p : path.posix.basename(p)) ||
      // `src` style directory globs match everything below.
      (!anchored && p.split("/").slice(0, -1).some((seg) => re.test(seg)));
    (negated ? exclude : include).push(test);
  }
  return (filePath) =>
    (include.length === 0 || include.some((t) => t(filePath))) &&
    !exclude.some((t) => t(filePath));
}

/* ------------------------------- JS search -------------------------------- */

function buildMatcher(options: SearchOptions): RegExp {
  const source = options.regex
    ? options.query
    : options.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, options.caseSensitive ? "g" : "gi");
  } catch (error) {
    throw new SearchInputError(
      // V8 already says "Invalid regular expression: /…/: reason".
      error instanceof Error && error.message.startsWith("Invalid regular expression")
        ? error.message
        : `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function searchFiles(
  files: { path: string; source: string }[],
  options: SearchOptions,
): SearchResult {
  const matcher = buildMatcher(options);
  const filter = makeGlobFilter(options.globs ?? []);
  const max = options.maxResults ?? DEFAULT_MAX;
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const matches: SearchMatch[] = [];
  for (const file of files) {
    if (!filter(file.path)) continue;
    const lines = file.source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      matcher.lastIndex = 0;
      const m = matcher.exec(lines[i]);
      if (!m) continue;
      matches.push({
        path: file.path,
        line: i + 1,
        col: m.index + 1,
        text: lines[i].slice(0, MAX_LINE_CHARS),
      });
      if (matches.length >= max) return { matches, truncated: true };
    }
    if (Date.now() > deadline) return { matches, truncated: true };
  }
  return { matches, truncated: false };
}

/* ------------------------------- ripgrep ---------------------------------- */

interface RgMatchEvent {
  type: "match";
  data: {
    path: { text?: string };
    lines: { text?: string };
    line_number: number;
    submatches: { start: number }[];
  };
}

/**
 * Search `root` with ripgrep. Resolves null when rg is not installed so the
 * caller can fall back.
 */
export function ripgrep(root: string, options: SearchOptions): Promise<SearchResult | null> {
  const max = options.maxResults ?? DEFAULT_MAX;
  const args = ["--json", "--line-number", "--column", "--no-messages", "--max-columns", "1000"];
  args.push("--glob", "!.git");
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  for (const glob of options.globs ?? []) args.push("--glob", glob);
  args.push("-e", options.query, "--", ".");

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const matches: SearchMatch[] = [];
    let truncated = false;
    let buffered = "";
    let stderr = "";
    let settled = false;
    const finish = (result: SearchResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.startsWith('{"type":"match"')) continue;
        let event: RgMatchEvent;
        try {
          event = JSON.parse(line) as RgMatchEvent;
        } catch {
          continue;
        }
        const text = (event.data.lines.text ?? "").replace(/\r?\n$/, "");
        const byteStart = event.data.submatches[0]?.start ?? 0;
        const col = Buffer.from(text, "utf8").subarray(0, byteStart).toString("utf8").length + 1;
        const rel = (event.data.path.text ?? "").replace(/^\.\//, "");
        matches.push({ path: rel, line: event.data.line_number, col, text: text.slice(0, MAX_LINE_CHARS) });
        if (matches.length >= max) {
          truncated = true;
          child.kill("SIGKILL");
          break;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" ? null : { matches, truncated: true });
    });
    child.on("close", (code) => {
      // 0 = matches, 1 = none, 2 = error (bad regex, usually).
      if (code === 2 && matches.length === 0 && !truncated) {
        settled = true;
        clearTimeout(timer);
        reject(new SearchInputError(stderr.trim().split("\n").slice(0, 3).join("\n") || "rg failed"));
        return;
      }
      finish({ matches, truncated });
    });
  });
}

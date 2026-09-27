/**
 * The agent tool suite.
 *
 * Tools are ordered and described so that the *cheap* ones look obviously
 * attractive and `read_file` looks like a last resort. That framing is
 * deliberate: the single biggest token lever in an agent loop is stopping
 * the model from reading whole files it does not need.
 *
 * Roles get different subsets — a frontend specialist has no business
 * running `rm`, and the orchestrator does not edit files directly.
 */

import type { AiToolDef } from "@/lib/ai/types";
import type { TodoItem } from "@/lib/agents/events";
import {
  buildFileWindow,
  buildGraphSlice,
  buildSymbolIndex,
  buildSymbolOutline,
  matchGlob,
  searchCode,
  type EngineInput,
} from "@/lib/context/engine";
import { recordEntry, upsertTask, type MemoryEntryKind } from "@/lib/memory";
import type { ProjectMemory } from "@/lib/memory/types";
import { classifyCommand } from "@/lib/terminal";
import { trimHeadTail } from "@/lib/terminal/output";
import * as verify from "@/lib/verify";
import {
  applyStyle,
  checkEdit,
  multiReplace,
  recordWrite,
  splitStyle,
  strReplace,
  syntaxError,
  type EditSession,
} from "@/lib/tools/editor";
import { findSymbols, renderView, searchTerms } from "@/lib/tools/navigate";
import type { FinishInput } from "@/lib/harness/gate";
import { isFullSuiteCommand } from "@/lib/harness/recovery";
import type { ApprovalAsk } from "@/lib/harness/runs";
import { runRunCommand, startRunCommand } from "@/lib/harness/workspace-services";
import {
  createDirectory,
  deleteFile,
  listFiles,
  readFile,
  renameFile,
  writeFile,
  type WorkspaceHandle,
} from "@/lib/workspace";

/* ---------------------------- tool context -------------------------------- */

export interface FileChangeEvent {
  kind: "create" | "update" | "delete" | "rename";
  path: string;
  previousPath?: string;
  before: string | null;
  after: string | null;
  summary: string;
  by: string;
}

export interface ToolContext {
  handle: WorkspaceHandle;
  engine: EngineInput;
  memory: ProjectMemory;
  /** Role name of the agent calling — used for attribution and locks. */
  agent: string;
  /**
   * Paths this agent is allowed to write: exact paths, `dir/**`, or globs.
   * Empty = no restriction.
   */
  writeScope?: string[];
  /**
   * Tools this agent may execute. The model only sees its role's tools, but
   * it can still *name* any tool, so the list is enforced here too.
   * Undefined = unrestricted (tests and internal callers).
   */
  allowedTools?: string[];
  /**
   * Tools that exist only for this run, such as `mcp__<server>__<tool>` from
   * connected MCP servers. Always permitted: they were filtered per role
   * when the toolset was built.
   */
  extraTools?: Record<string, ToolImpl>;
  /** How to treat commands that are not on the auto-approve list. */
  commandPolicy: "auto" | "ask" | "never";
  /** "ask" routes every file mutation through an approval first. */
  editPolicy?: "auto" | "ask";
  /** Aborts long-running tools (commands) when the run is cancelled. */
  signal?: AbortSignal;
  /** Attributes terminal sessions to the run so cancel can kill them. */
  runId?: string;
  /** User defaults for graph_search when the model does not pass its own. */
  retrieval?: { depth?: number; maxNodes?: number };
  /** Editor state for this run: undo history, created files, oscillation. */
  editSession?: EditSession;
  /**
   * Harness services bound by the caller (solveTask): `compare` runs a
   * command on the original and the current code; `finish` sends the work
   * through the verification gate. Absent = the tools report unavailable.
   */
  harness?: {
    compare?: (command: string, timeoutMs: number) => Promise<string>;
    finish?: (input: FinishInput) => Promise<string>;
    /** The blind test writer's way out: the command that runs its test. */
    done?: (input: { command: string; notes?: string }) => Promise<string>;
  };
  /** Identifiers from recent searches; `view` expands the sections that mention them. */
  recentTerms?: string[];
  events: {
    onFileChange?: (event: FileChangeEvent) => void;
    onCommand?: (info: {
      command: string;
      sessionId: string;
      status: string;
      exitCode: number | null;
    }) => void;
    onMemory?: (info: { kind: string; text: string }) => void;
    /** Full-replace todo list from `todo_write`. */
    onTodos?: (items: TodoItem[]) => void;
    /** Ask the user to approve a command or edit. Resolves true to allow. */
    requestApproval?: (ask: ApprovalAsk) => Promise<boolean>;
  };
}

export interface ToolImpl {
  def: AiToolDef;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;
}

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;
const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, "").replace(/\/+/g, "/");
}

/* ----------------------------- output caps -------------------------------- */
/*
 * Every tool result stays in the transcript and is re-sent on every later
 * turn, so each one is bounded here. A capped result always says what was
 * dropped and how to get it, so the model never mistakes a cut for the end.
 */

/** read_file without a range returns this many lines. */
export const READ_DEFAULT_LINES = 200;
/** read_file with an explicit range returns at most this many lines. */
export const READ_MAX_LINES = 400;
/** grep: total matching lines shown, and per file. */
export const GREP_DEFAULT_RESULTS = 50;
export const GREP_MAX_RESULTS = 100;
export const GREP_PER_FILE = 12;
/** symbol_index: files listed; each `exports:` line is cut to this many chars. */
export const INDEX_MAX_FILES = 100;
const INDEX_EXPORTS_CHARS = 240;
/** symbol_outline: lines of outline. */
export const OUTLINE_MAX_LINES = 120;
/** graph_search: symbols, and characters of source in the slice. */
export const GRAPH_MAX_SYMBOLS = 30;
export const GRAPH_MAX_CHARS = 16_000;
/** list_files / directory view: entries listed. */
export const LIST_MAX_ENTRIES = 150;

/** Keep the first `max` lines of `text`, ending with a note on the rest. */
export function capLines(text: string, max: number, hint: string): string {
  const lines = text.split("\n");
  if (lines.length <= max) return text;
  return `${lines.slice(0, max).join("\n")}\n[… ${lines.length - max} more lines not shown; ${hint}]`;
}

/** Keep whole lines of `text` up to `max` characters, ending with a note on the rest. */
export function capChars(text: string, max: number, hint: string): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf("\n", max);
  const head = text.slice(0, cut > max / 2 ? cut : max);
  const dropped = text.slice(head.length).split("\n").length;
  return `${head}\n[… ${dropped} more lines not shown; ${hint}]`;
}

/**
 * `path:line: text` rows (searchCode's format) regrouped under one header
 * per file, at most `perFile` rows each: the path is not repeated per hit,
 * and one noisy file cannot crowd out the rest.
 */
export function groupByFile(output: string, perFile = GREP_PER_FILE): string {
  const lines = output.split("\n");
  const groups = new Map<string, string[]>();
  const rest: string[] = [];
  let header: string | null = null;
  for (const line of lines) {
    const m = line.match(/^([^\s:][^:]*):(\d+): ?(.*)$/);
    if (!m) {
      if (header === null && groups.size === 0) header = line;
      else rest.push(line);
      continue;
    }
    const list = groups.get(m[1]) ?? [];
    list.push(`  ${m[2]}: ${m[3]}`);
    groups.set(m[1], list);
  }
  if (groups.size === 0) return output;
  const body: string[] = [];
  for (const [path, rows] of groups) {
    // A lone hit keeps the classic `path:line: text` row.
    if (rows.length === 1) {
      body.push(`${path}:${rows[0].trimStart()}`);
      continue;
    }
    body.push(`${path} (${rows.length}):`);
    body.push(...rows.slice(0, perFile));
    if (rows.length > perFile) body.push(`  … ${rows.length - perFile} more in this file (use glob to see them)`);
  }
  return [header ?? "", ...body, ...rest].filter((l, i) => i > 0 || l).join("\n");
}

/**
 * A large list of paths as folders (up to two levels) with file counts and
 * token totals, so an unfiltered listing stays a map rather than a dump.
 */
export function folderSummary(files: { path: string; tokens: number }[], depth = 2): string[] {
  const dirs = new Map<string, { files: number; tokens: number }>();
  for (const f of files) {
    const parts = f.path.split("/");
    const key = parts.length > depth ? `${parts.slice(0, depth).join("/")}/` : parts.length > 1 ? `${parts.slice(0, -1).join("/")}/` : f.path;
    const entry = dirs.get(key) ?? { files: 0, tokens: 0 };
    entry.files += 1;
    entry.tokens += f.tokens;
    dirs.set(key, entry);
  }
  return [...dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => (key.endsWith("/") ? `${key} (${v.files} files, ${v.tokens}t)` : `${key} (${v.tokens}t)`));
}

/**
 * Enforce a specialist's write scope so parallel agents cannot collide.
 *
 * A scope entry is an exact path, a directory written `dir/**` (or `dir/`),
 * or a glob. Anything else is exact: owning `src/a.ts` must not grant
 * `src/a.tsx`, which a prefix match would.
 */
export function inScope(ctx: Pick<ToolContext, "writeScope">, rawPath: string): boolean {
  if (!ctx.writeScope || ctx.writeScope.length === 0) return true;
  const path = normalizePath(rawPath);
  return ctx.writeScope.some((rawPattern) => {
    const pattern = normalizePath(rawPattern);
    if (path === pattern) return true;
    const dir = pattern.endsWith("/**")
      ? pattern.slice(0, -3)
      : pattern.endsWith("/")
        ? pattern.slice(0, -1)
        : null;
    if (dir !== null) return path.startsWith(`${dir}/`);
    return pattern.includes("*") && matchGlob(path, pattern);
  });
}

/**
 * Under `editPolicy: "ask"`, park the mutation on a user approval showing
 * the before/after. Returns a refusal message, or null to proceed.
 */
async function approveEdit(
  ctx: ToolContext,
  path: string,
  before: string | null,
  after: string | null,
  summary: string,
): Promise<string | null> {
  if (ctx.editPolicy !== "ask" || !ctx.events.requestApproval) return null;
  const approved = await ctx.events.requestApproval({
    kind: "edit",
    title: `Edit ${path}`,
    reason: summary,
    detail: { path, before, after },
    alwaysKey: "edit",
  });
  return approved
    ? null
    : `The user declined the change to ${path}. Do not retry it unchanged; continue without it or explain why it is needed.`;
}

/* ------------------------------- tools ------------------------------------ */

const symbolIndexTool: ToolImpl = {
  def: {
    name: "symbol_index",
    description:
      "START HERE to find code: files → exported symbols, with token sizes. Far cheaper than reading files.",
    input_schema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          description: "Substring of a path or symbol name, e.g. 'auth'.",
        },
        with_imports: {
          type: "boolean",
          description: "Also list imports (costs more).",
        },
      },
    },
  },
  async run(args, ctx) {
    const text = buildSymbolIndex(ctx.engine, {
      filter: str(args.filter) || undefined,
      withImports: args.with_imports === true,
      limit: INDEX_MAX_FILES,
    });
    // A barrel or constants file can export hundreds of names.
    return text
      .split("\n")
      .map((line) =>
        line.length > INDEX_EXPORTS_CHARS && /^\s+(exports|imports): /.test(line)
          ? `${line.slice(0, line.lastIndexOf(",", INDEX_EXPORTS_CHARS))}, … (symbol_outline for all)`
          : line,
      )
      .join("\n");
  },
};

const graphSearchTool: ToolImpl = {
  def: {
    name: "graph_search",
    description:
      "Semantic search: describe a behavior in plain words; returns the most relevant functions/classes WITH source and their call/import edges. Cheapest way to learn how something works — prefer it over read_file.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "e.g. 'where user sessions are validated'.",
        },
        depth: {
          type: "number",
          description: "Graph hops, 1-4 (default 2).",
        },
        max_symbols: {
          type: "number",
          description: "5-30 (default 30).",
        },
      },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const query = str(args.query).trim();
    if (!query) return "Error: `query` is required.";
    const slice = buildGraphSlice(ctx.engine, query, {
      depth: num(args.depth) ?? ctx.retrieval?.depth,
      maxNodes: clampSymbols(num(args.max_symbols)) ?? ctx.retrieval?.maxNodes,
    });
    const saved = Math.max(0, slice.baselineTokens - slice.tokens);
    const footer = slice.deduped
      ? ""
      : `\n\n[graph slice: ${slice.nodeIds.length} symbols from ${slice.files.length} files, ${slice.tokens} tokens — reading those files whole would have cost ${slice.baselineTokens} (${saved} saved)]`;
    const text = capChars(slice.text, GRAPH_MAX_CHARS, "narrow the query or lower max_symbols");
    return text + footer;
  },
};

const symbolOutlineTool: ToolImpl = {
  def: {
    name: "symbol_outline",
    description:
      "One file's symbols: signatures, line ranges, users and dependencies, no bodies (~10% of the file's cost). Then read_file a narrow range.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    if (!path) return "Error: `path` is required.";
    return capLines(buildSymbolOutline(ctx.engine, path), OUTLINE_MAX_LINES, "read_file a line range for the rest");
  },
};

/** A model-supplied `max_symbols`, held to 5..GRAPH_MAX_SYMBOLS. */
function clampSymbols(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.min(GRAPH_MAX_SYMBOLS, Math.max(5, Math.round(n)));
}

const grepTool: ToolImpl = {
  def: {
    name: "grep",
    description:
      "Matching lines, grouped by file with line numbers. For literals the graph does not index: config values, CSS classes, env vars, copy.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        glob: { type: "string", description: "e.g. 'src/**/*.ts'." },
        regex: { type: "boolean" },
        max_results: { type: "number", description: "Default 50, max 100." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = str(args.pattern);
    if (!pattern) return "Error: `pattern` is required.";
    const requested = num(args.max_results);
    const maxResults = Math.min(GREP_MAX_RESULTS, Math.max(1, Math.round(requested ?? GREP_DEFAULT_RESULTS)));
    const found = await searchCode(ctx.engine, pattern, {
      glob: str(args.glob) || undefined,
      regex: args.regex === true,
      maxResults,
    });
    return groupByFile(found);
  },
};

const listFilesTool: ToolImpl = {
  def: {
    name: "list_files",
    description:
      "File paths with token sizes, never contents. Without a glob, a large workspace is summarized by folder.",
    input_schema: {
      type: "object",
      properties: {
        glob: { type: "string", description: "e.g. 'app/**/*.tsx'." },
      },
    },
  },
  async run(args, ctx) {
    const glob = str(args.glob).trim();
    let files = Object.values(ctx.memory.files);
    if (glob) files = files.filter((f) => matchGlob(f.path, glob));
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (files.length === 0) {
      return glob ? `No files match ${glob}.` : "Workspace is empty.";
    }
    if (!glob && files.length > LIST_MAX_ENTRIES) {
      const folders = folderSummary(files);
      const shownFolders = folders.slice(0, LIST_MAX_ENTRIES);
      const moreFolders =
        folders.length > shownFolders.length ? `\n… +${folders.length - shownFolders.length} more folders` : "";
      return `${files.length} files, by folder (pass a glob such as 'lib/**' to list files):\n${shownFolders.join("\n")}${moreFolders}`;
    }
    const shown = files.slice(0, LIST_MAX_ENTRIES);
    const lines = shown.map((f) => `${f.path} (${f.tokens}t)`);
    const more =
      files.length > shown.length ? `\n… +${files.length - shown.length} more; narrow the glob` : "";
    return `${files.length} files:\n${lines.join("\n")}${more}`;
  },
};

const readFileTool: ToolImpl = {
  def: {
    name: "read_file",
    description:
      "Read raw source. EXPENSIVE: use graph_search/symbol_outline first, then read only the lines you need. Returns at most 200 lines without a range, 400 with one.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number", description: "1-indexed." },
        end_line: { type: "number" },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    if (!path) return "Error: `path` is required.";
    const start = Math.max(1, Math.round(num(args.start_line) ?? 1));
    const askedEnd = num(args.end_line);
    const explicit = askedEnd !== undefined && askedEnd !== -1;
    const limit = explicit || args.start_line !== undefined ? READ_MAX_LINES : READ_DEFAULT_LINES;
    const end = Math.min(explicit ? Math.max(start, Math.round(askedEnd)) : Infinity, start + limit - 1);
    const window = await buildFileWindow(ctx.engine, path, { start, end });
    // "lines a-b of n" in the header: say what is left and how to get it.
    const m = window.text.match(/lines (\d+)-(\d+) of (\d+)/);
    const shownEnd = m ? Number(m[2]) : 0;
    const total = m ? Number(m[3]) : 0;
    if (!window.deduped && m && shownEnd < total && (!explicit || shownEnd < Math.round(askedEnd))) {
      return `${window.text}\n[${total - shownEnd} more lines; call read_file with start_line=${shownEnd + 1} to continue]`;
    }
    return window.text;
  },
};

const writeFileTool: ToolImpl = {
  def: {
    name: "write_file",
    description:
      "Create a file or replace it whole. For an existing file prefer edit_file/multi_edit (only changed lines). Over ~400 lines: write ~300 here, then append_file the rest in order.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        summary: { type: "string", description: "One sentence." },
      },
      required: ["path", "content", "summary"],
    },
  },
  async run(args, ctx) {
    return writeWhole(ctx, str(args.path).trim(), str(args.content), str(args.summary) || "Wrote file");
  },
};

/** Shared by write_file and create_file: write a whole file, keeping an existing file's style. */
async function writeWhole(ctx: ToolContext, path: string, content: string, summary: string): Promise<string> {
  if (!path) return "Error: `path` is required.";
  if (!inScope(ctx, path)) {
    return `Refused: ${path} is outside your assigned scope (${ctx.writeScope?.join(", ")}). Another agent owns it — report what you need instead of editing it.`;
  }

  const before = await readFile(ctx.handle, path);
  // An existing file keeps its line endings and BOM.
  const after = before === null ? content : applyStyle(content.replace(/\r\n/g, "\n"), splitStyle(before).style);
  const declined = await approveEdit(ctx, path, before, after, summary);
  if (declined) return declined;
  const result = await writeFile(ctx.handle, path, after);
  recordWrite(ctx.editSession, path, result.created);
  ctx.events.onFileChange?.({
    kind: result.created ? "create" : "update",
    path,
    before,
    after,
    summary,
    by: ctx.agent,
  });
  const err = await syntaxError(path, content).catch(() => null);
  const warn = err ? `\nWARNING: the file has a syntax problem:\n${err}` : "";
  return `${result.created ? "Created" : "Updated"} ${path} (${content.split("\n").length} lines). ${summary}${warn}`;
}

const createFileTool: ToolImpl = {
  def: {
    name: "create_file",
    description:
      "Create a file (an existing one is replaced whole); use edit_file to change files. Throwaway files (repro scripts) go in .viberon/scratch/, never part of the patch. Over ~400 lines: create the first part, then extend it with edit_file (find = its last lines).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    return writeWhole(ctx, str(args.path).trim(), str(args.content), str(args.summary) || "Created file");
  },
};

/**
 * Grow a file part by part, so a file too large for one model turn never has
 * to fit in one. Parts are deliberately NOT lint-gated: a half-written file
 * cannot parse. The result reports whether the file parses so far, and the
 * report after the last part is the one that counts.
 */
const appendFileTool: ToolImpl = {
  def: {
    name: "append_file",
    description:
      "Append to a file (created if missing), to write a large file in parts after write_file. Never resend written content. Not syntax-gated; the file must parse after the last part.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        summary: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    const content = str(args.content).replace(/\r\n/g, "\n");
    const summary = str(args.summary) || "Appended to file";
    if (!path) return "Error: `path` is required.";
    if (!content) return "Error: `content` is required.";
    if (!inScope(ctx, path)) {
      return `Refused: ${path} is outside your assigned scope (${ctx.writeScope?.join(", ")}). Another agent owns it — report what you need instead of editing it.`;
    }
    const before = await readFile(ctx.handle, path);
    const { text, style } = before === null ? { text: "", style: null } : splitStyle(before);
    const joined = text && !text.endsWith("\n") ? `${text}\n${content}` : `${text}${content}`;
    const after = style ? applyStyle(joined, style) : joined;
    const declined = await approveEdit(ctx, path, before, after, summary);
    if (declined) return declined;
    const result = await writeFile(ctx.handle, path, after);
    recordWrite(ctx.editSession, path, result.created);
    ctx.events.onFileChange?.({
      kind: result.created ? "create" : "update",
      path,
      before,
      after,
      summary,
      by: ctx.agent,
    });
    const added = content.replace(/\n$/, "").split("\n").length;
    const total = joined.replace(/\n$/, "").split("\n").length;
    const err = await syntaxError(path, joined).catch(() => null);
    const lint = err
      ? `\nThe file does not parse yet (expected until the last part is written):\n${err.split("\n").slice(0, 2).join("\n")}`
      : " It parses cleanly.";
    return `${result.created ? "Created" : "Appended to"} ${path}: +${added} lines, now ${total} lines.${lint}`;
  },
};

/** Normalize one `multi_edit` entry, accepting edit_file's spellings too. */
function editSpec(raw: unknown): { oldStr: string; newStr: string; replaceAll: boolean } | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const oldStr = str(e.old_str ?? e.find ?? e.old_string);
  const newStr = str(e.new_str ?? e.replace ?? e.new_string);
  return oldStr ? { oldStr, newStr, replaceAll: e.replace_all === true } : null;
}

const multiEditTool: ToolImpl = {
  def: {
    name: "multi_edit",
    description:
      "Several find/replace edits to ONE file, in order, all-or-nothing (the failing edit is named). Same matching and syntax gate as edit_file. Prefer it over repeated edit_file or write_file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_str: { type: "string", description: "Exact text, unique unless replace_all." },
              new_str: { type: "string" },
              replace_all: { type: "boolean" },
            },
            required: ["old_str", "new_str"],
          },
        },
        summary: { type: "string" },
      },
      required: ["path", "edits"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    const summary = str(args.summary) || "Edited file";
    const raw = Array.isArray(args.edits) ? args.edits : [];
    if (!path || raw.length === 0) return "Error: `path` and a non-empty `edits` array are required.";
    const edits = raw.map(editSpec);
    const bad = edits.findIndex((e) => e === null);
    if (bad !== -1) return `Error: edit ${bad + 1} needs a non-empty \`old_str\` (and \`new_str\`). No edits were applied.`;
    if (!inScope(ctx, path)) {
      return `Refused: ${path} is outside your assigned scope. Report what you need instead of editing it.`;
    }
    const before = await readFile(ctx.handle, path);
    if (before === null) return `Error: file not found (${path}).`;

    const { text, style } = splitStyle(before);
    const outcome = multiReplace(text, edits, path);
    if ("error" in outcome) return outcome.error;
    const checked = await checkEdit(ctx.editSession, path, text, outcome.after, outcome.notes.join("; "));
    if ("error" in checked) return checked.error;
    const after = applyStyle(outcome.after, style);

    const declined = await approveEdit(ctx, path, before, after, summary);
    if (declined) return declined;
    await writeFile(ctx.handle, path, after);
    recordWrite(ctx.editSession, path, false);
    ctx.events.onFileChange?.({ kind: "update", path, before, after, summary, by: ctx.agent });
    return `${checked.message}\n${edits.length} edits applied. ${summary}`;
  },
};

const viewTool: ToolImpl = {
  def: {
    name: "view",
    description:
      "A file with line numbers, or a directory listing. A file over 400 lines returns an outline with the sections matching your recent searches expanded; pass start_line/end_line for a region (max 400 lines).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        start_line: { type: "number" },
        end_line: { type: "number", description: "-1 = end of file." },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const path = normalizePath(str(args.path)).replace(/\/$/, "");
    const source = path ? await readFile(ctx.handle, path) : null;
    if (source !== null) {
      return renderView(path, source, { start: num(args.start_line), end: num(args.end_line), terms: ctx.recentTerms });
    }
    const all = Object.keys(ctx.memory.files).sort();
    const prefix = path && path !== "." ? `${path}/` : "";
    const inside = all.filter((f) => f.startsWith(prefix));
    if (inside.length) {
      const all2 = [...new Set(inside.map((f) => f.slice(prefix.length).split("/").slice(0, 2).join("/")))];
      const entries = all2.slice(0, LIST_MAX_ENTRIES);
      const more =
        all2.length > entries.length ? `\n… +${all2.length - entries.length} more; view a subdirectory` : "";
      return `Files up to 2 levels deep in ${prefix || "the repository root"}:\n${entries.join("\n")}${more}`;
    }
    const base = path.split("/").pop() ?? "";
    const similar = all.filter((f) => f.split("/").pop() === base).slice(0, 5);
    return `Error: path does not exist: ${path}.${similar.length ? ` Did you mean: ${similar.join(", ")}?` : ""}`;
  },
};

const findSymbolsTool: ToolImpl = {
  def: {
    name: "find_symbols",
    description:
      "Where a class/function/method/constant is defined: file, lines, signature, callers. Accepts 'parse_url', 'Session.send' or a dotted path.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  async run(args, ctx) {
    const query = str(args.query).trim();
    if (!query) return "Error: `query` is required.";
    rememberTerms(ctx, [query.split(/[.:#\s]+/).pop() ?? query]);
    return findSymbols(ctx.engine, query);
  },
};

function rememberTerms(ctx: ToolContext, terms: string[]): void {
  if (!ctx.recentTerms || !terms.length) return;
  const next = [...terms, ...ctx.recentTerms.filter((t) => !terms.includes(t))].slice(0, 12);
  ctx.recentTerms.splice(0, ctx.recentTerms.length, ...next);
}

const editFileTool: ToolImpl = {
  def: {
    name: "edit_file",
    description:
      "Replace text in a file. `find` must match once (include 2-3 lines of context) unless replace_all; copy it WITHOUT the line-number column. Edits that break parsing are rejected with the error.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        find: { type: "string", description: "Exact current text." },
        replace: { type: "string" },
        replace_all: { type: "boolean" },
        summary: { type: "string", description: "One sentence." },
      },
      required: ["path", "find", "replace", "summary"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    const find = str(args.find);
    const replace = str(args.replace);
    const summary = str(args.summary) || "Edited file";
    if (!path || !find) return "Error: `path` and `find` are required.";
    if (!inScope(ctx, path)) {
      return `Refused: ${path} is outside your assigned scope. Report what you need instead of editing it.`;
    }

    const before = await readFile(ctx.handle, path);
    if (before === null) return `Error: file not found (${path}).`;

    const { text, style } = splitStyle(before);
    const outcome = strReplace(text, find, replace, {
      replaceAll: args.replace_all === true,
      path,
    });
    if ("error" in outcome) return outcome.error;
    const checked = await checkEdit(ctx.editSession, path, text, outcome.after, outcome.note);
    if ("error" in checked) return checked.error;
    const after = applyStyle(outcome.after, style);

    const declined = await approveEdit(ctx, path, before, after, summary);
    if (declined) return declined;
    await writeFile(ctx.handle, path, after);
    recordWrite(ctx.editSession, path, false);
    ctx.events.onFileChange?.({
      kind: "update",
      path,
      before,
      after,
      summary,
      by: ctx.agent,
    });
    const plural = outcome.occurrences > 1 ? ` (${outcome.occurrences} occurrences replaced)` : "";
    return `${checked.message}${plural}\n${summary}`;
  },
};

const compareTool: ToolImpl = {
  def: {
    name: "compare",
    description:
      "Run a command on the ORIGINAL and your CURRENT code; verdict: fixes / regression / pre_existing / passes. Use it when a test fails (did you cause it?) and to show your repro goes fail→pass. Unrelated pre-existing failures are not yours to fix.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Targeted shell command." },
        timeout_seconds: { type: "number", description: "Default 180." },
      },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    const command = str(args.command).trim();
    if (!command) return "Error: `command` is required.";
    if (!ctx.harness?.compare) return "Error: compare is not available in this run.";
    const verdict = classifyCommand(command);
    if (verdict.allowed === false) return `Refused: this command ${verdict.reason}.`;
    const timeoutMs = Math.min(900, Math.max(5, num(args.timeout_seconds) ?? 180)) * 1000;
    return ctx.harness.compare(command, timeoutMs);
  },
};

const finishTool: ToolImpl = {
  def: {
    name: "finish",
    description:
      "End the task. The harness VERIFIES it: runs your reproduction and the tests related to your changed files on the original and patched code. Repro fail→pass proves the fix; a test pass→fail is a regression and returns the task to you.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Root cause and change, 2-6 sentences." },
        reproduction: {
          type: "string",
          description: "Command (repo root) failing before and passing after your fix, e.g. 'python .viberon/scratch/repro.py'.",
        },
      },
      required: ["summary"],
    },
  },
  async run(args, ctx) {
    let reproduction = str(args.reproduction).trim();
    // Stray wrapper tag from text-protocol models: <command>x</command>.
    const wrapped = reproduction.match(/^<([A-Za-z_][\w-]*)>([\s\S]*)<\/\1>$/);
    if (wrapped) reproduction = wrapped[2].trim();
    if (reproduction.startsWith("$ ")) reproduction = reproduction.slice(2);
    const summary = str(args.summary) || str(args.message);
    if (!ctx.harness?.finish) return `Finished. ${summary}`;
    return ctx.harness.finish({ summary, ...(reproduction ? { reproduction } : {}) });
  },
};

const doneTool: ToolImpl = {
  def: {
    name: "done",
    description: "Finish: the command (from the repo root) that runs your independent test.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "e.g. 'python -m pytest -q .viberon/scratch/test_independent.py'." },
        notes: { type: "string", description: "One line: what the test checks." },
      },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    const command = str(args.command).trim();
    if (!command) return "Error: `command` is required.";
    if (!ctx.harness?.done) return "Error: done is not available in this run.";
    return ctx.harness.done({ command, notes: str(args.notes) });
  },
};

const deleteFileTool: ToolImpl = {
  def: {
    name: "delete_file",
    description:
      "Delete a file (the user can restore it from the change trace).",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        summary: { type: "string", description: "Why." },
      },
      required: ["path", "summary"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    if (!path) return "Error: `path` is required.";
    if (!inScope(ctx, path)) return `Refused: ${path} is outside your scope.`;
    const before = await readFile(ctx.handle, path);
    const declined = await approveEdit(
      ctx,
      path,
      before,
      null,
      str(args.summary) || "Delete file",
    );
    if (declined) return declined;
    const ok = await deleteFile(ctx.handle, path);
    if (!ok) return `Error: could not delete ${path} (not found?).`;
    ctx.events.onFileChange?.({
      kind: "delete",
      path,
      before,
      after: null,
      summary: str(args.summary) || "Deleted file",
      by: ctx.agent,
    });
    return `Deleted ${path}.`;
  },
};

const renameFileTool: ToolImpl = {
  def: {
    name: "rename_file",
    description:
      "Move or rename a file, then grep for and update imports of the old path.",
    input_schema: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        summary: { type: "string" },
      },
      required: ["from", "to", "summary"],
    },
  },
  async run(args, ctx) {
    const from = str(args.from).trim();
    const to = str(args.to).trim();
    if (!from || !to) return "Error: `from` and `to` are required.";
    // A rename deletes `from`, so both ends must be in scope.
    for (const path of [from, to]) {
      if (!inScope(ctx, path)) return `Refused: ${path} is outside your scope.`;
    }
    const before = await readFile(ctx.handle, from);
    const declined = await approveEdit(
      ctx,
      from,
      before,
      before,
      str(args.summary) || `Rename ${from} → ${to}`,
    );
    if (declined) return declined;
    const ok = await renameFile(ctx.handle, from, to);
    if (!ok) return `Error: could not rename ${from} (not found?).`;
    ctx.events.onFileChange?.({
      kind: "rename",
      path: to,
      previousPath: from,
      before,
      after: before,
      summary: str(args.summary) || `Renamed ${from} → ${to}`,
      by: ctx.agent,
    });
    return `Renamed ${from} → ${to}.`;
  },
};

const createDirectoryTool: ToolImpl = {
  def: {
    name: "create_directory",
    description: "Create a directory (and any missing parents).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    if (!path) return "Error: `path` is required.";
    await createDirectory(ctx.handle, path);
    return `Directory ready: ${path}`;
  },
};

const runCommandTool: ToolImpl = {
  def: {
    name: "run_command",
    description:
      "Run a shell command in the workspace root (install, build, test, git). Output is condensed. For servers set background: true and read the URL from the result.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        background: { type: "boolean", description: "Return immediately (servers, watchers)." },
        timeout_seconds: { type: "number", description: "Default 120." },
      },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    const command = str(args.command).trim();
    if (!command) return "Error: `command` is required.";
    if (!ctx.handle.rootPath) {
      return "Error: this workspace has no folder on disk, so commands cannot run. Open a local folder to enable the terminal.";
    }
    if (ctx.commandPolicy === "never") {
      return "Refused: command execution is disabled in Settings.";
    }

    const verdict = classifyCommand(command);
    if (verdict.allowed === false) {
      return `Refused: this command ${verdict.reason}. Viberon never runs it. Choose a safer approach.`;
    }
    if (verdict.needsApproval && ctx.commandPolicy === "ask") {
      const approved = await ctx.events.requestApproval?.({
        kind: "command",
        title: command,
        reason: "not on the auto-approve list",
        detail: { command },
        alwaysKey: `command:${command}`,
      });
      if (!approved) {
        return `The user declined to run \`${command}\`. Continue without it, or explain why it is necessary.`;
      }
    }

    rememberTerms(ctx, searchTerms(command));
    const background = args.background === true;
    const timeoutMs = background
      ? 0
      : Math.min(600, num(args.timeout_seconds) ?? 120) * 1000;

    if (background) {
      const session = startRunCommand({
        repoKey: ctx.handle.repoKey,
        command,
        cwd: ctx.handle.rootPath,
        signal: ctx.signal,
        runId: ctx.runId,
        origin: "agent",
      });
      // Give a server a moment to bind and print its URL.
      await new Promise((resolve) => setTimeout(resolve, 3500));
      ctx.events.onCommand?.({
        command,
        sessionId: session.id,
        status: session.status,
        exitCode: session.exitCode,
      });
      const output = session.chunks.map((c) => c.text).join("").slice(-3000);
      return `Started in background (session ${session.id}).${
        session.detectedUrl ? ` Serving at ${session.detectedUrl}` : ""
      }\n${output}`;
    }

    const result = await runRunCommand({
      repoKey: ctx.handle.repoKey,
      command,
      cwd: ctx.handle.rootPath,
      timeoutMs,
      signal: ctx.signal,
      runId: ctx.runId,
      origin: "agent",
      // Collect generously; `condense` below decides what the model sees.
      maxOutputChars: 200_000,
    });
    if (ctx.signal?.aborted) return "Cancelled: the run was stopped.";
    ctx.events.onCommand?.({
      command,
      sessionId: result.sessionId,
      status: result.status,
      exitCode: result.exitCode,
    });
    const verdictLine =
      result.exitCode === 0
        ? "Command succeeded."
        : `Command exited ${result.exitCode ?? "?"} (${result.status}).`;
    let note = "";
    if (result.exitCode !== 0 && ctx.harness?.compare && isFullSuiteCommand(command)) {
      note =
        "\n\n[harness note] You ran the ENTIRE test suite. Failures here are often pre-existing or environment-specific. Before acting on one, run that specific test with `compare` to see if it also fails on the original code; only regressions you caused need fixing.";
    }
    return `${verdictLine}${result.detectedUrl ? ` Detected URL: ${result.detectedUrl}` : ""}\n\n${condense(result.output, result.exitCode)}${note}`;
  },
};

/**
 * Keep tracebacks and the summary instead of a blind 40/60 cut. Uses
 * lib/verify's condenser when it is available; falls back to head + tail.
 */
export function condense(output: string, exitCode: number | null, maxChars = 12_000): string {
  try {
    const condensed = verify.condenseOutput(output, exitCode, maxChars);
    if (typeof condensed === "string" && condensed) return condensed;
  } catch {
    // lib/verify not implemented yet: fall through.
  }
  return trimHeadTail(output, maxChars).output;
}

const rememberTool: ToolImpl = {
  def: {
    name: "remember",
    description:
      "Save one sentence to durable project memory for future sessions: a decision and why, a convention, a non-obvious fact, or a suggestion for later.",
    input_schema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["decision", "fact", "convention", "suggestion"],
        },
        text: { type: "string" },
        why: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["kind", "text"],
    },
  },
  async run(args, ctx) {
    const kind = str(args.kind) as MemoryEntryKind;
    const text = str(args.text).trim();
    if (!text) return "Error: `text` is required.";
    if (!["decision", "fact", "convention", "suggestion"].includes(kind)) {
      return "Error: `kind` must be decision, fact, convention, or suggestion.";
    }
    recordEntry(ctx.memory, kind, {
      text,
      why: str(args.why) || undefined,
      files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
      author: ctx.agent,
    });
    ctx.events.onMemory?.({ kind, text });
    return `Recorded ${kind}: ${text}`;
  },
};

const describeProjectTool: ToolImpl = {
  def: {
    name: "describe_project",
    description:
      "Set the project overview in memory: a short paragraph on what it is and how it is organised. Update it when the architecture changes.",
    input_schema: {
      type: "object",
      properties: {
        overview: { type: "string" },
      },
      required: ["overview"],
    },
  },
  async run(args, ctx) {
    const overview = str(args.overview).trim();
    if (!overview) return "Error: `overview` is required.";
    ctx.memory.overview = overview;
    ctx.events.onMemory?.({ kind: "overview", text: overview });
    return "Project overview updated.";
  },
};

const describeFileTool: ToolImpl = {
  def: {
    name: "describe_file",
    description:
      "Attach a one-line purpose to a file in the symbol index so later turns need not open it. Do it for files you just wrote.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        purpose: { type: "string", description: "Under 100 chars." },
      },
      required: ["path", "purpose"],
    },
  },
  async run(args, ctx) {
    const path = str(args.path).trim();
    const purpose = str(args.purpose).trim().slice(0, 160);
    const digest = ctx.memory.files[path];
    if (!digest) return `Error: ${path} is not in the file index.`;
    digest.purpose = purpose;
    return `Described ${path}.`;
  },
};

const trackTaskTool: ToolImpl = {
  def: {
    name: "track_task",
    description:
      "Create or update a durable task (survives reloads). Mark tasks done as you finish them.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Omit to create a new task." },
        title: { type: "string" },
        detail: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "blocked", "done", "cancelled"],
        },
        files: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  async run(args, ctx) {
    const task = upsertTask(ctx.memory, {
      id: str(args.id) || undefined,
      title: str(args.title),
      detail: str(args.detail) || undefined,
      status: (str(args.status) || "pending") as never,
      role: ctx.agent,
      files: Array.isArray(args.files) ? (args.files as string[]) : undefined,
    });
    return `Task ${task.id}: ${task.title} → ${task.status}`;
  },
};

const listWorkspaceTool: ToolImpl = {
  def: {
    name: "workspace_stats",
    description:
      "Workspace totals: files, source tokens, symbols, npm scripts. Check scale before a broad change.",
    input_schema: { type: "object", properties: {} },
  },
  async run(_args, ctx) {
    const files = await listFiles(ctx.handle);
    const tokens = Object.values(ctx.memory.files).reduce(
      (sum, f) => sum + f.tokens,
      0,
    );
    const scripts = Object.keys(ctx.memory.scripts);
    return [
      `Files: ${files.length}`,
      `Source tokens: ${tokens.toLocaleString()}`,
      `Indexed symbols: ${ctx.engine.graph?.nodes.length ?? 0}`,
      `Graph edges: ${ctx.engine.graph?.edges.length ?? 0}`,
      `Stack: ${ctx.memory.stack.join(", ") || "unknown"}`,
      `Scripts: ${scripts.join(", ") || "none"}`,
      ctx.handle.rootPath
        ? `Root: ${ctx.handle.rootPath} (terminal available)`
        : "No folder on disk — terminal unavailable.",
    ].join("\n");
  },
};

const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

const todoWriteTool: ToolImpl = {
  def: {
    name: "todo_write",
    description:
      "Visible checklist for work of 3+ steps. Send the FULL list each time (it replaces the last); keep one item in_progress; mark items completed when done.",
    input_schema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: [...TODO_STATUSES] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
  async run(args, ctx) {
    if (!Array.isArray(args.todos)) return "Error: `todos` must be an array.";
    const items: TodoItem[] = [];
    for (const [index, raw] of (args.todos as unknown[]).slice(0, 50).entries()) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const content = str(item.content).trim().slice(0, 300);
      if (!content) continue;
      // Agents plan with three states; "cancelled" is the harness's (a Stop).
      const status = (TODO_STATUSES as readonly string[]).includes(String(item.status))
        ? (item.status as TodoItem["status"])
        : "pending";
      items.push({ id: str(item.id).trim() || String(index + 1), content, status });
    }
    ctx.events.onTodos?.(items);
    const done = items.filter((i) => i.status === "completed").length;
    return `Todo list updated (${done}/${items.length} completed).`;
  },
};

/* ---------------------------- role bundles -------------------------------- */

export const ALL_TOOLS: Record<string, ToolImpl> = {
  symbol_index: symbolIndexTool,
  graph_search: graphSearchTool,
  symbol_outline: symbolOutlineTool,
  grep: grepTool,
  list_files: listFilesTool,
  read_file: readFileTool,
  workspace_stats: listWorkspaceTool,
  write_file: writeFileTool,
  append_file: appendFileTool,
  edit_file: editFileTool,
  multi_edit: multiEditTool,
  delete_file: deleteFileTool,
  rename_file: renameFileTool,
  create_directory: createDirectoryTool,
  run_command: runCommandTool,
  remember: rememberTool,
  describe_project: describeProjectTool,
  describe_file: describeFileTool,
  track_task: trackTaskTool,
  todo_write: todoWriteTool,
  view: viewTool,
  find_symbols: findSymbolsTool,
  create_file: createFileTool,
  compare: compareTool,
  finish: finishTool,
  done: doneTool,
};

/**
 * The autonomous solver's seven tools. The SWE-bench leaders use two or
 * three well-built tools; every extra schema costs tokens each turn and
 * splits the model's attention.
 */
export const SOLVER_TOOLS = [
  "run_command",
  "edit_file",
  "create_file",
  "view",
  "find_symbols",
  "compare",
  "finish",
];

/**
 * The blind test writer: read the code, write a test (the harness confines
 * writes to `.viberon/scratch/`), run it once, then `done`.
 */
export const TEST_WRITER_TOOLS = ["run_command", "view", "find_symbols", "create_file", "edit_file", "done"];

/** Read-only navigation — every agent gets these. */
export const READ_TOOLS = [
  "symbol_index",
  "graph_search",
  "symbol_outline",
  "grep",
  "list_files",
  "read_file",
  "workspace_stats",
];

export const WRITE_TOOLS = [
  "write_file",
  "append_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "rename_file",
  "create_directory",
];

export const MEMORY_TOOLS = [
  "remember",
  "describe_project",
  "describe_file",
  "track_task",
];

export const EXEC_TOOLS = ["run_command"];

/** Progress tracking for agents doing multi-step work. */
export const PLANNING_TOOLS = ["todo_write"];

/**
 * Tool descriptions are long on purpose — they are what steer the model
 * away from `read_file`. But on a small-context (or TPM-limited) model the
 * schema block alone can blow the request budget, so `compact` keeps only
 * the first sentence of each description.
 */
export function toolDefs(
  names: string[],
  options: { compact?: boolean } = {},
): AiToolDef[] {
  const defs = names
    .map((name) => ALL_TOOLS[name]?.def)
    .filter((def): def is AiToolDef => Boolean(def));

  if (!options.compact) return defs;

  return defs.map((def) => ({
    ...def,
    description: firstSentence(def.description),
    input_schema: {
      ...def.input_schema,
      properties: Object.fromEntries(
        Object.entries(def.input_schema.properties).map(([key, schema]) => {
          if (!schema || typeof schema !== "object") return [key, schema];
          const { description, ...rest } = schema as {
            description?: string;
          } & Record<string, unknown>;
          return [
            key,
            description
              ? { ...rest, description: firstSentence(description) }
              : rest,
          ];
        }),
      ),
    },
  }));
}

function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?:\s|$)/);
  const head = (match?.[0] ?? text).trim();
  return head.length > 150 ? `${head.slice(0, 147)}…` : head;
}

/**
 * The smallest tool set that can still do real work. Used when a model's
 * request budget cannot fit the full registry.
 */
export const ESSENTIAL_TOOLS = [
  "symbol_index",
  "graph_search",
  "read_file",
  "write_file",
  "append_file",
  "edit_file",
  "list_files",
];

/* ------------------------- argument tolerance ---------------------------- */

const RUN = ["run_command"];
const EDIT = ["edit_file"];
const READ = ["view", "read_file"];
const CREATE = ["create_file", "write_file"];
const DEFINITION = ["find_symbols", "symbol_index"];
const FINISH = ["finish"];

/**
 * Tool-name habits from other harnesses (and our own interactive/solver
 * equivalents), mapped onto ours: the first candidate this agent has wins.
 */
const TOOL_ALIASES: Record<string, string[]> = {
  bash: RUN,
  execute_bash: RUN,
  run: RUN,
  shell: RUN,
  terminal: RUN,
  exec: RUN,
  execute_command: RUN,
  str_replace: EDIT,
  replace: EDIT,
  edit: EDIT,
  apply_edit: EDIT,
  replace_in_file: EDIT,
  str_replace_based_edit_tool: EDIT,
  view: READ,
  read_file: READ,
  cat: READ,
  open_file: READ,
  view_file: READ,
  read: READ,
  create: CREATE,
  create_file: CREATE,
  write_file: CREATE,
  new_file: CREATE,
  write: CREATE,
  search: ["grep"],
  search_code: ["grep"],
  rg: ["grep"],
  grep_search: ["grep"],
  find_files: ["list_files"],
  glob: ["list_files"],
  find_definition: DEFINITION,
  find_symbol: DEFINITION,
  find_symbols: DEFINITION,
  symbol_index: DEFINITION,
  goto_definition: DEFINITION,
  submit: FINISH,
  done: FINISH,
  complete: FINISH,
  submit_fix: FINISH,
  task_complete: FINISH,
  append: ["append_file"],
  append_to_file: ["append_file"],
  multiedit: ["multi_edit"],
  apply_edits: ["multi_edit"],
  diff_run: ["compare"],
  compare_runs: ["compare"],
  run_on_original: ["compare"],
};

/** `str_replace_editor` sub-commands. */
const EDITOR_SUBCOMMANDS: Record<string, string[]> = {
  view: READ,
  str_replace: EDIT,
  create: CREATE,
};

const NAMESPACE_PREFIXES = ["functions.", "function.", "tools.", "tool.", "tool:", "default_api."];

/** Arguments that are silently accepted even though no schema declares them. */
const TOLERATED_ARGS = new Set(["file_path", "cmd", "query", "content", "file", "text", "name", "timeout", "summary"]);

function inferFromArgs(args: Record<string, unknown>): string[] {
  const keys = new Set(Object.keys(args));
  if (keys.has("edits")) return ["multi_edit"];
  if (keys.has("old_str") || keys.has("find")) return EDIT;
  if (keys.has("file_text") || (keys.has("path") && keys.has("content"))) return CREATE;
  if (keys.has("command") || keys.has("cmd")) return RUN;
  if (keys.has("verification_commands") || keys.has("reproduction")) return FINISH;
  if (keys.has("pattern") || keys.has("regex")) return ["grep"];
  if (keys.has("symbol")) return DEFINITION;
  if (keys.has("query")) return ["graph_search", "find_symbols"];
  const pathish = ["path", "file_path", "view_range", "start_line", "end_line"];
  if (keys.size && [...keys].every((k) => pathish.includes(k))) return READ;
  return [];
}

const RANGE_START = ["start_line", "line_start", "start", "from_line", "line_from", "begin", "first_line", "lineno", "line"];
const RANGE_END = ["end_line", "line_end", "end", "to_line", "line_to", "last_line", "stop"];

/** Pull a line range out of whatever spelling the model used, consuming the keys. */
function extractRange(args: Record<string, unknown>): [number, number] | null {
  const asInt = (v: unknown) => {
    const n = Number.parseInt(String(v).trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
  for (const key of ["view_range", "lines", "line_range", "range"]) {
    if (key in args) {
      const raw = args[key];
      delete args[key];
      const nums = (Array.isArray(raw) ? raw.map(String).join(" ") : String(raw))
        .match(/(?<!\d)-?\d+/g)
        ?.map(Number);
      if (nums?.length) return nums.length > 1 ? [nums[0], nums[1]] : [nums[0], nums[0] + 100];
    }
  }
  if ("offset" in args || "limit" in args) {
    const off = asInt(args.offset) ?? 1;
    const lim = asInt(args.limit) ?? 200;
    delete args.offset;
    delete args.limit;
    return [Math.max(1, off), Math.max(1, off) + lim - 1];
  }
  const startKey = RANGE_START.find((k) => k in args);
  const endKey = RANGE_END.find((k) => k in args);
  const start = startKey ? asInt(args[startKey]) : null;
  const end = endKey ? asInt(args[endKey]) : null;
  if (startKey) delete args[startKey];
  if (endKey) delete args[endKey];
  if (start !== null) return [start, end !== null && end !== -1 ? end : start + 150];
  if (end !== null) return [Math.max(1, end - 150), end];
  return null;
}

function moveArg(args: Record<string, unknown>, to: string, from: string[]): void {
  if (to in args) return;
  for (const alt of from) {
    if (alt in args) {
      args[to] = args[alt];
      delete args[alt];
      return;
    }
  }
}

/**
 * Map alias tool names and argument spellings onto the declared schema, so
 * the transcript only ever contains declared tools (some providers 500 on
 * histories with undeclared names). Returns null for a call it cannot map.
 */
export function canonicalizeCall(
  rawName: string,
  input: Record<string, unknown>,
  known: (name: string) => boolean = (n) => Boolean(ALL_TOOLS[n]),
): { name: string; input: Record<string, unknown> } | null {
  let base = (rawName ?? "").trim();
  for (const prefix of NAMESPACE_PREFIXES) {
    if (base.startsWith(prefix)) {
      base = base.slice(prefix.length);
      break;
    }
  }
  const args: Record<string, unknown> = { ...(input ?? {}) };
  const pick = (candidates: string[] | undefined) => candidates?.find(known);
  let name: string | undefined = base;
  if (!known(name)) {
    if (name === "str_replace_editor" || name === "text_editor" || name === "editor") {
      const sub = String(args.command ?? "").toLowerCase();
      delete args.command;
      name = pick(
        EDITOR_SUBCOMMANDS[sub] ?? (args.old_str !== undefined ? EDIT : args.file_text !== undefined ? CREATE : READ),
      );
    } else {
      name = pick(TOOL_ALIASES[name]);
    }
  }
  name ??= pick(inferFromArgs(args));
  if (!name) return null;

  moveArg(args, "path", ["file_path", "file", "filename"]);
  if (name === "run_command" || name === "compare") {
    moveArg(args, "command", ["cmd", "script", "code"]);
    if (Array.isArray(args.command)) args.command = args.command.map(String).join(" ");
    moveArg(args, "timeout_seconds", ["timeout"]);
  } else if (name === "grep") {
    moveArg(args, "pattern", ["query", "regex", "text", "search_term"]);
  } else if (name === "symbol_index") {
    moveArg(args, "filter", ["symbol", "name", "query"]);
  } else if (name === "find_symbols") {
    moveArg(args, "query", ["symbol", "name", "filter"]);
  } else if (name === "list_files") {
    moveArg(args, "glob", ["pattern"]);
  } else if (name === "edit_file") {
    moveArg(args, "find", ["old_str", "old", "old_string", "search"]);
    moveArg(args, "replace", ["new_str", "new", "new_string", "replacement"]);
  } else if (name === "write_file" || name === "create_file" || name === "append_file") {
    moveArg(args, "content", ["file_text", "text", "contents"]);
  } else if (name === "finish") {
    // The older submit shape: a list of verification commands; the first is the reproduction.
    const list = args.verification_commands ?? args.commands;
    delete args.verification_commands;
    delete args.commands;
    const first = Array.isArray(list) ? list[0] : typeof list === "string" ? list.split("\n")[0] : undefined;
    if (args.reproduction === undefined && first) args.reproduction = String(first);
    moveArg(args, "reproduction", ["command", "repro", "reproduction_command"]);
  } else if (name === "read_file" || name === "view") {
    const range = extractRange(args);
    if (range) {
      args.start_line = range[0];
      args.end_line = range[1];
    }
  }
  return { name, input: args };
}

/** Arguments the tool's schema does not declare (and we do not tolerate). */
function unknownArgs(tool: ToolImpl, args: Record<string, unknown>): string[] {
  const allowed = new Set(Object.keys(tool.def.input_schema.properties ?? {}));
  return Object.keys(args).filter((k) => !allowed.has(k) && !TOLERATED_ARGS.has(k)).sort();
}

/** The tool names an agent can call: its allowed built-ins plus run-scoped extras. */
export function knownTools(allowed?: string[], extra: Record<string, unknown> = {}): (name: string) => boolean {
  return (n) => Boolean(extra[n]) || (Boolean(ALL_TOOLS[n]) && (!allowed || allowed.includes(n)));
}

export async function runTool(
  rawName: string,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const canon = canonicalizeCall(rawName, rawArgs, knownTools(ctx.allowedTools, ctx.extraTools));
  const name = canon?.name ?? rawName;
  const args = canon?.input ?? rawArgs;
  const extra = ctx.extraTools?.[name];
  const tool = extra ?? ALL_TOOLS[name];
  const allowed = ctx.allowedTools;
  if (!tool || (!extra && allowed && !allowed.includes(name))) {
    const available = [
      ...(allowed ?? Object.keys(ALL_TOOLS)),
      ...Object.keys(ctx.extraTools ?? {}),
    ];
    return tool
      ? `Refused: ${name} is not available to this agent. Available: ${available.join(", ")}`
      : `Error: unknown tool "${name}". Available: ${available.join(", ")}`;
  }
  try {
    const output = await tool.run(args, ctx);
    const ignored = extra ? [] : unknownArgs(tool, args);
    // Never ignore an argument silently: the model would keep retrying it.
    return ignored.length
      ? `${output}\n[harness note] Ignored unknown argument(s) for \`${name}\`: ${ignored.join(", ")}. Valid arguments: ${Object.keys(tool.def.input_schema.properties).join(", ")}.`
      : output;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Tool ${name} failed: ${message}`;
  }
}

/** Whether a tool's output reports a failure (the tools return, not throw). */
export function isToolFailure(output: string): boolean {
  return /^(Error|Refused|Cancelled|The user declined|Tool .* failed)/.test(output);
}

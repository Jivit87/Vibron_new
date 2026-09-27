/**
 * Parsers that turn checker output into Problems-panel entries.
 *
 * Pure functions — no node imports — so the client can share the types and
 * the tests can feed them captured output directly.
 */

export type ProblemSeverity = "error" | "warning" | "info";

export interface Problem {
  /** Workspace-relative path, forward slashes. Empty for project-wide issues. */
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  severity: ProblemSeverity;
  message: string;
  /** Which checker produced it: "ts", "eslint", "monaco", … */
  source: string;
  /** Checker-specific code, e.g. "TS2322" or "no-unused-vars". */
  code?: string;
}

export interface CheckerRun {
  checker: "tsc" | "eslint" | "tests";
  ran: boolean;
  /** Why it did not run, or what went wrong. */
  note?: string;
  durationMs: number;
  count: number;
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Make an absolute checker path workspace-relative. Paths outside the root
 * are returned unchanged (still useful to show, just not openable).
 */
export function relativeToRoot(file: string, rootPath: string): string {
  const normalized = normalizePath(file);
  const root = normalizePath(rootPath).replace(/\/+$/, "");
  if (root && normalized.startsWith(`${root}/`)) {
    return normalized.slice(root.length + 1);
  }
  return normalized;
}

const TSC_LOCATED = /^(.+?)\((\d+),(\d+)\): (error|warning|message) (TS\d+): (.*)$/;
const TSC_GLOBAL = /^(error|warning|message) (TS\d+): (.*)$/;

function tscSeverity(kind: string): ProblemSeverity {
  if (kind === "error") return "error";
  if (kind === "warning") return "warning";
  return "info";
}

/**
 * Parse `tsc --noEmit --pretty false` output.
 *
 *   src/a.ts(3,7): error TS2322: Type 'string' is not assignable …
 *     Continuation lines are indented and belong to the previous entry.
 *   error TS5083: Cannot read file '…/tsconfig.json'.
 */
export function parseTscOutput(output: string, rootPath = ""): Problem[] {
  const problems: Problem[] = [];
  let last: Problem | null = null;

  for (const rawLine of output.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) continue;

    const located = line.match(TSC_LOCATED);
    if (located) {
      last = {
        file: relativeToRoot(located[1], rootPath),
        line: Number(located[2]),
        col: Number(located[3]),
        severity: tscSeverity(located[4]),
        code: located[5],
        message: located[6],
        source: "ts",
      };
      problems.push(last);
      continue;
    }

    const global = line.match(TSC_GLOBAL);
    if (global) {
      last = {
        file: "",
        line: 1,
        col: 1,
        severity: tscSeverity(global[1]),
        code: global[2],
        message: global[3],
        source: "ts",
      };
      problems.push(last);
      continue;
    }

    if (last && /^\s/.test(rawLine)) {
      last.message += `\n${line.trim()}`;
      continue;
    }
    // Anything else (summary lines like "Found 3 errors") ends the entry.
    last = null;
  }

  return problems;
}

interface EslintMessage {
  ruleId?: string | null;
  severity?: number;
  message?: string;
  line?: number;
  column?: number;
  fatal?: boolean;
}

interface EslintFileResult {
  filePath?: string;
  messages?: EslintMessage[];
}

/**
 * Parse `eslint -f json` output. ESLint may print warnings (e.g. about
 * config) before the JSON array, so the array is located rather than
 * assuming the whole stream is JSON.
 */
export function parseEslintJson(output: string, rootPath = ""): Problem[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start === -1 || end < start) return [];
  let results: EslintFileResult[];
  try {
    results = JSON.parse(output.slice(start, end + 1)) as EslintFileResult[];
  } catch {
    return [];
  }
  if (!Array.isArray(results)) return [];

  const problems: Problem[] = [];
  for (const result of results) {
    if (!result || typeof result.filePath !== "string") continue;
    const file = relativeToRoot(result.filePath, rootPath);
    for (const message of result.messages ?? []) {
      if (typeof message?.message !== "string") continue;
      problems.push({
        file,
        line: Math.max(1, message.line ?? 1),
        col: Math.max(1, message.column ?? 1),
        severity:
          message.fatal || message.severity === 2
            ? "error"
            : message.severity === 1
              ? "warning"
              : "info",
        message: message.message,
        code: message.ruleId ?? undefined,
        source: "eslint",
      });
    }
  }
  return problems;
}

const SEVERITY_RANK: Record<ProblemSeverity, number> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface ProblemGroup {
  file: string;
  problems: Problem[];
  errors: number;
  warnings: number;
}

/**
 * Group by file, dedupe identical entries (Monaco and tsc often report the
 * same error), and sort: files with errors first, then by position.
 */
export function groupProblems(problems: Problem[]): ProblemGroup[] {
  const byFile = new Map<string, Map<string, Problem>>();
  for (const problem of problems) {
    const key = `${problem.line}:${problem.col}:${problem.severity}:${problem.message}`;
    const bucket = byFile.get(problem.file) ?? new Map<string, Problem>();
    if (!bucket.has(key)) bucket.set(key, problem);
    byFile.set(problem.file, bucket);
  }

  const groups: ProblemGroup[] = [];
  for (const [file, bucket] of byFile) {
    const list = [...bucket.values()].sort(
      (a, b) =>
        a.line - b.line ||
        a.col - b.col ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
    );
    groups.push({
      file,
      problems: list,
      errors: list.filter((p) => p.severity === "error").length,
      warnings: list.filter((p) => p.severity === "warning").length,
    });
  }

  return groups.sort(
    (a, b) =>
      Number(b.errors > 0) - Number(a.errors > 0) || a.file.localeCompare(b.file),
  );
}

/* --------------------------------- tests ---------------------------------- */

/** The file part of a test id: `a/test_x.py::t`, `tests/a.test.ts > s > t`. */
export function testIdFile(id: string): string {
  const pytest = /^([^\s:]+\.py)::/.exec(id);
  if (pytest) return normalizePath(pytest[1]);
  const js = /^(\S+\.[cm]?[jt]sx?) > /.exec(id);
  if (js) return normalizePath(js[1]);
  return "";
}

/**
 * Failing tests from a verification run as Problems. The line is taken
 * from a `file:line` mention in the failure excerpt when there is one.
 * A failed run with no attributable test becomes one project-wide entry.
 */
export function testFailureProblems(input: {
  command: string;
  tests: Record<string, "pass" | "fail" | "error" | "skip">;
  failed: boolean;
  timedOut?: boolean;
  excerpt: string;
}): Problem[] {
  const problems: Problem[] = [];
  const excerptLine = (file: string): number => {
    if (!file) return 1;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`${escaped}:(\\d+)`).exec(input.excerpt);
    return match ? Number(match[1]) : 1;
  };
  for (const [id, outcome] of Object.entries(input.tests)) {
    if (outcome !== "fail" && outcome !== "error") continue;
    const file = testIdFile(id);
    problems.push({
      file,
      line: excerptLine(file),
      col: 1,
      severity: "error",
      message: `${outcome === "error" ? "Test error" : "Test failed"}: ${id}`,
      source: "tests",
    });
  }
  if (input.failed && problems.length === 0) {
    // Skip npm's "> pkg@1.0.0 test" banner lines; prefer the line that says what broke.
    const lines = input.excerpt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith(">"));
    const first = lines.find((l) => /error|fail|not found|cannot|exception|panic/i.test(l)) ?? lines[0];
    problems.push({
      file: "",
      line: 1,
      col: 1,
      severity: "error",
      message: input.timedOut
        ? `\`${input.command}\` timed out`
        : `\`${input.command}\` failed${first ? `: ${first.slice(0, 300)}` : ""}`,
      source: "tests",
    });
  }
  return problems;
}

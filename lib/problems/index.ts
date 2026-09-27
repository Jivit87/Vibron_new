/**
 * Run the workspace's own checkers — `tsc --noEmit` and ESLint, plus the
 * repo's detected test command on request — and parse their output into
 * Problems.
 *
 * Only the workspace's locally installed binaries are used (no global
 * installs, no `npx` downloads), and they run via `execFile(node, [script])`
 * with no shell. A workspace without a tsconfig or ESLint config simply
 * skips that checker.
 */

import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";

import {
  parseEslintJson,
  parseTscOutput,
  testFailureProblems,
  type CheckerRun,
  type Problem,
} from "@/lib/problems/parse";
import { scrubEnv } from "@/lib/terminal/safety";
import { detectVerifyCommands, runVerification } from "@/lib/verify";

export type { CheckerRun };


export interface ProblemsResult {
  problems: Problem[];
  checkers: CheckerRun[];
  finishedAt: number;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(root: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    if (await exists(path.join(root, name))) return name;
  }
  return null;
}

function runNodeScript(
  cwd: string,
  script: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      {
        cwd,
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...scrubEnv(process.env),
          // Under Electron, execPath is the Electron binary.
          ELECTRON_RUN_AS_NODE: "1",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      },
      (error, stdout, stderr) => {
        // Both checkers exit non-zero when they find problems — that is the
        // normal case, not a failure. Only a kill means we lost the output.
        const timedOut = Boolean(error && (error as { killed?: boolean }).killed);
        resolve({ stdout: String(stdout), stderr: String(stderr), timedOut });
      },
    );
  });
}

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  ".eslintrc",
];

async function runTsc(
  root: string,
  timeoutMs: number,
): Promise<{ run: CheckerRun; problems: Problem[] }> {
  const started = Date.now();
  const script = path.join(root, "node_modules", "typescript", "bin", "tsc");
  if (!(await exists(path.join(root, "tsconfig.json")))) {
    return {
      run: { checker: "tsc", ran: false, note: "No tsconfig.json", durationMs: 0, count: 0 },
      problems: [],
    };
  }
  if (!(await exists(script))) {
    return {
      run: {
        checker: "tsc",
        ran: false,
        note: "typescript is not installed in this workspace",
        durationMs: 0,
        count: 0,
      },
      problems: [],
    };
  }
  const out = await runNodeScript(
    root,
    script,
    ["--noEmit", "--pretty", "false", "-p", "tsconfig.json"],
    timeoutMs,
  );
  const problems = parseTscOutput(out.stdout, root);
  return {
    run: {
      checker: "tsc",
      ran: true,
      note: out.timedOut ? "Timed out" : undefined,
      durationMs: Date.now() - started,
      count: problems.length,
    },
    problems,
  };
}

async function runEslint(
  root: string,
  timeoutMs: number,
  files: string[] | null,
): Promise<{ run: CheckerRun; problems: Problem[] }> {
  const started = Date.now();
  const config = await firstExisting(root, ESLINT_CONFIGS);
  if (!config) {
    return {
      run: { checker: "eslint", ran: false, note: "No ESLint config", durationMs: 0, count: 0 },
      problems: [],
    };
  }
  const script = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
  if (!(await exists(script))) {
    return {
      run: {
        checker: "eslint",
        ran: false,
        note: "eslint is not installed in this workspace",
        durationMs: 0,
        count: 0,
      },
      problems: [],
    };
  }
  // `./` prefix: a file named `-rf` must never be read as an option.
  const targets = files ? files.map((f) => `./${f}`) : ["."];
  const out = await runNodeScript(
    root,
    script,
    [
      "-f",
      "json",
      // Flat-config ESLint warns for every explicitly passed ignored file;
      // the flag does not exist in legacy (eslintrc) versions.
      ...(files && config.startsWith("eslint.config") ? ["--no-warn-ignored"] : []),
      ...targets,
    ],
    timeoutMs,
  );
  const problems = parseEslintJson(out.stdout, root);
  const failed = problems.length === 0 && !out.stdout.trim().startsWith("[");
  return {
    run: {
      checker: "eslint",
      ran: true,
      note: out.timedOut
        ? "Timed out"
        : failed && out.stderr.trim()
          ? out.stderr.trim().split("\n")[0].slice(0, 200)
          : undefined,
      durationMs: Date.now() - started,
      count: problems.length,
    },
    problems,
  };
}

export interface RunChecksOptions {
  /** Workspace-relative files to focus on. tsc still checks the project (it
   * cannot honour tsconfig per file) but results are filtered; ESLint lints
   * only these files. */
  files?: string[];
  /** Per-checker timeout. Default 180s. */
  timeoutMs?: number;
  /**
   * Also run the repo's detected test command (the one the Fix gate uses)
   * and list failing tests. Ignored for focused (`files`) runs. Without it,
   * the last test results stay in the cache.
   */
  tests?: boolean;
}

/** Run the detected test command and turn failing tests into Problems. */
export async function runTests(
  root: string,
  timeoutMs: number,
): Promise<{ run: CheckerRun; problems: Problem[] }> {
  const started = Date.now();
  const commands = await detectVerifyCommands(root).catch(() => []);
  const cmd = commands.find((c) => c.kind === "test");
  if (!cmd) {
    return {
      run: { checker: "tests", ran: false, note: "No test command detected", durationMs: 0, count: 0 },
      problems: [],
    };
  }
  const report = await runVerification(root, cmd, { timeoutMs });
  const failed = report.timedOut || (report.exitCode ?? 1) !== 0;
  const problems = testFailureProblems({
    command: report.command,
    tests: report.tests,
    failed,
    timedOut: report.timedOut,
    excerpt: report.failureExcerpt,
  });
  const { passed, failed: failedCount, errors } = report.counts;
  return {
    run: {
      checker: "tests",
      ran: true,
      note: `${report.command}: ${passed} passed, ${failedCount + errors} failed${report.timedOut ? " (timed out)" : ""}`,
      durationMs: Date.now() - started,
      count: problems.length,
    },
    problems,
  };
}

const LINTABLE = /\.(m|c)?(j|t)sx?$/i;

/** Relative, inside-root, not option-looking. Invalid entries are dropped. */
function sanitizeFiles(root: string, files: string[]): string[] {
  const out = new Set<string>();
  for (const raw of files) {
    if (typeof raw !== "string" || !raw || raw.includes("\0") || path.isAbsolute(raw)) continue;
    const resolved = path.resolve(root, raw);
    if (!resolved.startsWith(`${root}${path.sep}`)) continue;
    out.add(path.relative(root, resolved).split(path.sep).join("/"));
  }
  return [...out].sort();
}

interface CacheEntry {
  result: ProblemsResult | null;
  running: number;
}

const STATE_KEY = Symbol.for("viberon.problems.state");
type GlobalWithState = typeof globalThis & {
  [STATE_KEY]?: {
    inflight: Map<string, Promise<ProblemsResult>>;
    cache: Map<string, CacheEntry>;
  };
};
const host = globalThis as GlobalWithState;
const state = host[STATE_KEY] ?? { inflight: new Map(), cache: new Map() };
host[STATE_KEY] = state;

function entryFor(root: string): CacheEntry {
  let entry = state.cache.get(root);
  if (!entry) {
    entry = { result: null, running: 0 };
    state.cache.set(root, entry);
  }
  return entry;
}

/** The last completed result for a root (merged across focused runs). */
export function cachedProblems(rootPath: string): {
  result: ProblemsResult | null;
  running: boolean;
} {
  const entry = state.cache.get(path.resolve(rootPath));
  return { result: entry?.result ?? null, running: (entry?.running ?? 0) > 0 };
}

/**
 * Run both checkers in parallel. Concurrent calls for the same root and file
 * set share one run (single-flight). Results are cached for `cachedProblems`.
 */
export function runChecks(
  rootPath: string,
  options: RunChecksOptions = {},
): Promise<ProblemsResult> {
  const root = path.resolve(rootPath);
  const files = options.files ? sanitizeFiles(root, options.files) : null;
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 180_000);
  const withTests = options.tests === true && !files;
  const key = `${root}\0${files ? files.join("\0") : "*"}${withTests ? "\0+tests" : ""}`;
  const pending = state.inflight.get(key);
  if (pending) return pending;

  const entry = entryFor(root);
  entry.running++;
  const promise = (async (): Promise<ProblemsResult> => {
    const lintFiles = files ? files.filter((f) => LINTABLE.test(f)) : null;
    const [tsc, eslint, tests] = await Promise.all([
      runTsc(root, timeoutMs),
      lintFiles && lintFiles.length === 0
        ? Promise.resolve({
            run: { checker: "eslint" as const, ran: false, note: "No lintable files", durationMs: 0, count: 0 },
            problems: [] as Problem[],
          })
        : runEslint(root, timeoutMs, lintFiles),
      withTests ? runTests(root, Math.max(timeoutMs, 300_000)) : Promise.resolve(null),
    ]);
    // Checkers report real paths; the root may be reached through a symlink
    // (e.g. macOS /var → /private/var), so strip either prefix.
    const real = await realpath(root).catch(() => root);
    let problems = [...tsc.problems, ...eslint.problems, ...(tests?.problems ?? [])].map((p) =>
      real !== root && p.file.startsWith(`${real}/`)
        ? { ...p, file: p.file.slice(real.length + 1) }
        : p,
    );
    if (files) {
      const wanted = new Set(files);
      problems = problems.filter((p) => p.file === "" || wanted.has(p.file));
    }
    // A run without tests keeps the last test results.
    const previous = entry.result;
    const previousTests = previous?.checkers.find((c) => c.checker === "tests");
    if (!tests && previousTests && !files) {
      problems = [...problems, ...previous!.problems.filter((p) => p.source === "tests")];
    }
    const result: ProblemsResult = {
      problems,
      checkers: [tsc.run, eslint.run, ...(tests ? [tests.run] : previousTests && !files ? [previousTests] : [])],
      finishedAt: Date.now(),
    };

    // Merge a focused run into the cache instead of replacing it.
    if (files && previous) {
      const touched = new Set(files);
      entry.result = {
        ...result,
        // Tests were not rerun: keep their last results.
        checkers: previousTests ? [...result.checkers, previousTests] : result.checkers,
        problems: [
          ...previous.problems.filter(
            (p) => p.source === "tests" || (p.file !== "" && !touched.has(p.file)),
          ),
          ...problems,
        ],
      };
    } else {
      entry.result = result;
    }
    return result;
  })().finally(() => {
    state.inflight.delete(key);
    entry.running--;
  });

  state.inflight.set(key, promise);
  return promise;
}

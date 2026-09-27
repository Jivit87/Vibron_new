/**
 * SWE-bench Verified: the data rows and the per-repo harness facts
 * (ported from Pramana `bench/swebench`, which reads SWE-bench's own
 * `MAP_REPO_VERSION_TO_SPECS` and `MAP_REPO_TO_PARSER`).
 *
 * Data source, first hit wins:
 *   1. a local rows file (`--data`, `VIBERON_SWE_DATA`, or Pramana's
 *      `$PRAMANA_SWE_WORK/swe_verified.json`): a JSON array or JSONL of rows;
 *   2. the Hugging Face datasets server for `princeton-nlp/SWE-bench_Verified`
 *      (split `test`): the whole split, paged, cached once as
 *      `eval/.cache/swe/swe-bench-verified.jsonl`.
 *
 * Specs cover the repos Pramana ran without Docker (requests, pytest, sympy,
 * django, flask, pylint); anything else gets a generic pytest spec.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseTestOutput } from "@/lib/verify/parse";
import type { TestOutcome } from "@/lib/verify/types";

export interface SweInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  version: string;
  /** Hidden tests: applied only at grading time, never shown to the agent. */
  test_patch: string;
  /** The official fix (used only by `--gold`). */
  patch?: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

const HF_ROWS_URL =
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test";
const HF_PAGE = 100;

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    try {
      return list(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeRow(raw: Record<string, unknown>): SweInstance {
  return {
    instance_id: String(raw.instance_id ?? ""),
    repo: String(raw.repo ?? ""),
    base_commit: String(raw.base_commit ?? ""),
    problem_statement: String(raw.problem_statement ?? ""),
    version: String(raw.version ?? ""),
    test_patch: String(raw.test_patch ?? ""),
    ...(typeof raw.patch === "string" ? { patch: raw.patch } : {}),
    FAIL_TO_PASS: list(raw.FAIL_TO_PASS),
    PASS_TO_PASS: list(raw.PASS_TO_PASS),
  };
}

function localRowsFile(explicit?: string): string | null {
  const pramana = path.join(process.env.PRAMANA_SWE_WORK || path.join(os.homedir(), "pramana_work"), "swe_verified.json");
  for (const file of [explicit, process.env.VIBERON_SWE_DATA, pramana]) {
    if (file && existsSync(file)) return file;
  }
  if (explicit) throw new Error(`SWE-bench rows file not found: ${explicit}`);
  return null;
}

function parseRows(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as Record<string, unknown>[];
  return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The whole Verified split (500 rows) from the datasets server, paged; written once as JSONL. */
async function downloadRows(file: string, fetchImpl: typeof fetch): Promise<void> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0, total = Infinity; offset < total; offset += HF_PAGE) {
    const response = await fetchImpl(`${HF_ROWS_URL}&offset=${offset}&length=${HF_PAGE}`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`SWE-bench rows: HTTP ${response.status} at offset ${offset}`);
    const body = (await response.json()) as { num_rows_total?: number; rows?: { row?: Record<string, unknown> }[] };
    total = body.num_rows_total ?? 0;
    for (const r of body.rows ?? []) if (r.row) rows.push(r.row);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

type RowsOptions = { dataFile?: string; cacheDir: string; fetchImpl?: typeof fetch };

async function rowsFile(options: RowsOptions): Promise<string> {
  let file = localRowsFile(options.dataFile);
  if (!file) {
    file = path.join(options.cacheDir, "swe-bench-verified.jsonl");
    if (!existsSync(file)) await downloadRows(file, options.fetchImpl ?? fetch);
  }
  return file;
}

/** Every row of the source (for `pick`). */
export async function loadAllInstances(options: RowsOptions): Promise<SweInstance[]> {
  return parseRows(await readFile(await rowsFile(options), "utf8")).map(normalizeRow);
}

/**
 * Pramana `swe_eval.py pick`: a stratified sample of the repos that install
 * without Docker, reproducible by seed (per repo: sort ids, seeded shuffle, take n).
 */
export const PICK_PER_REPO: Record<string, number> = {
  "psf/requests": 3,
  "pytest-dev/pytest": 4,
  "sympy/sympy": 6,
  "django/django": 9,
  "pallets/flask": 1,
  "pylint-dev/pylint": 1,
};

export function pickIds(rows: Pick<SweInstance, "instance_id" | "repo">[], seed = 0, perRepo = PICK_PER_REPO): string[] {
  // mulberry32: small, deterministic, good enough for sampling.
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const ids: string[] = [];
  for (const [repo, n] of Object.entries(perRepo)) {
    const pool = rows.filter((r) => r.repo === repo).map((r) => r.instance_id).sort();
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    ids.push(...pool.slice(0, n));
  }
  return ids;
}

/** Rows for `ids`, in order. Throws naming any id the source does not have. */
export async function loadInstances(ids: string[], options: RowsOptions): Promise<SweInstance[]> {
  const file = await rowsFile(options);
  const rows = new Map(parseRows(await readFile(file, "utf8")).map((r) => [String(r.instance_id), r]));
  return ids.map((id) => {
    const row = rows.get(id);
    if (!row) throw new Error(`${id} is not in ${file}`);
    return normalizeRow(row);
  });
}

/* ------------------------------ repo specs ------------------------------ */

export type SweParser = (log: string) => Record<string, TestOutcome>;

export interface SweSpec {
  python: string;
  /** Extra pip requirements before the repo itself is installed. */
  packages: string[];
  editable: boolean;
  testCmd: string;
  /** Test-patch files → arguments for `testCmd`. */
  directives: (files: string[]) => string[];
  parse: SweParser;
}

const NON_TEST = /\.(json|png|csv|txt|md|jpe?g|pkl|ya?ml|toml)$/;

const pytestParse: SweParser = (log) => parseTestOutput("pytest", log).tests;

const VERDICT = /\.\.\.\s*(ok|OK|FAIL|ERROR|skipped.*|expected failure|unexpected success)\s*$/;

function verdictOutcome(verdict: string): TestOutcome {
  if (/^ok$|^expected failure$/i.test(verdict)) return "pass";
  if (verdict === "ERROR") return "error";
  if (verdict.startsWith("skipped")) return "skip";
  return "fail";
}

/** Django's runtests verbose output: `test_x (app.tests.Case) ... ok`; the id is everything before ` ... `. */
export const parseDjango: SweParser = (log) => {
  const tests: Record<string, TestOutcome> = {};
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trimEnd();
    const m = /^(.+?) \.\.\.\s*(ok|OK|FAIL|ERROR|skipped.*|expected failure|unexpected success)\s*$/.exec(line);
    if (m) {
      tests[m[1]!.trim()] = verdictOutcome(m[2]!);
      continue;
    }
    // A test with a docstring prints the verdict on the docstring's line.
    const head = /^(\w+ \([\w.]+\))$/.exec(line);
    const next = VERDICT.exec(lines[i + 1] ?? "");
    if (head && next) {
      tests[head[1]!] = verdictOutcome(next[1]!);
      i += 1;
    }
  }
  for (const line of lines) {
    const m = /^(FAIL|ERROR): (\w+ \([\w.]+\))/.exec(line);
    if (m && !tests[m[2]!]) tests[m[2]!] = m[1] === "ERROR" ? "error" : "fail";
  }
  return tests;
};

/** sympy `bin/test --verbose`: `test_name ok` / `F` / `E` / `f` (xfail) / `s`. */
export const parseSympy: SweParser = (log) => {
  const tests: Record<string, TestOutcome> = {};
  for (const line of log.split("\n")) {
    const m = /^\s*(test_\w+)\s+(ok|F|E|f|s|X|w)\s*$/.exec(line);
    if (!m) continue;
    tests[m[1]!] = m[2] === "ok" || m[2] === "f" ? "pass" : m[2] === "E" ? "error" : m[2] === "s" || m[2] === "w" ? "skip" : "fail";
  }
  return tests;
};

const PYTEST_SPEC: SweSpec = {
  python: "3.9",
  packages: [],
  editable: true,
  testCmd: "pytest -rA -p no:cacheprovider",
  directives: (files) => files,
  parse: pytestParse,
};

function djangoPython(version: string): string {
  const [major, minor] = version.split(".").map(Number);
  if (major! >= 5) return "3.11";
  if (major === 4) return minor! >= 2 ? "3.9" : "3.8";
  return "3.8";
}

export function specFor(instance: Pick<SweInstance, "repo" | "version">): SweSpec {
  switch (instance.repo) {
    case "django/django":
      return {
        python: djangoPython(instance.version),
        packages: [],
        editable: true,
        testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
        directives: (files) =>
          files.map((f) => f.replace(/\.py$/, "").replace(/^tests\//, "").replace(/\//g, ".")),
        parse: parseDjango,
      };
    case "sympy/sympy":
      return { ...PYTEST_SPEC, packages: ["mpmath==1.3.0"], testCmd: "bin/test -C --verbose", parse: parseSympy };
    case "pallets/flask":
      return { ...PYTEST_SPEC, python: "3.11" };
    case "psf/requests":
      return { ...PYTEST_SPEC, editable: false };
    default:
      return PYTEST_SPEC;
  }
}

/** Test files a test patch touches, as `testCmd` arguments. */
export function testDirectives(instance: SweInstance): string[] {
  const files = [...instance.test_patch.matchAll(/^diff --git a\/.* b\/(.*)$/gm)].map((m) => m[1]!);
  return specFor(instance).directives(files.filter((f) => !NON_TEST.test(f)));
}

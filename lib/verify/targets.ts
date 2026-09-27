/**
 * Smallest relevant test target for a change (port of Pramana's
 * `related_test_commands` + workspace test detection).
 *
 * Given changed files and changed symbols, pick the test files that exercise
 * them (changed tests, naming conventions with directory mirroring, imports of
 * the changed module) and, when the tests name a changed symbol, narrow further
 * to test ids: pytest node ids, `-k`, vitest/jest `-t`, node `--test-name-pattern`,
 * go `-run`. The command runs under a time cap that scales with the target size.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { detectVerifyCommands, listRepoPaths, TEST_FILE_RE } from "@/lib/verify/detect";
import type { TestFramework, VerifyCommand } from "@/lib/verify/types";

export interface RelatedTestTargets {
  /** Selected test files, best first. */
  files: string[];
  /** Narrowest ids: pytest node ids (`path::Class::test`), unittest dotted ids, or test names. */
  testIds: string[];
  /** Ready-to-run targeted command, or null when no target was found (run the full suite). */
  command: string | null;
  framework: TestFramework | null;
  /** Time cap for `command` in ms. */
  timeoutMs: number;
  /** Why these targets, for the report. */
  reason: string;
}

export interface RelatedTestOptions {
  /** Test command to target; detected when omitted. */
  command?: VerifyCommand | null;
  /** Max test files (Pramana: 2). */
  limit?: number;
  /** Upper bound for the cap (default 120 s). */
  maxTimeoutMs?: number;
  /** Precomputed repo file list (skips a walk). */
  files?: string[];
}

/** Pramana's `is_test_path`, plus the Java/Go conventions of TEST_FILE_RE. */
export function isTestPath(p: string): boolean {
  const low = p.toLowerCase();
  return (
    /(^|\/)(tests?|testing|spec|__tests__)(\/|$)/.test(low) ||
    /(^|\/)(test_[^/]*|[^/]*_test\.\w+|[^/]*\.(test|spec)\.\w+)$/.test(low) ||
    TEST_FILE_RE.test(p)
  );
}

const CODE_TEST_RE = /\.(py|[cm]?[jt]sx?|go|rs|java)$/;

function stemOf(file: string): string {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, "");
  return base === "__init__" || base === "index" ? path.posix.basename(path.posix.dirname(file)) : base;
}

function conventionNames(stem: string): Set<string> {
  return new Set([
    `test_${stem}.py`, `${stem}_test.py`, `test_${stem}s.py`, `tests_${stem}.py`,
    ...["js", "ts", "mjs", "cjs", "jsx", "tsx"].flatMap((e) => [`${stem}.test.${e}`, `${stem}.spec.${e}`]),
    `${stem}_test.go`, `${stem}Test.java`, `${stem}Tests.java`,
  ].map((n) => n.toLowerCase()));
}

function readHead(root: string, rel: string, max = 200_000): string {
  try {
    return readFileSync(path.join(root, rel), "utf8").slice(0, max);
  } catch {
    return "";
  }
}

/** Module specifiers a test imports (python dotted, JS relative/bare). */
function importsOf(src: string): string[] {
  const out: string[] = [];
  const re =
    /^\s*from\s+([.\w]+)\s+import|^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)|\bfrom\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)|\bimport\(\s*["']([^"']+)["']\s*\)|^\s*import\s+["']([^"']+)["']/gm;
  for (const m of src.matchAll(re)) {
    if (m[2]) out.push(...m[2].split(",").map((s) => s.trim()));
    else out.push(m[1] ?? m[3] ?? m[4] ?? m[5] ?? m[6]);
  }
  return out.filter(Boolean);
}

/** Does `spec` (imported from `testFile`) refer to `changed`? */
function importHits(spec: string, testFile: string, changed: string): boolean {
  const noExt = changed.replace(/\.[^.]+$/, "");
  const jsHit = (resolved: string) => {
    const r = resolved.replace(/\.[cm]?[jt]sx?$/, "");
    return r === noExt || `${r}/index` === noExt;
  };
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return jsHit(path.posix.normalize(path.posix.join(path.posix.dirname(testFile), spec)));
  }
  if (spec.startsWith("@/")) return jsHit(spec.slice(2));
  if (!/^[.\w]+$/.test(spec)) return false;
  // Python dotted module (absolute or `src/` layout; relative dots stripped).
  const dotted = noExt.replace(/\/__init__$/, "").split("/");
  const mod = spec.replace(/^\.+/, "");
  if (!mod) return false;
  for (let i = 0; i < dotted.length; i += 1) {
    const tail = dotted.slice(i).join(".");
    if (mod === tail || mod.startsWith(`${tail}.`)) return i === 0 || dotted[0] === "src" || i === dotted.length - 1;
  }
  return false;
}

/** camelCase / PascalCase → snake, lowercase. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

interface TestCase {
  /** Function or `it()` name. */
  name: string;
  /** Enclosing python class, if any. */
  cls?: string;
}

function testCasesOf(file: string, src: string): TestCase[] {
  const out: TestCase[] = [];
  if (file.endsWith(".py")) {
    let cls: string | undefined;
    for (const line of src.split("\n")) {
      const c = /^class\s+(\w+)/.exec(line);
      if (c) {
        cls = c[1];
        continue;
      }
      const d = /^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/.exec(line);
      if (d) out.push({ name: d[2], cls: d[1].length > 0 ? cls : undefined });
      else if (/^\S/.test(line) && !/^[@#]/.test(line)) cls = undefined;
    }
  } else if (file.endsWith(".go")) {
    for (const m of src.matchAll(/^func\s+(Test\w+)\s*\(/gm)) out.push({ name: m[1] });
  } else {
    for (const m of src.matchAll(/\b(?:it|test)(?:\.\w+)?\(\s*(["'`])((?:(?!\1).){1,200})\1/g)) out.push({ name: m[2] });
  }
  return out;
}

function matchesSymbol(testName: string, symbols: string[]): boolean {
  const low = testName.toLowerCase();
  const sn = snake(testName);
  return symbols.some((s) => low.includes(s.toLowerCase()) || sn.includes(snake(s)));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Rank test files for the change. Scores: changed test 10, naming convention
 * 6 (+ directory overlap), import of a changed module 4, test named after a
 * changed symbol 2, textual mention of a changed stem 1.
 */
const LANG_TESTS: Partial<Record<TestFramework, RegExp>> = {
  pytest: /\.py$/,
  unittest: /\.py$/,
  vitest: /\.[cm]?[jt]sx?$/,
  jest: /\.[cm]?[jt]sx?$/,
  "node-test": /\.[cm]?[jt]sx?$/,
  go: /\.go$/,
  cargo: /\.rs$/,
  maven: /\.java$/,
  gradle: /\.java$/,
};

function rankTests(root: string, all: string[], changedFiles: string[], symbols: string[], framework: TestFramework | null) {
  const lang = (framework && LANG_TESTS[framework]) || CODE_TEST_RE;
  const tests = all.filter((f) => isTestPath(f) && lang.test(f));
  const src = changedFiles.filter((f) => !isTestPath(f));
  const scores = new Map<string, number>();
  const cases = new Map<string, TestCase[]>();
  const bump = (f: string, n: number) => scores.set(f, (scores.get(f) ?? 0) + n);
  for (const f of changedFiles) if (tests.includes(f)) bump(f, 10);

  for (const s of src) {
    const names = conventionNames(stemOf(s));
    const parts = new Set(s.split("/"));
    for (const t of tests) {
      const base = path.posix.basename(t).toLowerCase();
      // Exact convention (test_x.py, x.test.ts) or a dotted/underscored
      // prefix naming the module (verify.x.test.ts, test_pkg_x.py).
      const stem = stemOf(s).toLowerCase();
      const loose = base.split(/[._-]/).slice(0, -1).includes(stem) && /(^|[._])(test|spec)s?([._]|$)/.test(base);
      if (!names.has(base) && !loose) continue;
      const overlap = t.split("/").filter((p) => parts.has(p)).length;
      bump(t, (names.has(base) ? 6 : 5) + Math.min(overlap, 3) * 0.5 - t.length / 1000);
    }
  }

  const stems = [...new Set(src.map(stemOf))].filter((s) => s.length >= 2);
  const mention = stems.length ? new RegExp(`\\b(${stems.map(regexEscape).join("|")})\\b`, "i") : null;
  const syms = symbols.filter((s) => s.length >= 3);
  // Bounded: import scans read at most 2000 test files.
  for (const t of tests.slice(0, 2000)) {
    const body = readHead(root, t);
    if (!body) continue;
    const specs = importsOf(body);
    if (src.some((c) => specs.some((sp) => importHits(sp, t, c)))) bump(t, 4);
    else if (mention?.test(body.slice(0, 4000))) bump(t, 1);
    if (syms.length) {
      const hits = testCasesOf(t, body).filter((c) => matchesSymbol(c.name, syms));
      if (hits.length) {
        cases.set(t, hits);
        bump(t, 2);
      }
    }
  }
  const sorted = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // A bare textual mention only counts when nothing stronger was found.
  const strong = (sorted[0]?.[1] ?? 0) >= 2;
  const ranked = sorted.filter(([, s]) => !strong || s >= 2).map(([f]) => f);
  return { ranked, cases };
}

/** Build the targeted command. Returns [command, ids]. */
function buildCommand(cmd: VerifyCommand, files: string[], cases: Map<string, TestCase[]>): [string | null, string[]] {
  const picked = files.map((f) => ({ f, c: cases.get(f) ?? [] }));
  // Only narrow by name when EVERY picked file has matching cases; otherwise
  // a name filter would silently drop the other files' tests.
  const narrow = picked.every((p) => p.c.length > 0) && picked.length > 0;
  const q = (xs: string[]) => xs.map(shellQuote).join(" ");
  switch (cmd.framework) {
    case "pytest": {
      const base = (cmd.targetTemplate ?? "python -m pytest -q -rA {files}").replace(/\s*\{files\}/, "");
      if (narrow) {
        const ids = picked.flatMap((p) => p.c.map((c) => [p.f, c.cls, c.name].filter(Boolean).join("::")));
        return [`${base} ${q(ids)}`, ids];
      }
      return [`${base} ${q(files)}`, []];
    }
    case "unittest": {
      const mod = (f: string) => f.replace(/\.py$/, "").split("/").join(".");
      if (narrow) {
        const ids = picked.flatMap((p) => p.c.filter((c) => c.cls).map((c) => `${mod(p.f)}.${c.cls}.${c.name}`));
        if (ids.length) return [`python -m unittest -v ${q(ids)}`, ids];
      }
      return [`python -m unittest -v ${q(files.map(mod))}`, []];
    }
    case "vitest":
    case "jest":
    case "node-test": {
      const tmpl = cmd.targetTemplate ?? (cmd.framework === "vitest" ? "npx vitest run {files}" : cmd.framework === "jest" ? "npx jest {files}" : "node --test {files}");
      let command = tmpl.replace("{files}", q(files));
      const names = narrow ? [...new Set(picked.flatMap((p) => p.c.map((c) => c.name)))] : [];
      if (names.length) {
        const pattern = names.map(regexEscape).join("|");
        command = cmd.framework === "node-test"
          ? command.replace(/^node --test/, `node --test --test-name-pattern=${shellQuote(pattern)}`)
          : `${command} -t ${shellQuote(pattern)}`;
      }
      return [command, names];
    }
    case "go": {
      const pkgs = [...new Set(files.map((f) => `./${path.posix.dirname(f)}`))];
      const names = narrow ? [...new Set(picked.flatMap((p) => p.c.map((c) => c.name)))] : [];
      const run = names.length ? ` -run ${shellQuote(`^(${names.join("|")})$`)}` : "";
      return [`go test -json${run} ${q(pkgs)}`, names];
    }
    default:
      return cmd.targetTemplate?.includes("{files}") ? [cmd.targetTemplate.replace("{files}", q(files)), []] : [null, []];
  }
}

/**
 * The smallest relevant test target for changed files/symbols.
 * `command` is null when nothing relevant is found or the framework cannot
 * be targeted: the caller then runs the full suite (or skips).
 */
export async function relatedTestTargets(
  root: string,
  changedFiles: string[],
  changedSymbols: string[] = [],
  options: RelatedTestOptions = {},
): Promise<RelatedTestTargets> {
  const limit = options.limit ?? 2;
  const maxTimeoutMs = options.maxTimeoutMs ?? 120_000;
  const cmd =
    options.command === undefined
      ? (await detectVerifyCommands(root)).find((c) => c.kind === "test") ?? null
      : options.command;
  const none = (reason: string): RelatedTestTargets => ({ files: [], testIds: [], command: null, framework: cmd?.framework ?? null, timeoutMs: maxTimeoutMs, reason });
  if (!changedFiles.length) return none("no changed files");
  const all = options.files ?? listRepoPaths(root);
  const { ranked, cases } = rankTests(root, all, changedFiles, changedSymbols, cmd?.framework ?? null);
  const files = ranked.slice(0, limit);
  if (!files.length) return none("no related test files");
  if (!cmd) return { ...none("no test command detected"), files };
  const [command, testIds] = buildCommand(cmd, files, cases);
  // Cap: 20 s base + 20 s per file, bounded (Pramana gate: 300 s suite cap).
  const timeoutMs = Math.min(maxTimeoutMs, 20_000 + 20_000 * files.length);
  const why = files.map((f) => (cases.get(f)?.length ? `${f} (${cases.get(f)!.length} named tests)` : f)).join(", ");
  return { files, testIds, command, framework: cmd.framework, timeoutMs, reason: `related: ${why}` };
}

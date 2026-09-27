/**
 * Detect how to verify a repository, independently of the model.
 *
 * Order (docs/PLAN-SOLVE.md, lib/verify): Python (pytest when importable, else
 * unittest), package.json test script (vitest/jest/node --test), go, cargo,
 * maven/gradle, make; then fallback checks (tsc, Python syntax, go build,
 * cargo check). Tools that are not installed are skipped so the gate never
 * "verifies" with a command-not-found.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { IGNORED_DIRS } from "@/lib/local-disk-workspace";
import { buildRepoEnv, findRepoVenv, which } from "@/lib/verify/env";
import type { VerifyCommand } from "@/lib/verify/types";

/** Repo-relative file paths (no contents), honoring the scanner's ignore rules. */
export function listRepoPaths(root: string, limit = 20_000): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && entries.some((e) => e.isFile() && e.name === "pyvenv.cfg")) return;
    for (const entry of entries) {
      if (out.length >= limit) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.endsWith(".egg-info")) continue;
        visit(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        out.push(childRel);
      }
    }
  };
  visit(root, "");
  return out;
}

export const TEST_FILE_RE =
  /(^|\/)(test_[^/]+\.py|[^/]+_test\.py|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+_test\.go|[A-Z]\w*Tests?\.java)$|(^|\/)(tests?|__tests__|spec)\/[^/]+\.(py|[cm]?[jt]sx?|rs)$/;

function read(root: string, rel: string): string {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

/** Is pytest importable by the repo's python? */
export function pytestAvailable(root: string): boolean {
  const env = buildRepoEnv(root);
  const venv = findRepoVenv(root);
  const python = venv ? path.join(venv, "bin", "python") : (which("python", env.PATH) ?? which("python3", env.PATH));
  if (!python) return false;
  const probe = spawnSync(python, ["-c", "import pytest"], { cwd: root, env: env as NodeJS.ProcessEnv, timeout: 20_000, stdio: "ignore" });
  return probe.status === 0;
}

/** Double quotes only: the script is wrapped in single quotes for the shell. */
const PY_SYNTAX_CHECK = [
  "import ast, os, sys",
  "bad = 0",
  "skip = {\".git\", \".venv\", \"venv\", \"node_modules\", \"__pycache__\", \"build\", \"dist\", \".tox\"}",
  "for d, ds, fs in os.walk(\".\"):",
  "    ds[:] = [x for x in ds if x not in skip]",
  "    for f in fs:",
  "        if f.endswith(\".py\"):",
  "            p = os.path.join(d, f)",
  "            try:",
  "                ast.parse(open(p, encoding=\"utf-8\", errors=\"replace\").read(), p)",
  "            except SyntaxError as e:",
  "                bad += 1",
  "                print(f\"{p}:{e.lineno}: SyntaxError: {e.msg}\")",
  "sys.exit(1 if bad else 0)",
].join("\n");

/**
 * Files whose change can change detection. Their mtimes (plus the root and
 * test dirs, which change when a manifest or test file is added or removed,
 * the repo venv, and PATH) key the per-root cache.
 */
const DETECT_INPUTS = [
  // A pip install that adds pytest adds bin/pytest, touching bin/.
  ".", "tests", "test", ".venv/bin", "venv/bin",
  "package.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json",
  "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini", "pytest.ini",
  "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "build.gradle.kts", "Makefile",
];

function detectKey(root: string): string {
  const stamps = DETECT_INPUTS.map((rel) => {
    try {
      const st = statSync(path.join(root, rel));
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return "-";
    }
  });
  return `${process.env.PATH ?? ""}|${stamps.join("|")}`;
}

const detectCache = new Map<string, { key: string; commands: VerifyCommand[] }>();

/**
 * `detectVerifyCommands` walks the tree and probes the repo's Python for
 * pytest (hundreds of ms). The answer only changes when a manifest does, so
 * it is cached per root, keyed on those files' mtimes.
 */
export async function detectVerifyCommands(root: string): Promise<VerifyCommand[]> {
  const resolved = path.resolve(root);
  const key = detectKey(resolved);
  const hit = detectCache.get(resolved);
  if (hit?.key === key) return structuredClone(hit.commands);
  const commands = await detectUncached(resolved);
  detectCache.set(resolved, { key, commands: structuredClone(commands) });
  return commands;
}

async function detectUncached(root: string): Promise<VerifyCommand[]> {
  const files = listRepoPaths(root);
  const has = new Set(files);
  const env = buildRepoEnv(root);
  const bin = (name: string) => which(name, env.PATH) !== null;
  const tests: VerifyCommand[] = [];
  const fallbacks: VerifyCommand[] = [];

  /* ------------------------------ Python -------------------------------- */
  const pyFiles = files.filter((f) => f.endsWith(".py"));
  const pyTests = pyFiles.filter((f) => TEST_FILE_RE.test(f));
  const pyProject = ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "tox.ini", "pytest.ini"].some(
    (f) => has.has(f),
  );
  if (pyTests.length > 0 && (pyProject || pyFiles.length > 0)) {
    const configured =
      has.has("pytest.ini") ||
      /\[tool\.pytest|pytest/.test(read(root, "pyproject.toml")) ||
      /\[tool:pytest\]/.test(read(root, "setup.cfg"));
    if (pytestAvailable(root)) {
      tests.push({
        command: "python -m pytest -q -rA -p no:cacheprovider",
        framework: "pytest",
        kind: "test",
        targetTemplate: "python -m pytest -q -rA -p no:cacheprovider {files}",
        source: `python tests (${pyTests.length} files); pytest importable${configured ? ", configured" : ""}`,
      });
    } else {
      const startDir = ["tests", "test"].find((d) => files.some((f) => f.startsWith(`${d}/`)));
      tests.push({
        command: startDir
          ? `python -m unittest discover -v -s ${startDir}${has.has(`${startDir}/__init__.py`) ? " -t ." : ""}`
          : "python -m unittest discover -v",
        framework: "unittest",
        kind: "test",
        targetTemplate: "python -m unittest -v {files}",
        source: `python tests (${pyTests.length} files); pytest not installed, using unittest${
          configured ? " (repo configures pytest: pytest-only tests may error)" : ""
        }`,
      });
    }
  }

  /* ---------------------------- JavaScript ------------------------------ */
  if (has.has("package.json")) {
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(read(root, "package.json"));
    } catch {
      // Malformed package.json: fall through to file-based detection.
    }
    const script = pkg.scripts?.test ?? "";
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const runner = has.has("pnpm-lock.yaml") ? "pnpm" : has.has("yarn.lock") ? "yarn" : "npm";
    const placeholder = /no test specified/.test(script);
    if (script && !placeholder) {
      const framework = /vitest/.test(script) || ("vitest" in deps && !/jest/.test(script))
        ? "vitest"
        : /jest/.test(script) || "jest" in deps
          ? "jest"
          : /node\s+(--[\w-]+\s+)*--test/.test(script)
            ? "node-test"
            : "npm-script";
      tests.push({
        command: `${runner} test`,
        framework,
        kind: "test",
        targetTemplate:
          framework === "vitest"
            ? "npx vitest run {files}"
            : framework === "jest"
              ? "npx jest {files}"
              : framework === "node-test"
                ? "node --test {files}"
                : undefined,
        source: `package.json "test": ${script}`,
      });
    } else if (files.some((f) => /\.(test|spec)\.[cm]?js$/.test(f))) {
      tests.push({
        command: "node --test",
        framework: "node-test",
        kind: "test",
        targetTemplate: "node --test {files}",
        source: "*.test.js files and no test script",
      });
    }
    if (has.has("tsconfig.json") && existsSync(path.join(root, "node_modules", ".bin", "tsc"))) {
      fallbacks.push({
        command: "npx --no-install tsc --noEmit -p .",
        framework: "custom",
        kind: "typecheck",
        source: "tsconfig.json + local typescript",
      });
    }
  }

  /* ------------------------------ Go/Rust ------------------------------- */
  if (has.has("go.mod") && bin("go")) {
    tests.push({ command: "go test -json ./...", framework: "go", kind: "test", source: "go.mod" });
    fallbacks.push({ command: "go build ./...", framework: "go", kind: "compile", source: "go.mod" });
  }
  if (has.has("Cargo.toml") && bin("cargo")) {
    tests.push({ command: "cargo test", framework: "cargo", kind: "test", source: "Cargo.toml" });
    fallbacks.push({ command: "cargo check", framework: "cargo", kind: "compile", source: "Cargo.toml" });
  }

  /* ------------------------------- JVM ---------------------------------- */
  if (has.has("pom.xml") && bin("mvn")) {
    tests.push({ command: "mvn -q test", framework: "maven", kind: "test", source: "pom.xml" });
  } else if (has.has("build.gradle") || has.has("build.gradle.kts")) {
    if (has.has("gradlew")) {
      tests.push({ command: "./gradlew test", framework: "gradle", kind: "test", source: "gradlew" });
    } else if (bin("gradle")) {
      tests.push({ command: "gradle test", framework: "gradle", kind: "test", source: "build.gradle" });
    }
  }

  /* ------------------------------- make --------------------------------- */
  if (tests.length === 0 && has.has("Makefile") && /^test:/m.test(read(root, "Makefile")) && bin("make")) {
    tests.push({ command: "make test", framework: "make", kind: "test", source: "Makefile test target" });
  }

  if (pyFiles.length > 0) {
    fallbacks.push({
      command: `python -c '${PY_SYNTAX_CHECK}'`,
      framework: "custom",
      kind: "compile",
      source: "python syntax check (no .pyc written)",
    });
  }

  return [...tests, ...fallbacks];
}

/**
 * Environment bootstrap for repositories Viberon cloned itself (ported from
 * Pramana `repo/bootstrap.py`). Best effort and time-boxed: the goal is only
 * that the project's tests *can run*, because without runnable tests there
 * is no evidence. Every command goes through the terminal safety classifier.
 *
 * Fast paths (the reason this file exists beyond the port):
 * - Python and Node setup run concurrently.
 * - `uv` (when on PATH) creates the venv and installs; falls back to
 *   `python -m venv` + pip, exactly like Pramana.
 * - A stamp (hash of the dependency manifests) is written into `.venv/` and
 *   `node_modules/` after a successful install, so a reused clone whose
 *   manifests did not change skips `pip install -e` / `npm ci` entirely, and
 *   one whose manifests changed reinstalls into the existing venv.
 * - A `node_modules/` we did not create is always respected (never touched).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { classifyCommand } from "@/lib/terminal/safety";
import { excludeFromGit } from "@/lib/workspace/graph-index";
import { execInRepo, findRepoVenv, which } from "@/lib/verify";

export interface BootstrapOptions {
  onProgress?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Test seam: resolve a binary on PATH (default `which`). */
  which?: (name: string) => string | null;
}

const STAMP = ".viberon-bootstrap";
const PY_MANIFESTS = ["pyproject.toml", "setup.py", "setup.cfg"];
const BASE_REQS = [
  "requirements.txt",
  "requirements-dev.txt",
  "requirements_test.txt",
  "requirements-test.txt",
  "test-requirements.txt",
  "requirements/test.txt",
  "requirements/dev.txt",
  "requirements/tests.txt",
];
const NODE_LOCKS = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"];

function declaresExtra(root: string, name: string): boolean {
  for (const file of PY_MANIFESTS) {
    try {
      const text = readFileSync(path.join(root, file), "utf8");
      if (new RegExp(`(^|[\\s"'\\[,])${name}\\s*[=:\\]"']`, "m").test(text)) return true;
    } catch {
      // Missing file.
    }
  }
  return false;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Requirement files to install: the fixed list plus any test/dev file under
 * `requirements*` dirs or named `*requirements*test*.txt` (Pramana measured
 * arrow keeping its test deps in `requirements/requirements-tests.txt`).
 */
export function requirementFiles(root: string): string[] {
  const out = BASE_REQS.filter((r) => isFile(path.join(root, r)));
  const add = (rel: string) => {
    if (!out.includes(rel) && isFile(path.join(root, rel))) out.push(rel);
  };
  let top: string[] = [];
  try {
    top = readdirSync(root).sort();
  } catch {
    return out;
  }
  for (const name of top) {
    if (/requirements.*test.*\.txt$|test.*requirements.*\.txt$/i.test(name)) add(name);
    if (/^requirements/i.test(name)) {
      try {
        for (const child of readdirSync(path.join(root, name)).sort()) {
          if (/(test|dev).*\.txt$/i.test(child)) add(`${name}/${child}`);
        }
      } catch {
        // Not a directory.
      }
    }
  }
  return out;
}

/** Hash of the files that decide what an install produces. */
export function manifestHash(root: string, files: string[]): string {
  const hash = createHash("sha1");
  for (const rel of files) {
    hash.update(rel);
    try {
      hash.update(readFileSync(path.join(root, rel)));
    } catch {
      hash.update("-");
    }
  }
  return hash.digest("hex");
}

function readStamp(dir: string): string | null {
  try {
    return readFileSync(path.join(dir, STAMP), "utf8").trim();
  } catch {
    return null;
  }
}

function writeStamp(dir: string, value: string): void {
  try {
    writeFileSync(path.join(dir, STAMP), value);
  } catch {
    // Best effort: a missing stamp only costs a reinstall next time.
  }
}

export async function bootstrapEnvironment(root: string, options: BootstrapOptions = {}): Promise<string[]> {
  const progress = options.onProgress ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const whichBin = options.which ?? ((name: string) => which(name));
  const has = (file: string) => existsSync(path.join(root, file));

  const run = async (notes: string[], command: string, what: string): Promise<boolean> => {
    const verdict = classifyCommand(command);
    if (verdict.allowed === false) {
      notes.push(`${what}: refused (${verdict.reason})`);
      return false;
    }
    progress(`$ ${command}`);
    const result = await execInRepo(root, command, { timeoutMs, signal: options.signal });
    const ok = result.exitCode === 0 && !result.timedOut;
    const last = result.output.trim().split("\n").at(-1)?.slice(0, 160) ?? "";
    notes.push(`${what}: ${ok ? "ok" : result.timedOut ? "timed out" : `failed (${last})`}`);
    progress(`${what}: ${ok ? "ok" : "failed"}`);
    return ok;
  };

  const python = async (): Promise<string[]> => {
    const notes: string[] = [];
    const reqs = requirementFiles(root);
    if (![...PY_MANIFESTS, "requirements.txt"].some(has)) return notes;
    const stamp = manifestHash(root, [...PY_MANIFESTS, ...reqs]);
    const existing = findRepoVenv(root);
    if (existing && readStamp(existing) === stamp) {
      notes.push("python deps: cached (manifests unchanged)");
      return notes;
    }
    // A venv we did not create (no stamp) is the user's: respect it, like Pramana.
    if (existing && readStamp(existing) === null) return notes;

    const venv = existing ?? path.join(root, ".venv");
    const venvPython = path.join(venv, "bin", "python");
    const rel = path.relative(root, venv) || ".venv";
    let pip: string | null = existing ? pipCommand(whichBin, rel) : null;
    if (!existing) {
      const uv = whichBin("uv");
      // --no-config: a project's [tool.uv] (e.g. a pinned required-version) must not stop setup.
      if (uv && (await run(notes, `uv venv -q --no-config ${rel}`, "create .venv (uv)"))) {
        pip = `uv pip install -q --no-config --python ${rel}/bin/python`;
      } else {
        if (uv) rmSync(venv, { recursive: true, force: true });
        const py = whichBin("python3") ? "python3" : whichBin("python") ? "python" : null;
        if (!py) {
          notes.push("python: not found on PATH");
          return notes;
        }
        if (await run(notes, `${py} -m venv ${rel}`, "create .venv")) pip = `${rel}/bin/python -m pip install -q`;
      }
      if (!pip) return notes;
      await excludeFromGit(root, "/.venv/").catch(() => false);
    }
    if (!pip) return notes;

    let ok = true;
    let installed = false;
    for (const extra of ["test", "tests", "testing", "dev"]) {
      if (declaresExtra(root, extra)) {
        installed = await run(notes, `${pip} -e '.[${extra}]'`, `pip install -e .[${extra}]`);
        if (installed) break;
      }
    }
    if (!installed && PY_MANIFESTS.some(has)) ok = (await run(notes, `${pip} -e .`, "pip install -e .")) && ok;
    for (const req of reqs) ok = (await run(notes, `${pip} -r ${req}`, `pip install -r ${req}`)) && ok;
    if (!existsSync(path.join(venv, "bin", "pytest"))) {
      ok = (await run(notes, `${pip} pytest`, "pip install pytest")) && ok;
    }
    if (ok && existsSync(venvPython)) writeStamp(venv, stamp);
    return notes;
  };

  const node = async (): Promise<string[]> => {
    const notes: string[] = [];
    if (!has("package.json")) return notes;
    const stamp = manifestHash(root, ["package.json", ...NODE_LOCKS]);
    const modules = path.join(root, "node_modules");
    if (existsSync(modules)) {
      const previous = readStamp(modules);
      if (previous === null) return notes; // Installed by someone else: respect it.
      if (previous === stamp) {
        notes.push("node deps: cached (lockfile unchanged)");
        return notes;
      }
    }
    const command =
      has("pnpm-lock.yaml") && whichBin("pnpm")
        ? "pnpm install --frozen-lockfile --prefer-offline"
        : has("yarn.lock") && whichBin("yarn")
          ? "yarn install --frozen-lockfile --prefer-offline"
          : has("package-lock.json") || has("npm-shrinkwrap.json")
            ? "npm ci --no-audit --no-fund --prefer-offline"
            : "npm install --no-audit --no-fund --prefer-offline";
    if (await run(notes, command, "node dependencies")) writeStamp(modules, stamp);
    return notes;
  };

  const [py, js] = await Promise.all([python(), node()]);
  return [...py, ...js];
}

function pipCommand(whichBin: (name: string) => string | null, rel: string): string {
  return whichBin("uv") ? `uv pip install -q --no-config --python ${rel}/bin/python` : `${rel}/bin/python -m pip install -q`;
}

// ---------------------------------------------------------------------------
// One-pass repository probe (ported from Pramana `repo/workspace.py`
// `inspect_repo` + `detect_tests`, without the Python subprocess).
// ---------------------------------------------------------------------------

const LANG_BY_EXT: Record<string, string> = {
  ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".ts": "TypeScript", ".tsx": "TypeScript", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".rb": "Ruby", ".php": "PHP", ".c": "C", ".h": "C/C++", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
  ".cs": "C#", ".swift": "Swift", ".scala": "Scala", ".ex": "Elixir", ".exs": "Elixir", ".lua": "Lua",
};

export interface RepoProbe {
  languages: string[];
  primaryLanguage: string;
  fileCount: number;
  testFramework: string;
  testCommand: string;
  /** Template with `{files}` (or `{packages}`, `{modules}`…), or "". */
  testFileCommand: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  venv: string | null;
}

export function detectTests(
  root: string,
  files: string[],
  lang: string,
): { framework: string; command: string; fileCommand: string; packageManager?: RepoProbe["packageManager"] } {
  const has = new Set(files);
  if (lang === "Python" || files.slice(0, 2000).some((f) => f.endsWith(".py"))) {
    if (has.has("tests/runtests.py") && files.slice(0, 5000).some((f) => f.startsWith("django/"))) {
      return { framework: "django runtests", command: "python tests/runtests.py --parallel 1", fileCommand: "python tests/runtests.py --parallel 1 {modules}" };
    }
    if (has.has("bin/test") && files.slice(0, 5000).some((f) => f.startsWith("sympy/"))) {
      return { framework: "sympy (pytest-compatible)", command: "python -m pytest -q", fileCommand: "python -m pytest -q {files}" };
    }
    return { framework: "pytest", command: "python -m pytest -q", fileCommand: "python -m pytest -q {files}" };
  }
  if (has.has("package.json")) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    } catch {
      // Unparseable package.json.
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const script = pkg.scripts?.test ?? "";
    const packageManager = has.has("pnpm-lock.yaml") ? "pnpm" : has.has("yarn.lock") ? "yarn" : "npm";
    const command = script ? `${packageManager} test` : "node --test";
    const base = { command, packageManager } as const;
    if ("vitest" in deps || script.includes("vitest")) return { ...base, framework: "vitest", fileCommand: "npx vitest run {files}" };
    if ("jest" in deps || script.includes("jest")) return { ...base, framework: "jest", fileCommand: "npx jest {files}" };
    if ("mocha" in deps || script.includes("mocha")) return { ...base, framework: "mocha", fileCommand: "npx mocha {files}" };
    if (!script || script.includes("node --test")) return { ...base, framework: "node:test", fileCommand: "node --test {files}" };
    return { ...base, framework: "npm test", fileCommand: "" };
  }
  if (has.has("go.mod")) return { framework: "go test", command: "go test ./...", fileCommand: "go test {packages}" };
  if (has.has("Cargo.toml")) return { framework: "cargo test", command: "cargo test", fileCommand: "cargo test {filter}" };
  if (has.has("pom.xml")) return { framework: "maven", command: "mvn -q test", fileCommand: "mvn -q test -Dtest={classes}" };
  if (has.has("build.gradle") || has.has("build.gradle.kts")) {
    return { framework: "gradle", command: has.has("gradlew") ? "./gradlew test" : "gradle test", fileCommand: "" };
  }
  if (has.has("Gemfile")) {
    return files.some((f) => f.startsWith("spec/"))
      ? { framework: "rspec", command: "bundle exec rspec", fileCommand: "bundle exec rspec {files}" }
      : { framework: "rake", command: "bundle exec rake test", fileCommand: "" };
  }
  if (has.has("Makefile")) {
    try {
      if (/^test:/m.test(readFileSync(path.join(root, "Makefile"), "utf8"))) return { framework: "make", command: "make test", fileCommand: "" };
    } catch {
      // Unreadable Makefile.
    }
  }
  return { framework: "unknown", command: "", fileCommand: "" };
}

/** Language + test runner in one pass over a file list (pass `files` to reuse a listing). */
export function probeRepo(root: string, files: string[]): RepoProbe {
  const counts = new Map<string, number>();
  for (const f of files) {
    const lang = LANG_BY_EXT[path.extname(f).toLowerCase()];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const primaryLanguage = languages[0] ?? "unknown";
  const tests = detectTests(root, files, primaryLanguage);
  return {
    languages,
    primaryLanguage,
    fileCount: files.length,
    testFramework: tests.framework,
    testCommand: tests.command,
    testFileCommand: tests.fileCommand,
    ...(tests.packageManager ? { packageManager: tests.packageManager } : {}),
    venv: findRepoVenv(root),
  };
}

/** Compact (few-token) one-line-per-fact summary for a model's first message. */
export function probeSummary(probe: RepoProbe): string {
  const lines = [
    `Languages: ${probe.languages.slice(0, 4).join(", ") || "unknown"} (${probe.fileCount} files)`,
    `Tests: ${probe.testFramework}${probe.testCommand ? ` - run: \`${probe.testCommand}\`` : ""}` +
      (probe.testFileCommand ? ` (specific files: \`${probe.testFileCommand}\`)` : ""),
  ];
  if (probe.venv) lines.push(`Venv: ${probe.venv}`);
  return lines.join("\n");
}

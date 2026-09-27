/**
 * Execution environment for a repository's own commands (ported from
 * Pramana `tools/shell.py`): activate the repo's virtualenv, bridge
 * `python` → `python3` when only python3 exists, put the repo (and `src/`)
 * on PYTHONPATH, make every tool non-interactive, and never pass API keys
 * to repo code.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scrubEnv } from "@/lib/terminal/safety";

const VENV_NAMES = [".venv", "venv", "env", ".env"];

export function findRepoVenv(root: string): string | null {
  for (const dir of [root, mainWorktree(root)]) {
    if (!dir) continue;
    for (const name of VENV_NAMES) {
      const candidate = path.join(dir, name);
      if (
        existsSync(path.join(candidate, "bin", "python")) ||
        existsSync(path.join(candidate, "Scripts", "python.exe"))
      ) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * The main checkout behind a linked git worktree (`.git` is a file pointing
 * at `<main>/.git/worktrees/<name>`), or null. An issue worktree has no
 * virtualenv of its own, so it uses the one installed in the main checkout.
 */
function mainWorktree(root: string): string | null {
  try {
    const pointer = readFileSync(path.join(root, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    const match = gitdir && /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(root, gitdir));
    return match ? match[1] : null;
  } catch {
    return null; // .git is a directory (a normal checkout) or missing.
  }
}

/** First match for `name` on a PATH string, or null. */
export function which(name: string, pathValue = process.env.PATH ?? ""): string | null {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Directory holding a `python` symlink to python3 when PATH has no `python`. */
function pythonShimDir(pathValue: string): string | null {
  if (which("python", pathValue)) return null;
  const py3 = which("python3", pathValue);
  if (!py3) return null;
  const dir = path.join(os.tmpdir(), "viberon-python-shim");
  const link = path.join(dir, "python");
  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(link)) symlinkSync(py3, link);
    return dir;
  } catch {
    return null;
  }
}

/** Directories to put in front of PATH for this repo (venv bin, python shim). */
export function repoPathPrefix(root: string, basePath = process.env.PATH ?? ""): string[] {
  const prefix: string[] = [];
  const venv = findRepoVenv(root);
  if (venv) {
    prefix.push(path.join(venv, process.platform === "win32" ? "Scripts" : "bin"));
  }
  const shim = pythonShimDir([...prefix, basePath].join(path.delimiter));
  if (shim) prefix.push(shim);
  return prefix;
}

/** Full environment for running repo commands (tests, installs, probes). */
export function buildRepoEnv(
  root: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const base = scrubEnv(process.env) as Record<string, string>;
  delete base.PYTHONHOME;
  delete base.__PYVENV_LAUNCHER__;
  const venv = findRepoVenv(root);
  const prefix = repoPathPrefix(root, base.PATH ?? "");
  const pythonPath = [root];
  if (existsSync(path.join(root, "src")) && !existsSync(path.join(root, "src", "__init__.py"))) {
    pythonPath.unshift(path.join(root, "src"));
  }
  if (base.PYTHONPATH) pythonPath.push(base.PYTHONPATH);
  const env: Record<string, string> = {
    ...base,
    PATH: [...prefix, base.PATH ?? ""].filter(Boolean).join(path.delimiter),
    PYTHONPATH: pythonPath.join(path.delimiter),
    PAGER: "cat",
    GIT_PAGER: "cat",
    MANPAGER: "cat",
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    EDITOR: "true",
    TERM: "dumb",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
    PYTHONUNBUFFERED: "1",
    // Never leave .pyc files in the user's repo, and never read a stale one.
    PYTHONDONTWRITEBYTECODE: "1",
    DEBIAN_FRONTEND: "noninteractive",
    ...extra,
  };
  if (venv) env.VIRTUAL_ENV = venv;
  return env;
}

/**
 * Shell prelude that re-applies the repo PATH prefix. Needed when a command
 * runs through a login shell, whose profile can reorder PATH.
 */
export function repoEnvPrelude(root: string): string {
  const prefix = repoPathPrefix(root);
  const quote = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const parts = [`export PYTHONDONTWRITEBYTECODE=1`];
  if (prefix.length) parts.push(`export PATH=${quote(prefix.join(path.delimiter))}:"$PATH"`);
  // The repo (and a src/ layout) importable from anywhere, e.g. a script in
  // .viberon/scratch/: without this, a real run lost 3 of 5 turns to an
  // import error before finding PYTHONPATH=. by itself.
  const importable = [root];
  if (existsSync(path.join(root, "src")) && !existsSync(path.join(root, "src", "__init__.py"))) {
    importable.unshift(path.join(root, "src"));
  }
  parts.push(`export PYTHONPATH=${quote(importable.join(path.delimiter))}\${PYTHONPATH:+:$PYTHONPATH}`);
  const venv = findRepoVenv(root);
  if (venv) parts.push(`export VIRTUAL_ENV=${quote(venv)}`);
  return `${parts.join("; ")}; `;
}

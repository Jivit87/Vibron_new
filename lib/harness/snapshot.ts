/**
 * Work-tree snapshots as git tree objects, without touching the user's
 * index, HEAD, branches or stash list (after Pramana `repo/git.py`).
 *
 * - `snapshot(root)` stages the work tree into a PRIVATE index
 *   (`GIT_INDEX_FILE` under `.viberon/`, seeded from the repo's own index so
 *   unchanged files are not re-hashed) and writes a tree. Untracked files
 *   are part of the snapshot, so the user's own work is never "a change".
 * - A folder that is not the top of a git checkout gets a shadow git dir at
 *   `.viberon/git`; nothing else changes.
 * - `.viberon/` and build/cache junk are always excluded.
 * - `withOriginal(root, baseRef, fn)` checks the base tree out into a
 *   temporary directory (ignored dependency dirs and build outputs are
 *   symlinked in, the scratch dir is copied) and runs `fn` there, so the
 *   original code can be exercised while the work tree keeps the patch.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const VIBERON_DIRNAME = ".viberon";
export const SCRATCH_DIR = `${VIBERON_DIRNAME}/scratch`;
const JUNK_DIRS = [
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".hypothesis",
  "node_modules",
];
const JUNK_FILES = ["*.pyc", ".DS_Store", ".coverage"];
/** `.viberon/` itself is kept out through info/exclude (an exclude pathspec naming an ignored dir is an error). */
const EXCLUDES = [
  ...JUNK_DIRS.map((d) => `:(exclude,glob)**/${d}/**`),
  ...JUNK_FILES.map((f) => `:(exclude,glob)**/${f}`),
];

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitError";
  }
}

export type ChangeStatus = "A" | "M" | "D";

export interface ChangedFile {
  status: ChangeStatus;
  path: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, env, maxBuffer: 256 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = !error ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
    child.stdin?.end(input);
  });
}

async function git(ctx: GitContext, args: string[], extra: Record<string, string> = {}, input?: string): Promise<string> {
  const res = await run(args, ctx.root, { ...ctx.env, ...extra }, input);
  if (res.code !== 0) throw new GitError(`git ${args.slice(0, 3).join(" ")} failed: ${res.stderr.slice(0, 800)}`);
  return res.stdout;
}

export function isJunkPath(p: string): boolean {
  const parts = p.split("/");
  return (
    parts[0] === VIBERON_DIRNAME ||
    parts.some((part) => JUNK_DIRS.includes(part)) ||
    /\.pyc$|(^|\/)\.DS_Store$|(^|\/)\.coverage$/.test(p)
  );
}

/* ------------------------------ context ---------------------------------- */

interface GitContext {
  root: string;
  env: NodeJS.ProcessEnv;
  /** Private index used for snapshots. */
  index: string;
  /** Tail of the queue of operations on the private index (see `exclusive`). */
  queue: Promise<unknown>;
}

const contexts = new Map<string, Promise<GitContext>>();

function context(rootPath: string): Promise<GitContext> {
  const root = path.resolve(rootPath);
  let ctx = contexts.get(root);
  // A deleted `.viberon/` took the private index (and any shadow git dir) with it.
  if (!ctx || !existsSync(path.join(root, VIBERON_DIRNAME))) {
    ctx = openContext(root);
    ctx.catch(() => contexts.delete(root));
    contexts.set(root, ctx);
  }
  return ctx;
}

async function openContext(root: string): Promise<GitContext> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const v of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[v];
  Object.assign(env, { GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" });

  const meta = path.join(root, VIBERON_DIRNAME);
  await mkdir(meta, { recursive: true });
  const index = path.join(meta, "snapshot.index");
  const top = await run(["rev-parse", "--show-toplevel"], root, env);
  const ownRepo = top.code === 0 && (await realpath(top.stdout.trim())) === (await realpath(root));

  if (!ownRepo) {
    env.GIT_DIR = path.join(meta, "git");
    env.GIT_WORK_TREE = root;
    if (!existsSync(env.GIT_DIR)) {
      const init = await run(["init", "-q"], root, env);
      if (init.code !== 0) throw new GitError(`git init failed: ${init.stderr.slice(0, 500)}`);
    }
  }
  const ctx: GitContext = { root, env, index, queue: Promise.resolve() };
  await ensureExclude(ctx, ownRepo);
  if (ownRepo && !existsSync(index)) {
    // Seed from the repo's own index: its stat cache spares re-hashing every file.
    const real = (await git(ctx, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
    if (existsSync(real)) await copyFile(real, index).catch(() => undefined);
  }
  return ctx;
}

/** Keep `.viberon/` out of `git status` and every diff (and junk out of shadow snapshots). */
async function ensureExclude(ctx: GitContext, ownRepo: boolean): Promise<void> {
  const res = await run(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], ctx.root, ctx.env);
  if (res.code !== 0) return;
  const file = res.stdout.trim();
  const wanted = [`/${VIBERON_DIRNAME}/`, ...(ownRepo ? [] : [...JUNK_DIRS.map((d) => `${d}/`), ...JUNK_FILES, ".venv/", "venv/"])];
  try {
    await mkdir(path.dirname(file), { recursive: true });
    const existing = existsSync(file) ? await readFile(file, "utf8") : "";
    const have = new Set(existing.split("\n").map((l) => l.trim()));
    const missing = wanted.filter((w) => !have.has(w));
    if (missing.length) {
      await writeFile(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
    }
  } catch {
    // Read-only git dir: the pathspec excludes still keep .viberon/ out.
  }
}

async function stage(ctx: GitContext): Promise<void> {
  await git(ctx, ["add", "-A", "--", ".", ...EXCLUDES], { GIT_INDEX_FILE: ctx.index });
}

/**
 * Run `fn` alone on the private index. The harness runs phases concurrently
 * (setup, the test writer beside the reviewer), and two `git add` calls on
 * one index file collide on its lock.
 */
function exclusive<T>(ctx: GitContext, fn: () => Promise<T>): Promise<T> {
  const next = ctx.queue.then(fn, fn);
  ctx.queue = next.catch(() => undefined);
  return next;
}

/* -------------------------------- API ------------------------------------ */

/** A tree object of the current work tree (untracked files included, junk and `.viberon/` excluded). */
export async function snapshot(root: string): Promise<string> {
  const ctx = await context(root);
  return exclusive(ctx, async () => {
    await stage(ctx);
    return (await git(ctx, ["write-tree"], { GIT_INDEX_FILE: ctx.index })).trim();
  });
}

/** Unified diff from `fromRef` to `toRef` (default: the current work tree). */
export async function diff(
  root: string,
  fromRef: string,
  options: { toRef?: string; context?: number; paths?: string[] } = {},
): Promise<string> {
  const ctx = await context(root);
  const flags = ["--binary", "--no-color", "--no-ext-diff", "--no-renames", `-U${Math.max(0, options.context ?? 3)}`];
  const tail = options.paths?.length ? ["--", ...options.paths] : [];
  if (options.toRef) return git(ctx, ["diff", ...flags, fromRef, options.toRef, ...tail]);
  return exclusive(ctx, async () => {
    await stage(ctx);
    return git(ctx, ["diff", "--cached", ...flags, fromRef, ...tail], { GIT_INDEX_FILE: ctx.index });
  });
}

/** Files that differ between `fromRef` and `toRef` (default: the work tree), with A/M/D status. */
export async function changedFiles(root: string, fromRef: string, toRef?: string): Promise<ChangedFile[]> {
  const ctx = await context(root);
  let out: string;
  if (toRef) out = await git(ctx, ["diff", "--name-status", "-z", "--no-renames", fromRef, toRef]);
  else {
    out = await exclusive(ctx, async () => {
      await stage(ctx);
      return git(ctx, ["diff", "--cached", "--name-status", "-z", "--no-renames", fromRef], { GIT_INDEX_FILE: ctx.index });
    });
  }
  const parts = out.split("\0").filter(Boolean);
  const result: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i][0];
    if (!isJunkPath(parts[i + 1])) result.push({ status: status === "A" || status === "D" ? status : "M", path: parts[i + 1] });
  }
  return result;
}

/** Make the work tree match snapshot `ref` (junk and `.viberon/` untouched). */
export async function restore(root: string, ref: string): Promise<void> {
  const ctx = await context(root);
  const current = await snapshot(root);
  if (current === ref) return;
  const patch = await git(ctx, ["diff", "--binary", "--no-renames", current, ref]);
  if (!patch.trim()) return;
  const res = await run(["apply", "--binary", "--whitespace=nowarn"], ctx.root, ctx.env, patch);
  if (res.code !== 0) throw new GitError(`git apply failed: ${res.stderr.slice(0, 800)}`);
}

/** Put one file back to its content in `ref` (deleting it if `ref` lacks it). */
export async function restoreFile(root: string, ref: string, file: string): Promise<void> {
  const ctx = await context(root);
  const abs = path.join(ctx.root, file);
  const exists = await run(["cat-file", "-e", `${ref}:${file}`], ctx.root, ctx.env);
  if (exists.code !== 0) {
    await unlink(abs).catch(() => undefined);
    return;
  }
  const blob = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      ["cat-file", "blob", `${ref}:${file}`],
      { cwd: ctx.root, env: ctx.env, encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      (error, stdout) => (error ? reject(new GitError(String(error))) : resolve(stdout)),
    );
  });
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, blob);
}

/** Every file in snapshot `ref`. */
export async function listFiles(root: string, ref: string): Promise<string[]> {
  const ctx = await context(root);
  const out = await git(ctx, ["ls-tree", "-r", "--name-only", "-z", ref]);
  return out.split("\0").filter(Boolean);
}

/**
 * Run `fn` in a temporary directory holding the code of snapshot `baseRef`.
 * Ignored entries of the work tree (installed dependencies, virtualenvs,
 * compiled extensions, egg-info) are symlinked in so the code can run; the
 * scratch dir is copied, so reproduction scripts resolve against the
 * original code. The directory is removed afterwards.
 */
export async function withOriginal<T>(root: string, baseRef: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const ctx = await context(root);
  const dir = await mkdtemp(path.join(os.tmpdir(), "viberon-original-"));
  const index = `${dir}.index`;
  try {
    await git(ctx, ["read-tree", baseRef], { GIT_INDEX_FILE: index });
    await git(ctx, ["checkout-index", "-a", "-f", `--prefix=${dir}/`], { GIT_INDEX_FILE: index });
    const ignored = await git(ctx, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
      GIT_INDEX_FILE: index,
    });
    for (const raw of ignored.split("\0").filter(Boolean)) {
      const rel = raw.replace(/\/$/, "");
      if (rel.split("/").some((p) => p === VIBERON_DIRNAME || p === ".git" || p === "__pycache__")) continue;
      const target = path.join(dir, rel);
      if (existsSync(target)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await symlink(path.join(ctx.root, rel), target).catch(() => undefined);
    }
    const scratch = path.join(ctx.root, SCRATCH_DIR);
    if (existsSync(scratch)) await cp(scratch, path.join(dir, SCRATCH_DIR), { recursive: true });
    return await fn(dir);
  } finally {
    await unlink(index).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Ensure the scratch directory exists (it is excluded from every diff). */
export async function ensureScratch(root: string): Promise<string> {
  const dir = path.join(root, SCRATCH_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function realpath(p: string): Promise<string> {
  const { realpath: rp } = await import("node:fs/promises");
  try {
    return await rp(p);
  } catch {
    return path.resolve(p);
  }
}

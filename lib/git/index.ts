/**
 * Server-side git operations for the Source Control view.
 *
 * Every call goes through `runGit`, which uses `execFile("git", args)` —
 * never a shell — so nothing the client sends is ever interpreted by one.
 * On top of that:
 *
 *  - Paths are validated with `resolveGitPaths`: relative, inside the
 *    workspace root, no option-looking prefixes, and always passed after
 *    `--` so git treats them as pathspecs only.
 *  - Branch names are validated against `check-ref-format` rules.
 *  - The repository must be rooted *exactly* at the workspace folder. A
 *    workspace that merely sits inside some other repo (e.g. the default
 *    scratch folder inside the app's own checkout) is treated as "not a
 *    repository", so a commit can never land in a repo the user did not open.
 */

import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  parseStatusV2,
  type GitBranch,
  type GitCommit,
  type GitStatus,
} from "@/lib/git/parse";
import { scrubEnv } from "@/lib/terminal/safety";

export class GitInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitInputError";
  }
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null,
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 32 * 1024 * 1024;

/** Sees every git process `runGit` starts (the counting harness in tests). */
export type GitExecObserver = (cwd: string, args: string[]) => void;
let execObserver: GitExecObserver | null = null;

/** Install (or clear, with null) the observer; returns the previous one. */
export function observeGitExec(observer: GitExecObserver | null): GitExecObserver | null {
  const previous = execObserver;
  execObserver = observer;
  return previous;
}

/**
 * Config reads (remote URLs) cached per repository: one issue fix → PR asks
 * for the same remote URLs in the checkout and again in its worktree. An
 * entry is only served while the config file's stamp is unchanged (edits
 * made outside the app included), a git call through `runGit` that can
 * change config drops it, and the TTL bounds anything else (global config).
 */
const READ_CACHE_TTL_MS = 30_000;
type RunResult = GitRunResult & { code: number | null };
const readCache = new Map<string, { at: number; stamp: string; value: Promise<RunResult> }>();
const CHANGES_CONFIG = new Set(["remote", "init", "clone", "submodule"]);

function changesConfig(args: string[]): boolean {
  const verb = args[0] ?? "";
  if (verb === "config") return !args.some((a) => a === "--get" || a === "--get-regexp" || a === "--list" || a === "-l");
  return CHANGES_CONFIG.has(verb);
}

function rootPrefix(cwd: string): string {
  return `${path.resolve(cwd)}\0`;
}

/** Forget cached reads for `cwd` (every root when omitted). */
export function invalidateGitReadCache(cwd?: string): void {
  if (!cwd) {
    readCache.clear();
    return;
  }
  const prefix = rootPrefix(configOwner(cwd));
  for (const key of readCache.keys()) if (key.startsWith(prefix)) readCache.delete(key);
}

/**
 * The repository whose config `root` reads: a linked worktree (`.git` is a
 * file naming `<main>/.git/worktrees/<id>`) shares its main checkout's
 * config, so an issue worktree reuses the checkout's cached remote URLs.
 * Read from the filesystem: no git process.
 */
function configOwner(root: string): string {
  try {
    const text = readFileSync(path.join(root, ".git"), "utf8");
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const common = gitdir && /^(.*[\\/]\.git)[\\/]worktrees[\\/][^\\/]+$/.exec(path.resolve(root, gitdir))?.[1];
    if (common) return path.dirname(realpathSync(common));
  } catch {
    // `.git` is a directory (EISDIR) or missing: the root owns its config.
  }
  try {
    return realpathSync(root);
  } catch {
    return path.resolve(root);
  }
}

/**
 * A stamp of the repository's config file (mtime + size), read with one
 * `stat`: any edit — ours or a terminal `git remote add` — changes it, so a
 * cached answer is never served across a config change.
 */
function configStamp(owner: string): string {
  try {
    const info = statSync(path.join(owner, ".git", "config"));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "none";
  }
}

/** `runGit` (allowFailure) for a config read whose answer is stable for a run. */
function runGitCached(cwd: string, args: string[]): Promise<RunResult> {
  const owner = configOwner(cwd);
  const key = `${rootPrefix(owner)}${args.join("\0")}`;
  const stamp = configStamp(owner);
  const hit = readCache.get(key);
  if (hit && hit.stamp === stamp && Date.now() - hit.at < READ_CACHE_TTL_MS) return hit.value;
  const value = runGit(cwd, args, { allowFailure: true });
  readCache.set(key, { at: Date.now(), stamp, value });
  value.catch(() => readCache.delete(key));
  return value;
}

/** Run git in `cwd` with a fixed argv. No shell is involved. */
export function runGit(
  cwd: string,
  args: string[],
  opts: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<RunResult> {
  execObserver?.(cwd, args);
  if (readCache.size && changesConfig(args)) invalidateGitReadCache(cwd);
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [
        "-c", "core.quotepath=false",
        "-c", "color.ui=false",
        // A workspace's own config must not turn a status poll into code
        // execution (fsmonitor hooks run on every `git status`).
        "-c", "core.fsmonitor=false",
        ...args,
      ],
      {
        cwd,
        shell: false,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: {
          // Hooks run on commit; they must not see the app's API keys.
          ...scrubEnv(process.env),
          // Never block on a credential prompt the user cannot see.
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GCM_INTERACTIVE: "never",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        const out = String(stdout);
        const err = String(stderr);
        if (error) {
          const code =
            typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : null;
          if ((error as { code?: unknown }).code === "ENOENT") {
            reject(new GitCommandError("git is not installed or not on PATH.", err, null));
            return;
          }
          if (opts.allowFailure) {
            resolve({ stdout: out, stderr: err, code });
            return;
          }
          const message = (err.trim() || out.trim() || error.message)
            .split("\n")
            .slice(0, 6)
            .join("\n");
          reject(new GitCommandError(message, err, code));
          return;
        }
        resolve({ stdout: out, stderr: err, code: 0 });
      },
    );
  });
}

/* ------------------------------ validation ------------------------------- */

/**
 * Normalize and validate client-supplied paths. Returns root-relative POSIX
 * paths that are safe to pass to git after `--`.
 */
export function resolveGitPaths(rootPath: string, input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new GitInputError("paths must be a non-empty array.");
  }
  if (input.length > 5000) throw new GitInputError("Too many paths.");
  const root = path.resolve(rootPath);
  return input.map((raw) => {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) {
      throw new GitInputError("Each path must be a non-empty string.");
    }
    if (raw.includes("\0")) throw new GitInputError("Path contains a NUL byte.");
    if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
      throw new GitInputError("Paths must be relative to the workspace.");
    }
    if (raw.startsWith("-")) {
      throw new GitInputError("Paths may not begin with '-'.");
    }
    // Git pathspec magic (":(glob)…", ":!foo") would widen what a path hits.
    if (raw.startsWith(":")) {
      throw new GitInputError("Pathspec magic is not allowed.");
    }
    const resolved = path.resolve(root, raw);
    if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
      throw new GitInputError(`Path escapes the workspace: ${raw}`);
    }
    const relative = path.relative(root, resolved).split(path.sep).join("/");
    if (relative === ".git" || relative.startsWith(".git/")) {
      throw new GitInputError("The .git directory cannot be targeted.");
    }
    return relative;
  });
}

/* ------------------------------ repository ------------------------------- */

export interface RepoState {
  isRepo: boolean;
  /** Set when the folder sits inside a repository rooted elsewhere. */
  parentRepo: string | null;
  gitAvailable: boolean;
}

export async function repoState(rootPath: string): Promise<RepoState> {
  let result: Awaited<ReturnType<typeof runGit>>;
  try {
    result = await runGit(rootPath, ["rev-parse", "--show-toplevel"], {
      allowFailure: true,
    });
  } catch {
    return { isRepo: false, parentRepo: null, gitAvailable: false };
  }
  if (result.code !== 0) {
    return { isRepo: false, parentRepo: null, gitAvailable: true };
  }
  const top = result.stdout.trim();
  const [realTop, realRoot] = await Promise.all([
    realpath(top).catch(() => path.resolve(top)),
    realpath(rootPath).catch(() => path.resolve(rootPath)),
  ]);
  if (realTop === realRoot) {
    return { isRepo: true, parentRepo: null, gitAvailable: true };
  }
  return { isRepo: false, parentRepo: realTop, gitAvailable: true };
}

export async function getStatus(rootPath: string): Promise<GitStatus> {
  const { stdout } = await runGit(rootPath, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
    "--untracked-files=all",
  ]);
  return parseStatusV2(stdout);
}

export interface RepoSnapshot {
  /** false outside a work tree (or when git is unavailable). */
  isRepo: boolean;
  /** Full HEAD commit, or null before the first commit. */
  head: string | null;
  /** Current branch, or null when detached. */
  branch: string | null;
  /** Staged, unstaged and untracked paths; both sides of a rename. */
  changed: string[];
}

/**
 * Everything a delivery checks before it acts, from ONE git process
 * (`status --porcelain=v2 --branch`) instead of `rev-parse --show-toplevel`,
 * `rev-parse --verify HEAD`, `status` and `branch --show-current`.
 */
export async function repoSnapshot(rootPath: string): Promise<RepoSnapshot> {
  const r = await runGit(rootPath, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
    allowFailure: true,
  }).catch(() => null);
  if (!r || r.code !== 0) return { isRepo: false, head: null, branch: null, changed: [] };
  return parseSnapshot(r.stdout);
}

/** Parse `status --porcelain=v2 --branch -z` into a `RepoSnapshot`. */
export function parseSnapshot(stdout: string): RepoSnapshot {
  const snapshot: RepoSnapshot = { isRepo: true, head: null, branch: null, changed: [] };
  const changed = new Set<string>();
  const records = stdout.split("\0");
  const after = (record: string, fields: number) => record.split(" ").slice(fields).join(" ");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.startsWith("# branch.oid ")) {
      const oid = record.slice("# branch.oid ".length);
      snapshot.head = oid === "(initial)" ? null : oid;
    } else if (record.startsWith("# branch.head ")) {
      const head = record.slice("# branch.head ".length);
      snapshot.branch = head === "(detached)" ? null : head;
    } else if (record.startsWith("1 ")) {
      changed.add(after(record, 8));
    } else if (record.startsWith("2 ")) {
      changed.add(after(record, 9));
      const orig = records[++i];
      if (orig) changed.add(orig);
    } else if (record.startsWith("u ")) {
      changed.add(after(record, 10));
    } else if (record.startsWith("? ")) {
      changed.add(record.slice(2));
    }
  }
  snapshot.changed = [...changed].filter(Boolean);
  return snapshot;
}

export async function hasHead(rootPath: string): Promise<boolean> {
  const { code } = await runGit(rootPath, ["rev-parse", "--verify", "-q", "HEAD"], {
    allowFailure: true,
  });
  return code === 0;
}

export async function getLog(rootPath: string, limit = 30): Promise<GitCommit[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  // One process: before the first commit `git log` fails, which means "no
  // history" (no separate `rev-parse --verify HEAD` first).
  const { stdout, code } = await runGit(rootPath, ["log", `-n${n}`, `--pretty=format:${LOG_FORMAT}`], {
    allowFailure: true,
  });
  return code === 0 ? parseLog(stdout) : [];
}

export async function getBranches(rootPath: string): Promise<GitBranch[]> {
  const { stdout } = await runGit(rootPath, [
    "for-each-ref",
    `--format=${BRANCH_FORMAT}`,
    "refs/heads",
  ]);
  return parseBranches(stdout);
}

/**
 * Content of a file at a revision. `ref` is "HEAD" or "INDEX" only — the
 * client never gets to name arbitrary objects. Returns null when the file
 * does not exist at that revision (a newly added file).
 */
export async function showFile(
  rootPath: string,
  filePath: string,
  ref: "HEAD" | "INDEX",
): Promise<string | null> {
  const [rel] = resolveGitPaths(rootPath, [filePath]);
  const spec = ref === "HEAD" ? `HEAD:${rel}` : `:${rel}`;
  const { stdout, code } = await runGit(rootPath, ["show", spec], {
    allowFailure: true,
  });
  return code === 0 ? stdout : null;
}

export async function stagedDiff(rootPath: string, maxChars = 24_000): Promise<string> {
  const { stdout } = await runGit(rootPath, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--stat",
    "--patch",
    "-U2",
  ]);
  if (stdout.length <= maxChars) return stdout;
  return `${stdout.slice(0, maxChars)}\n… [diff truncated, ${stdout.length - maxChars} more chars]`;
}

/* ------------------------------- mutations ------------------------------- */

export async function stage(rootPath: string, paths: string[] | "all"): Promise<void> {
  if (paths === "all") {
    await runGit(rootPath, ["add", "-A"]);
    return;
  }
  await runGit(rootPath, ["add", "-A", "--", ...paths]);
}

export async function unstage(rootPath: string, paths: string[] | "all"): Promise<void> {
  const targets = paths === "all" ? ["."] : paths;
  if (await hasHead(rootPath)) {
    await runGit(rootPath, ["restore", "--staged", "--", ...targets]);
  } else {
    // Before the first commit there is no HEAD to restore from.
    await runGit(rootPath, ["rm", "--cached", "-r", "-q", "--", ...targets]);
  }
}

/**
 * Throw away working-tree changes. Tracked files are restored from the
 * index; untracked files are removed with `git clean` (never directories
 * outside the given paths, never ignored files).
 */
export async function discard(
  rootPath: string,
  paths: string[] | "all",
  status?: GitStatus,
): Promise<void> {
  const current = status ?? (await getStatus(rootPath));
  const untracked = new Set(
    current.files.filter((f) => f.group === "untracked").map((f) => f.path),
  );
  const tracked = new Set(
    current.files.filter((f) => f.group === "changes").map((f) => f.path),
  );

  const targets = paths === "all" ? [...untracked, ...tracked] : paths;
  const toClean = targets.filter((p) => untracked.has(p));
  const toRestore = targets.filter((p) => tracked.has(p));

  if (toRestore.length > 0) {
    await runGit(rootPath, ["restore", "--worktree", "--", ...toRestore]);
  }
  if (toClean.length > 0) {
    await runGit(rootPath, ["clean", "-f", "-q", "--", ...toClean]);
  }
}

export async function commit(rootPath: string, message: string): Promise<string> {
  const trimmed = message.replace(/\s+$/, "");
  if (!trimmed.trim()) throw new GitInputError("Commit message is empty.");
  if (trimmed.length > 20_000) throw new GitInputError("Commit message is too long.");
  if (trimmed.includes("\0")) throw new GitInputError("Commit message contains a NUL byte.");
  // `-F -` reads the message from stdin would need a pipe; `-m` with argv is
  // equally safe because there is no shell to interpret it.
  const { stdout } = await runGit(rootPath, ["commit", "-q", "-m", trimmed]);
  return stdout;
}

export async function switchBranch(
  rootPath: string,
  name: string,
  create: boolean,
): Promise<void> {
  await runGit(rootPath, create ? ["switch", "-c", name] : ["switch", name]);
}

export async function init(rootPath: string): Promise<void> {
  await runGit(rootPath, ["init", "-q"]);
}

export async function fetchRemote(rootPath: string): Promise<string> {
  const r = await runGit(rootPath, ["fetch", "--prune"], { timeoutMs: 120_000 });
  return r.stderr || r.stdout;
}

export async function pull(rootPath: string): Promise<string> {
  const r = await runGit(rootPath, ["pull", "--ff-only"], { timeoutMs: 120_000 });
  return r.stdout || r.stderr;
}

export async function push(rootPath: string, upstream: string | null): Promise<string> {
  const args = upstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
  const r = await runGit(rootPath, args, { timeoutMs: 120_000 });
  return r.stderr || r.stdout;
}

/**
 * The remote that holds the real project: `upstream` when it exists (origin
 * is then usually the user's fork), else `origin`. Issues are read from it,
 * fixes start from its default branch, and pull requests target it.
 */
export async function projectRemote(root: string): Promise<"upstream" | "origin"> {
  return (await configuredRemoteUrl(root, "upstream")) ? "upstream" : "origin";
}

/**
 * A remote's configured URL, or null. Not `git remote get-url`, which expands
 * url.*.insteadOf: the configured URL names the hosting repository, and git
 * applies any rewrite itself when it connects. The only remote-URL helper.
 *
 * One `git config --get-regexp` answers every remote of a root at once and is
 * cached briefly (see `runGitCached`), so asking for `upstream` then `origin`
 * in one run costs a single git process.
 */
export async function configuredRemoteUrl(root: string, remote = "origin"): Promise<string | null> {
  if (!/^[\w.-]+$/.test(remote)) return null;
  const r = await runGitCached(root, ["config", "--get-regexp", "^remote\\..*\\.url$"]);
  if (r.code !== 0) return null;
  const want = `remote.${remote}.url`;
  let url: string | null = null;
  for (const line of r.stdout.split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0 && line.slice(0, space) === want) url = line.slice(space + 1).trim() || null;
  }
  return url;
}

/**
 * Fetch one branch of `remote` into its remote-tracking ref. The `+` forces
 * the update, so an upstream force-push (a rewritten default branch) still
 * fetches; `--no-tags` keeps a tag clash from failing it.
 */
export function branchFetchArgs(remote: string, branch: string): string[] {
  return ["fetch", "--quiet", "--no-tags", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
}

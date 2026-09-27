/**
 * Clone-to-fix: turn a repo URL, `owner/repo`, or GitHub issue URL into a
 * local, indexed disk workspace.
 *
 * Safety: git runs through `spawn` with an argument vector (never a shell),
 * the URL is validated against an allowlist of forms, arguments can never
 * start with `-`, and prompts are disabled so a private repo fails fast
 * instead of hanging on a credential prompt.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { fetchGitHubIssue, parseGitHubIssueUrl, type GitHubIssue } from "@/lib/github";
import { lastIndexStats, registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { listRepoPaths } from "@/lib/verify";
import { bootstrapEnvironment, probeRepo, type RepoProbe } from "@/lib/workspace/bootstrap";

export interface CloneTarget {
  /** What `git clone` receives. */
  cloneUrl: string;
  owner: string;
  name: string;
  /** Set when the input was a GitHub issue/PR URL. */
  issueUrl?: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

function cleanName(name: string): string {
  return name.replace(/\.git$/, "");
}

function validSegments(owner: string, name: string): boolean {
  return (
    SEGMENT.test(owner) &&
    SEGMENT.test(name) &&
    !owner.startsWith("-") &&
    !name.startsWith("-") &&
    ![".", ".."].includes(owner) &&
    ![".", ".."].includes(name)
  );
}

/**
 * Accepts `https://host/owner/name(.git)`, `git@host:owner/name.git`,
 * `ssh://git@host/owner/name`, `owner/name`, and GitHub issue/PR URLs.
 * `file://` and absolute local paths only when `allowLocal` (tests, eval).
 */
export function parseCloneTarget(input: string, options: { allowLocal?: boolean } = {}): CloneTarget | null {
  const value = input.trim();
  if (!value || value.startsWith("-") || /[\s\0;&|`$<>\\]/.test(value)) return null;

  const issue = parseGitHubIssueUrl(value);
  if (issue) {
    return {
      cloneUrl: `https://github.com/${issue.owner}/${issue.repo}.git`,
      owner: issue.owner,
      name: issue.repo,
      issueUrl: value,
    };
  }

  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  if (short && !value.startsWith(".")) {
    const [, owner, name] = short;
    if (!validSegments(owner!, cleanName(name!))) return null;
    return { cloneUrl: `https://github.com/${owner}/${cleanName(name!)}.git`, owner: owner!, name: cleanName(name!) };
  }

  const scp = /^([A-Za-z0-9_.-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(value);
  if (scp) {
    const [, , , owner, name] = scp;
    if (!validSegments(owner!, name!)) return null;
    return { cloneUrl: value, owner: owner!, name: name! };
  }

  if (options.allowLocal && (value.startsWith("file://") || path.isAbsolute(value))) {
    const local = value.startsWith("file://") ? value.slice("file://".length) : value;
    const name = cleanName(path.basename(local.replace(/\/+$/, "")));
    if (!SEGMENT.test(name)) return null;
    return { cloneUrl: local, owner: "local", name };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["https:", "ssh:", "http:"].includes(url.protocol) || url.username && url.protocol !== "ssh:") return null;
  if (url.password) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  // github.com/owner/name/tree/branch → owner/name
  const owner = segments[0]!;
  const name = cleanName(segments[1]!);
  if (!validSegments(owner, name)) return null;
  const cloneUrl =
    url.protocol === "ssh:"
      ? value
      : `${url.protocol}//${url.host}/${owner}/${name}${url.hostname === "github.com" ? ".git" : ""}`;
  return { cloneUrl, owner, name };
}

/**
 * The GitHub token for clones and issues: the stored integration token
 * (Settings → Integrations), then `GITHUB_TOKEN`/`GH_TOKEN`, else null.
 */
export async function resolveGithubToken(): Promise<string | null> {
  try {
    const [{ readGithubEntry }, { getGlobalEntries }] = await Promise.all([
      import("@/lib/mcp/github"),
      import("@/lib/mcp/settings"),
    ]);
    const token = readGithubEntry((await getGlobalEntries()).github)?.token?.trim();
    if (token) return token;
  } catch {
    // No settings store (bare headless run): fall through to the environment.
  }
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || ghCliToken();
}

let ghToken: string | null | undefined;

/** The GitHub CLI's login (`gh auth token`), read once: a local fallback when nothing else is set. */
function ghCliToken(): string | null {
  if (ghToken !== undefined) return ghToken;
  if (process.env.VITEST) return (ghToken = null); // Tests never use the real login.
  try {
    const out = execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    ghToken = /^[\w-]{20,}$/.test(out.trim()) ? out.trim() : null;
  } catch {
    ghToken = null;
  }
  return ghToken;
}

/**
 * Auth for git over https to one host, through `GIT_CONFIG_*` env entries
 * (git ≥ 2.31): never in the URL or argv, so nothing logged can contain it.
 */
export function gitAuthEnv(token: string | null | undefined, cloneUrl: string): Record<string, string> {
  // Only ever sent to github.com: the token must not leak to another host.
  const host = /^https:\/\/(github\.com)\//i.exec(cloneUrl)?.[1];
  if (!token || !host) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.https://${host}/.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

export function reposDir(): string {
  return process.env.VIBERON_REPOS_DIR || path.join(os.homedir(), "Viberon", "repos");
}

export function cloneDestination(target: CloneTarget, base = reposDir()): string {
  return path.join(base, `${target.owner}__${target.name}`);
}

/** Run git with an argv (no shell). Streams stderr/stdout lines to `onLine`. */
export function runGit(
  args: string[],
  options: { cwd?: string; signal?: AbortSignal; onLine?: (line: string) => void; timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "echo",
        SSH_ASKPASS: "echo",
        GCM_INTERACTIVE: "never",
        GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let partial = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output = (output + text).slice(-64 * 1024);
      partial += text;
      const parts = partial.split(/[\r\n]+/);
      partial = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) options.onLine?.(line.trim());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 15 * 60_000);
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (partial.trim()) options.onLine?.(partial.trim());
      resolve({ code, output });
    };
    child.on("error", (error) => {
      output += `\n${error.message}`;
      done(null);
    });
    child.on("close", done);
  });
}

/** A reused clone fetched this recently skips the network round-trip. */
export const FETCH_TTL_MS = 60_000;

function fetchedRecently(dest: string, ttlMs: number): boolean {
  try {
    return Date.now() - statSync(path.join(dest, ".git", "FETCH_HEAD")).mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

export interface CloneResult {
  rootPath: string;
  reused: boolean;
}

/**
 * Clone into `<reposDir>/<owner>__<name>`, or reuse + fetch an existing
 * clone. `ref` checks out a branch/tag/commit after clone or fetch.
 *
 * Fast by default: without an explicit `depth` or `ref` the clone is shallow
 * (`--depth 1 --single-branch`); `depth: 0` asks for full history. A shallow
 * reused clone fetches shallowly (just the ref when one is given), and a
 * clone fetched within `fetchTtlMs` skips the fetch altogether.
 */
export async function cloneRepository(
  target: CloneTarget,
  options: {
    ref?: string;
    depth?: number;
    baseDir?: string;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    /** GitHub token for https clones (see `gitAuthEnv`). */
    token?: string | null;
    /** Skip the fetch of a reused clone fetched this recently (default FETCH_TTL_MS; 0 = always fetch). */
    fetchTtlMs?: number;
  } = {},
): Promise<CloneResult> {
  const dest = cloneDestination(target, options.baseDir);
  const progress = options.onProgress ?? (() => {});
  if (options.ref && (!/^[\w./-]+$/.test(options.ref) || options.ref.startsWith("-"))) {
    throw new Error(`Invalid ref: ${options.ref}`);
  }
  const depth =
    options.depth === undefined
      ? options.ref
        ? undefined
        : 1
      : Number.isInteger(options.depth) && options.depth > 0
        ? options.depth
        : undefined;
  const auth = gitAuthEnv(options.token, target.cloneUrl);

  let reused = false;
  if (existsSync(path.join(dest, ".git"))) {
    reused = true;
    const shallow = existsSync(path.join(dest, ".git", "shallow"));
    if (!options.ref && fetchedRecently(dest, options.fetchTtlMs ?? FETCH_TTL_MS)) {
      progress(`Reusing existing clone at ${dest} (fetched recently)`);
    } else {
      progress(`Reusing existing clone at ${dest}; fetching…`);
      // Measured: `fetch --depth 1` on an up-to-date shallow clone renegotiates
      // (~1.3 s vs ~0.8 s), so only a named ref on a shallow clone uses it.
      const args =
        shallow && options.ref ? ["fetch", "--depth", "1", "origin", options.ref] : ["fetch", "--prune", "origin"];
      const fetch = await runGit(args, { cwd: dest, signal: options.signal, onLine: progress, env: auth });
      if (fetch.code !== 0) progress("git fetch failed; continuing with the local copy");
    }
  } else {
    await mkdir(path.dirname(dest), { recursive: true });
    progress(`Cloning ${target.cloneUrl} into ${dest}…`);
    const args = ["clone", "--progress"];
    if (depth) args.push("--depth", String(depth), "--single-branch");
    if (options.ref && depth) args.push("--branch", options.ref);
    args.push("--", target.cloneUrl, dest);
    const clone = await runGit(args, { signal: options.signal, onLine: progress, env: auth });
    if (clone.code !== 0) {
      const reason = clone.output.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      throw new Error(`git clone failed: ${reason || `exit ${clone.code}`}`);
    }
  }

  if (options.ref && !(depth && !reused)) {
    let checkout = await runGit(["checkout", "--detach", options.ref], { cwd: dest, onLine: progress });
    if (checkout.code !== 0) {
      checkout = await runGit(["checkout", "--detach", `origin/${options.ref}`], { cwd: dest, onLine: progress });
    }
    if (checkout.code !== 0 && reused) {
      // A shallow clone fetched the ref by name only: it lives in FETCH_HEAD.
      checkout = await runGit(["checkout", "--detach", "FETCH_HEAD"], { cwd: dest, onLine: progress });
    }
    if (checkout.code !== 0) throw new Error(`Could not check out ${options.ref}`);
  }
  return { rootPath: dest, reused };
}

export interface ClonedWorkspace {
  repoKey: string;
  rootPath: string;
  label: string;
  reused: boolean;
  issue?: GitHubIssue;
  setupNotes?: string[];
  /** Language + test command, detected in one pass over the file list. */
  probe?: RepoProbe;
}

/**
 * The whole clone-to-fix intake: parse → clone/fetch → register the disk
 * workspace (indexes the graph, excludes `.viberon/`) → fetch the issue when
 * the input was an issue URL → optional environment bootstrap.
 */
export async function cloneToWorkspace(
  input: string,
  options: {
    ref?: string;
    depth?: number;
    setup?: boolean;
    allowLocal?: boolean;
    baseDir?: string;
    signal?: AbortSignal;
    onProgress?: (text: string) => void;
    fetchIssue?: (url: string) => Promise<GitHubIssue>;
    /** Undefined: resolve (stored integration, then env); null: anonymous. */
    token?: string | null;
  } = {},
): Promise<ClonedWorkspace> {
  const target = parseCloneTarget(input, { allowLocal: options.allowLocal });
  if (!target) throw new Error("Unsupported repository URL. Use https, ssh, owner/repo, or a GitHub issue URL.");
  const progress = options.onProgress ?? (() => {});
  const token = options.token === undefined ? await resolveGithubToken() : options.token;
  const { rootPath, reused } = await cloneRepository(target, { ...options, token, onProgress: progress });

  // Indexing and dependency setup are independent: run them concurrently.
  let setupPromise: Promise<string[]> | undefined;
  if (options.setup) {
    progress("Setting up the environment…");
    setupPromise = bootstrapEnvironment(rootPath, { onProgress: progress, signal: options.signal }).catch(
      (error: unknown) => [`setup failed: ${error instanceof Error ? error.message : String(error)}`],
    );
  }
  progress("Indexing code graph…");
  const label = `${target.owner}/${target.name}`;
  const meta = await registerLocalWorkspace(rootPath, { label });
  const stats = lastIndexStats.get(meta.repoKey);
  if (stats) progress(`Indexed: ${stats.parsed} parsed, ${stats.reused} reused from cache`);

  let issue: GitHubIssue | undefined;
  if (target.issueUrl) {
    progress("Fetching issue…");
    try {
      issue = await (options.fetchIssue ?? ((url: string) => fetchGitHubIssue(url, fetch, token)))(target.issueUrl);
    } catch (error) {
      progress(`Could not fetch the issue: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const setupNotes = setupPromise ? await setupPromise : undefined;
  const probe = probeRepo(rootPath, listRepoPaths(rootPath));
  return { repoKey: meta.repoKey, rootPath, label, reused, issue, setupNotes, probe };
}

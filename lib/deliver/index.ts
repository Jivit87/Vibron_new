/**
 * Deliver a verified change: validate → branch → commit → push → open or
 * update a (draft) PR. Ported from Open SWE's deliver loop and Jiffy's branch
 * naming; see docs/PLAN-DELIVER.md.
 *
 * Safety:
 *  - The working tree must contain only the files the solve changed
 *    (`expectedFiles`), and never `.github/workflows/**` unless the user
 *    re-confirmed (`allowWorkflowChanges`), Open SWE's human-approval rule.
 *  - Every check runs before anything is mutated.
 *  - git runs with an argv (no shell). The token reaches git only through
 *    `gitAuthEnv` (env config, github.com only), never a URL or argv, and is
 *    redacted from any git output we report.
 *  - A failed push leaves the local branch and commit in place and says why.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DeliverError } from "@/lib/deliver/errors";
import { branchFetchArgs, configuredRemoteUrl, projectRemote, runGit } from "@/lib/git";
import {
  canPush,
  createPullRequest,
  ensureFork,
  findOpenPullRequest,
  getDefaultBranch,
  GitHubApiError,
  isPullRequestMerged,
  parsePrUrl,
  parseRemote,
  redactSecret,
  updatePullRequest,
  type ApiOptions,
  type RepoId,
} from "@/lib/github-api";
import { scrubEnv } from "@/lib/terminal/safety";
import { gitAuthEnv, resolveGithubToken } from "@/lib/workspace/clone";

export * from "@/lib/deliver/ci";
export * from "@/lib/deliver/report";
export { DeliverError } from "@/lib/deliver/errors";

export const BRANCH_PREFIX = "viberon/";
export const MAX_BRANCH_LENGTH = 48;
const WORKFLOW_PATH = /^\.github\/workflows\//;

/** `viberon/<slug>` from a title, ≤ 48 chars, not in `existing` (suffix -2, -3, …). */
export function branchName(title: string, existing: Iterable<string> = []): string {
  const taken = new Set(existing);
  const room = MAX_BRANCH_LENGTH - BRANCH_PREFIX.length;
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, room)
      .replace(/-+$/, "") || "change";
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "" : `-${n}`;
    const candidate = `${BRANCH_PREFIX}${slug.slice(0, room - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * `viberon/issue-<N>-<slug>`: the one branch an issue's fixes live on, so a
 * rerun of the same issue replaces its branch and updates its PR instead of
 * opening a second one. At most 48 chars.
 */
export function issueBranchName(number: number, title: string): string {
  const prefix = `${BRANCH_PREFIX}issue-${number}-`;
  const slug =
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, Math.max(1, MAX_BRANCH_LENGTH - prefix.length))
      .replace(/-+$/, "") || "fix";
  return `${prefix}${slug}`;
}

/**
 * The branch an earlier run used for issue `number` (local, or known from a
 * remote), so a retitled issue keeps its branch and PR. Null when none.
 */
export async function existingIssueBranch(root: string, number: number): Promise<string | null> {
  const prefix = `${BRANCH_PREFIX}issue-${number}-`;
  const refs = await runGit(
    root,
    ["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `refs/heads/${prefix}*`, `refs/remotes/*/${prefix}*`],
    { allowFailure: true },
  );
  for (const ref of refs.stdout.split("\n")) {
    const at = ref.indexOf(prefix);
    if (at >= 0) return ref.slice(at).trim();
  }
  return null;
}

/**
 * A `viberon/issue-<N>-<slug>` variant not already used locally or on a
 * remote (suffix `-2`, `-3`, …): for a refix that must not reuse the branch a
 * merged PR used (force-pushing over it would rewrite history GitHub already
 * merged).
 */
export async function freshIssueBranchName(root: string, number: number, title: string): Promise<string> {
  const prefix = `${BRANCH_PREFIX}issue-${number}-`;
  const refs = await runGit(root, ["for-each-ref", "--format=%(refname)", `refs/heads/${prefix}*`, `refs/remotes/*/${prefix}*`], {
    allowFailure: true,
  });
  const taken = new Set(
    refs.stdout
      .split("\n")
      .map((ref) => {
        const at = ref.indexOf(prefix);
        return at >= 0 ? ref.slice(at).trim() : "";
      })
      .filter(Boolean),
  );
  const base = issueBranchName(number, title);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_BRANCH_LENGTH - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Where a refix of issue `number` should land: the existing stable branch,
 * force-pushed to update its (still open) PR — unless the previous PR is
 * known and GitHub says it was merged, in which case a fresh branch (never
 * force-pushed) so a new PR is opened instead of rewriting merged history.
 * `previousPrUrl` is the issue's last known PR (from the task being
 * re-fixed); undefined for a first run, which always gets the stable branch.
 */
export async function refixTarget(
  root: string,
  number: number,
  title: string,
  previousPrUrl: string | undefined,
  opts: { token?: string | null; fetchImpl?: typeof fetch } = {},
): Promise<{ branch: string; replaceBranch: boolean; mergedPrUrl?: string }> {
  const existing = await existingIssueBranch(root, number);
  const prRef = previousPrUrl ? parsePrUrl(previousPrUrl) : null;
  if (existing && prRef) {
    const token = opts.token === undefined ? await resolveGithubToken() : opts.token;
    const merged = await isPullRequestMerged(prRef, { token, fetchImpl: opts.fetchImpl });
    if (merged) return { branch: await freshIssueBranchName(root, number, title), replaceBranch: false, mergedPrUrl: previousPrUrl };
  }
  return { branch: existing ?? issueBranchName(number, title), replaceBranch: true };
}

/** Paths git reports as changed (staged, unstaged or untracked); both sides of a rename. */
export async function changedPaths(root: string): Promise<string[]> {
  const { stdout } = await runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = stdout.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) paths.push(parts[++i] ?? "");
  }
  return [...new Set(paths.filter(Boolean))];
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

const redact = redactSecret;

/**
 * A failed push's git output in plain language: why it failed and what to
 * do, for the cases people hit (the remote moved, the token was refused, the
 * branch is protected); otherwise git's own last lines.
 */
export function explainPushFailure(output: string): { reason: "non_fast_forward" | "auth" | "protected" | "other"; message: string } {
  if (/protected branch|GH006|push declined due to repository rule|GH013/i.test(output)) {
    return {
      reason: "protected",
      message: "the branch is protected on GitHub and does not accept direct pushes; deliver to a new branch and open a pull request instead",
    };
  }
  if (/non-fast-forward|\(fetch first\)|Updates were rejected because the (?:remote contains|tip of)/i.test(output)) {
    return {
      reason: "non_fast_forward",
      message: "the remote branch has new commits that are not in your local branch; pull or rebase onto it, then deliver again",
    };
  }
  if (/Authentication failed|could not read Username|Invalid username or password|Permission to \S+ denied|returned error: 40[13]|Write access to repository not granted|terminal prompts disabled/i.test(output)) {
    return {
      reason: "auth",
      message: "GitHub rejected the token (it may be expired, revoked, or lack write access to this repository); reconnect GitHub in Settings → Integrations",
    };
  }
  return { reason: "other", message: output.split("\n").slice(-4).join(" ").slice(0, 500) };
}

/** git with the token in env config only; the rest of the environment is scrubbed. */
function gitWithAuth(
  root: string,
  args: string[],
  auth: Record<string, string>,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd: root,
        shell: false,
        timeout: 120_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...scrubEnv(process.env),
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "",
          SSH_ASKPASS: "",
          GCM_INTERACTIVE: "never",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
          LC_ALL: "C",
          ...auth,
        },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code, output: `${stderr}${stdout}`.trim() || (error?.message ?? "") });
      },
    );
  });
}

async function remoteUrl(root: string, remote: string): Promise<string> {
  if (!/^[\w.-]+$/.test(remote)) return remote; // already a URL or path
  const url = await configuredRemoteUrl(root, remote);
  if (!url) throw new DeliverError(`No git remote named "${remote}" in this repository.`, "no_remote", 400);
  return url;
}

/** Local branches plus the remote's heads (ls-remote, else remote-tracking refs). */
async function existingBranches(root: string, remote: string, auth: Record<string, string>): Promise<string[]> {
  const local = await runGit(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  const names = local.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const heads = await gitWithAuth(root, ["ls-remote", "--heads", remote], auth);
  if (heads.code === 0) {
    for (const line of heads.output.split("\n")) {
      const ref = line.split("\t")[1]?.trim();
      if (ref?.startsWith("refs/heads/")) names.push(ref.slice("refs/heads/".length));
    }
  } else if (/^[\w.-]+$/.test(remote)) {
    const tracking = await runGit(root, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`]);
    names.push(...tracking.stdout.split("\n").map((s) => s.trim().slice(remote.length + 1)).filter(Boolean));
  }
  return names;
}

export interface DeliverOptions {
  root: string;
  title: string;
  body: string;
  draft?: boolean;
  baseBranch?: string;
  /** The solve's `filesChanged`; any other change in the tree refuses delivery. */
  expectedFiles?: string[];
  /** The user re-confirmed a change to `.github/workflows/**`. */
  allowWorkflowChanges?: boolean;
  /** Branch to use (validated); default: the current `viberon/*` branch, else `branchName(title)`. */
  branch?: string;
  /**
   * `branch` is Viberon's own (an issue's stable branch): an existing local
   * copy is reset to the new commit and the push replaces the remote branch
   * with `--force-with-lease`, so a rerun updates the same PR. The lease
   * refuses the push if someone else pushed to the branch meanwhile.
   */
  replaceBranch?: boolean;
  /** Remote name or URL to push to. Default "origin". */
  remote?: string;
  /** The GitHub repo for the PR; default: parsed from the remote URL. */
  repo?: RepoId;
  /**
   * "auto" (default): when the token cannot push to the repo, push to the
   * token user's fork (created if needed) and open the PR from there.
   */
  fork?: "auto" | "never";
  token?: string | null;
  fetchImpl?: typeof fetch;
  /**
   * When the remote is not on GitHub (GitLab, a local bare repo, …): still
   * branch, commit and push, and return without a pull request instead of
   * refusing with `not_github`.
   */
  pushOnly?: boolean;
}

export interface DeliverResult {
  branch: string;
  commit: string;
  prUrl: string;
  prNumber: number;
  /** false when an open PR for the branch was updated instead. */
  created: boolean;
  /** `owner/name` of the fork the branch was pushed to, when not the repo itself. */
  fork?: string;
  /** `pushOnly` to a non-GitHub remote: the branch was pushed, no PR exists (`prUrl` is ""). */
  pushedOnly?: boolean;
}

export interface DeliveryTarget {
  /** The GitHub repository the pull request is opened against. */
  repo: RepoId;
  /** `origin` already points at a different repo than `upstream`: it is the fork to push to. */
  originIsFork: boolean;
}

/**
 * Which repo a pull request targets, and whether `origin` is already a fork
 * of it. Pure and synchronous so the fork/upstream decision — the thing that
 * silently opened a PR against the fork instead of the original repo — can
 * be tested directly, without a real push or GitHub API calls.
 *
 * `origin` is the push target (its parsed identity is `pushRepo`); `upstream`,
 * when configured, is treated as the project itself, so a repo already set
 * up as `origin` = fork / `upstream` = original delivers correctly with no
 * extra GitHub API round trip to detect the fork.
 */
export function deliveryTarget(pushRepo: RepoId | null, upstreamRepo: RepoId | null, explicitRepo?: RepoId): DeliveryTarget | null {
  const repo = explicitRepo ?? upstreamRepo ?? pushRepo;
  if (!repo) return null;
  const originIsFork = Boolean(
    upstreamRepo && pushRepo && `${pushRepo.owner}/${pushRepo.repo}` !== `${upstreamRepo.owner}/${upstreamRepo.repo}`,
  );
  return { repo, originIsFork };
}

export async function deliver(options: DeliverOptions): Promise<DeliverResult> {
  const { root } = options;
  const title = options.title.trim().split("\n")[0]!.slice(0, 200);
  if (!title) throw new DeliverError("A PR title is required.", "invalid_input", 400);
  const remote = options.remote ?? "origin";
  if (remote.startsWith("-")) throw new DeliverError("Invalid remote.", "invalid_input", 400);

  const top = await runGit(root, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (top.code !== 0) throw new DeliverError("The workspace is not a git repository.", "not_a_repo", 400);
  if ((await runGit(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true })).code !== 0) {
    throw new DeliverError("The repository has no commits to branch from.", "not_a_repo", 400);
  }

  // 1. What would be delivered, and is it allowed?
  const changed = (await changedPaths(root)).map(normalizePath);
  if (options.expectedFiles) {
    const expected = new Set(options.expectedFiles.map(normalizePath));
    const unexpected = changed.filter((p) => !expected.has(p));
    if (unexpected.length) {
      throw new DeliverError(
        `Refusing to deliver: the working tree has changes the fix did not make: ${unexpected.slice(0, 10).join(", ")}${unexpected.length > 10 ? ` (+${unexpected.length - 10} more)` : ""}. Commit, stash or discard them first.`,
        "unexpected_changes",
        409,
      );
    }
  }
  const workflows = changed.filter((p) => WORKFLOW_PATH.test(p));
  if (workflows.length && !options.allowWorkflowChanges) {
    throw new DeliverError(
      `Refusing to deliver: the change touches CI workflows (${workflows.join(", ")}). Review them and confirm again to deliver.`,
      "workflow_changes",
      409,
    );
  }
  const current = (await runGit(root, ["branch", "--show-current"])).stdout.trim();
  const onDeliveryBranch = current.startsWith(BRANCH_PREFIX);
  if (!changed.length && !onDeliveryBranch) {
    throw new DeliverError("Nothing to deliver: the working tree has no changes.", "nothing_to_deliver", 409);
  }

  // 2. Where it goes (all checked before anything is mutated).
  const url = await remoteUrl(root, remote);
  const pushRepo = parseRemote(url);
  // origin is a fork of `upstream`: push to origin, open the PR on upstream.
  const upstreamUrl = options.remote || options.repo ? null : await configuredRemoteUrl(root, "upstream");
  const upstream = upstreamUrl ? parseRemote(upstreamUrl) : null;
  const target = deliveryTarget(pushRepo, upstream, options.repo);
  if (!target) {
    if (options.pushOnly) return pushBranchOnly(options, { title, remote, current, onDeliveryBranch, changed });
    throw new DeliverError(
      `The remote "${remote}" is not a GitHub repository, so no pull request can be opened. Deliver with pushOnly to push the branch without one.`,
      "not_github",
      400,
    );
  }
  const { repo, originIsFork } = target;
  const token = options.token === undefined ? await resolveGithubToken() : options.token;
  if (!token) {
    throw new DeliverError("No GitHub token. Connect GitHub in Settings → Integrations (or set GITHUB_TOKEN).", "no_token", 401);
  }
  const api: ApiOptions = { token, fetchImpl: options.fetchImpl };
  // No push access (e.g. someone else's public repo): deliver through a fork.
  const fork = originIsFork
    ? pushRepo
    : options.fork !== "never" && !(await canPush(repo, api).catch(() => true))
      ? await ensureFork(repo, api)
      : null;
  const pushUrl = fork ? `https://github.com/${fork.owner}/${fork.repo}.git` : url;
  const pushRemote = fork ? pushUrl : remote;
  const auth = gitAuthEnv(token, pushUrl);

  let branch: string;
  if (options.branch) {
    branch = options.branch.trim();
    const valid = await runGit(root, ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (branch.startsWith("-") || valid.code !== 0) throw new DeliverError(`Invalid branch name: ${branch}`, "invalid_input", 400);
    if (
      !options.replaceBranch &&
      branch !== current &&
      (await runGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFailure: true })).code === 0
    ) {
      throw new DeliverError(`Branch ${branch} already exists; pick another name.`, "branch_exists", 409);
    }
  } else {
    branch = onDeliveryBranch ? current : branchName(title, await existingBranches(root, pushRemote, auth));
  }
  const base = options.baseBranch?.trim() || (await getDefaultBranch(repo, api));

  // 3. Branch and commit locally.
  if (branch !== current) await runGit(root, ["switch", options.replaceBranch ? "-C" : "-c", branch]);
  if (changed.length) {
    await runGit(root, ["add", "-A", "--", ...changed]);
    const message = `${title}\n\nFiles changed:\n${changed.map((p) => `- ${p}`).join("\n")}\n\nDelivered by Viberon.`;
    await runGit(root, ["commit", "-q", "-m", message]);
  }
  const commit = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();

  // 4. Push; on failure the local branch and commit stay.
  const refspec = `HEAD:refs/heads/${branch}`;
  let push = await gitWithAuth(root, options.replaceBranch ? ["push", "--force-with-lease", pushRemote, refspec] : ["push", pushRemote, refspec], auth);
  if (
    push.code !== 0 &&
    options.replaceBranch &&
    /stale info/i.test(push.output) &&
    (!/^[\w.-]+$/.test(pushRemote) ||
      (await runGit(root, ["rev-parse", "--verify", "-q", `refs/remotes/${pushRemote}/${branch}`], { allowFailure: true })).code !== 0)
  ) {
    // No remote-tracking ref to lease against (e.g. pushing to a fork URL),
    // so git assumed the branch was new: lease against its current remote
    // head instead. With a tracking ref, "stale info" means someone else
    // pushed to the branch, and the refusal stands.
    const remoteHead = await gitWithAuth(root, ["ls-remote", pushRemote, `refs/heads/${branch}`], auth);
    const sha = remoteHead.code === 0 ? /^([0-9a-f]{40,64})\s/m.exec(remoteHead.output)?.[1] : undefined;
    if (sha) push = await gitWithAuth(root, ["push", `--force-with-lease=refs/heads/${branch}:${sha}`, pushRemote, refspec], auth);
  }
  if (push.code !== 0) {
    const reason = explainPushFailure(redact(push.output, token)).message;
    throw new DeliverError(
      `Push to ${fork ? `${fork.owner}/${fork.repo}` : remote} failed: ${reason || `exit ${push.code}`}. Commit ${commit.slice(0, 12)} is on local branch ${branch}; fix the cause and deliver again.`,
      "push_failed",
      502,
      { branch, commit },
    );
  }

  // 5. Open or update the PR.
  const headOwner = fork?.owner ?? repo.owner;
  const update = (number: number) => updatePullRequest({ ...repo, number }, { title, body: options.body }, api);
  const existing = await findOpenPullRequest(repo, branch, api, headOwner);
  let created = false;
  let pr;
  if (existing) {
    pr = await update(existing.number);
  } else {
    try {
      pr = await createPullRequest(
        repo,
        {
          title,
          body: options.body,
          head: fork ? `${fork.owner}:${branch}` : branch,
          base,
          draft: options.draft ?? true,
          ...(fork ? { maintainer_can_modify: true } : {}),
        },
        api,
      );
      created = true;
    } catch (error) {
      // 422 "A pull request already exists" (opened meanwhile, or not yet
      // visible to the lookup): update that PR instead of failing.
      if (!(error instanceof GitHubApiError && error.status === 422)) throw error;
      const raced = await findOpenPullRequest(repo, branch, api, headOwner);
      if (!raced) throw error;
      pr = await update(raced.number);
    }
  }
  return {
    branch,
    commit,
    prUrl: pr.html_url,
    prNumber: pr.number,
    created,
    ...(fork ? { fork: `${fork.owner}/${fork.repo}` } : {}),
  };
}

/**
 * Branch → commit → push to a remote that is not on GitHub. No token, no
 * API: the credentials are whatever git already uses for that remote.
 */
async function pushBranchOnly(
  options: DeliverOptions,
  state: { title: string; remote: string; current: string; onDeliveryBranch: boolean; changed: string[] },
): Promise<DeliverResult> {
  const { root } = options;
  const { title, remote, current, onDeliveryBranch, changed } = state;
  let branch: string;
  if (options.branch) {
    branch = options.branch.trim();
    const valid = await runGit(root, ["check-ref-format", "--branch", branch], { allowFailure: true });
    if (branch.startsWith("-") || valid.code !== 0) throw new DeliverError(`Invalid branch name: ${branch}`, "invalid_input", 400);
    if (
      branch !== current &&
      (await runGit(root, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFailure: true })).code === 0
    ) {
      throw new DeliverError(`Branch ${branch} already exists; pick another name.`, "branch_exists", 409);
    }
  } else {
    branch = onDeliveryBranch ? current : branchName(title, await existingBranches(root, remote, {}));
  }
  if (branch !== current) await runGit(root, ["switch", "-c", branch]);
  if (changed.length) {
    await runGit(root, ["add", "-A", "--", ...changed]);
    const message = `${title}\n\nFiles changed:\n${changed.map((p) => `- ${p}`).join("\n")}\n\nDelivered by Viberon.`;
    await runGit(root, ["commit", "-q", "-m", message]);
  }
  const commit = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
  const push = await gitWithAuth(root, ["push", remote, `HEAD:refs/heads/${branch}`], {});
  if (push.code !== 0) {
    const reason = explainPushFailure(push.output).message;
    throw new DeliverError(
      `Push to ${remote} failed: ${reason || `exit ${push.code}`}. Commit ${commit.slice(0, 12)} is on local branch ${branch}; fix the cause and deliver again.`,
      "push_failed",
      502,
      { branch, commit },
    );
  }
  return { branch, commit, prUrl: "", prNumber: 0, created: false, pushedOnly: true };
}

/* --------------------------- isolated issue work --------------------------- */

export interface IssueWorktree {
  /** The detached checkout the fix runs in. */
  dir: string;
  /** Default branch the work starts from (and the PR targets). */
  base: string;
  repo: RepoId;
}

/**
 * A fresh detached worktree of `origin/<default branch>`, so every issue
 * starts from the same clean base, one PR carries exactly one fix, and the
 * user's own checkout (and uncommitted work) is never touched.
 */
export async function createIssueWorktree(
  root: string,
  options: { token?: string | null; fetchImpl?: typeof fetch; baseBranch?: string } = {},
): Promise<IssueWorktree> {
  const project = await projectRemote(root);
  const url = await remoteUrl(root, project);
  const repo = parseRemote(url);
  if (!repo) throw new DeliverError(`The ${project} remote is not a GitHub repository.`, "no_github_remote", 400);
  const token = options.token === undefined ? await resolveGithubToken() : options.token;
  const base = options.baseBranch ?? await getDefaultBranch(repo, { token, fetchImpl: options.fetchImpl });
  if (!/^[\w./-]+$/.test(base) || base.startsWith("-")) throw new DeliverError(`Unexpected default branch "${base}".`, "invalid_input", 400);

  if (!options.baseBranch) {
    const fetched = await gitWithAuth(root, branchFetchArgs(project, base), gitAuthEnv(token, url));
    if (fetched.code !== 0) {
      throw new DeliverError(`Could not fetch ${project}/${base}: ${redact(fetched.output, token).slice(0, 300)}`, "fetch_failed", 502);
    }
  }
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), "viberon-issue-")), "repo");
  await runGit(root, ["worktree", "add", "--detach", dir, `refs/remotes/${project}/${base}`], { timeoutMs: 120_000 });
  // The worktree has no installed dependencies: link the checkout's own, but
  // only where git ignores the link, so it can never end up in a commit.
  for (const name of [".venv", "venv", "node_modules"]) {
    if (!existsSync(path.join(root, name))) continue;
    const link = path.join(dir, name);
    await symlink(path.join(root, name), link).catch(() => undefined);
    const ignored = await runGit(dir, ["check-ignore", "-q", "--no-index", name], { allowFailure: true });
    if (ignored.code !== 0) await rm(link, { force: true }).catch(() => undefined);
  }
  return { dir, base, repo };
}

/** Remove an issue worktree; its delivered branch stays in the repository. */
export async function removeIssueWorktree(root: string, dir: string): Promise<void> {
  await runGit(root, ["worktree", "remove", "--force", dir], { allowFailure: true });
  await rm(path.dirname(dir), { recursive: true, force: true }).catch(() => undefined);
}

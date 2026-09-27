/**
 * The GitHub REST calls the review, deliver and CI features need, in one
 * place. The token comes from `resolveGithubToken()` (the GitHub integration
 * in Settings, then GITHUB_TOKEN / GH_TOKEN). It is sent only to
 * api.github.com and never logged.
 *
 * Every function takes an optional `fetchImpl` so tests run offline.
 */

import { resolveGithubToken } from "@/lib/workspace/clone";

const API = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface RepoId {
  owner: string;
  repo: string;
}

export interface PrRef extends RepoId {
  number: number;
}

/** `https://github.com/o/r/pull/12` (any trailing path) or `o/r#12`. */
export function parsePrUrl(value: string): PrRef | null {
  const url = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(value.trim());
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(value.trim());
  const m = url ?? short;
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}

/** owner/repo from a git remote URL (https or ssh), github.com only. */
export function parseRemote(remote: string): RepoId | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

export interface ApiOptions {
  token?: string | null;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/* ------------------------- secrets, limits, caching ------------------------ */

/**
 * `text` with `token` removed in every form it can take in git or HTTP
 * output: raw, URL-encoded, base64 of `x-access-token:<token>` (what
 * `gitAuthEnv` sends) and of `<token>` alone, and any credentials embedded in
 * a URL (`https://user:secret@host`).
 */
export function redactSecret(text: string, token: string | null | undefined): string {
  let out = text
    .replace(/(\b[a-z][\w+.-]*:\/\/)([^\s/@:]*):[^\s/@]+@/gi, "$1$2:***@")
    // Anything shaped like a GitHub token, whoever's it is.
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, "***");
  if (!token) return out;
  const forms = new Set<string>();
  for (const form of [
    token,
    encodeURIComponent(token),
    Buffer.from(`x-access-token:${token}`).toString("base64"),
    Buffer.from(token).toString("base64"),
  ]) {
    forms.add(form);
    // base64 without its padding, as some tools print it.
    if (/=+$/.test(form)) forms.add(form.replace(/=+$/, ""));
  }
  for (const form of [...forms].sort((a, b) => b.length - a.length)) {
    if (form.length >= 4) out = out.split(form).join("***");
  }
  return out;
}

/** GitHub's limit on a PR body or comment, in UTF-16 code units. */
export const GITHUB_BODY_LIMIT = 65_536;

/**
 * `text` cut to at most `max` UTF-16 units: the head and tail are kept with a
 * "…truncated N chars…" note between them, never splitting a surrogate pair.
 */
export function truncateBody(text: string, max = GITHUB_BODY_LIMIT): string {
  if (text.length <= max) return text;
  const noteFor = (n: number) => `\n\n…truncated ${n} chars…\n\n`;
  // The note's own length depends on N; size it for the largest possible N.
  const room = Math.max(0, max - noteFor(text.length).length);
  let headEnd = Math.ceil(room * 0.7);
  let tailStart = text.length - (room - headEnd);
  const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
  const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
  if (headEnd > 0 && isHigh(text.charCodeAt(headEnd - 1))) headEnd -= 1;
  if (tailStart < text.length && isLow(text.charCodeAt(tailStart))) tailStart += 1;
  return `${text.slice(0, headEnd)}${noteFor(tailStart - headEnd)}${text.slice(tailStart)}`;
}

/** At most this many retries after a rate-limited response, waiting at most this long in all. */
const MAX_RETRIES = 3;
const MAX_TOTAL_WAIT_MS = 90_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

/**
 * How long to wait before retrying a rate-limited response, or null when it
 * is not one. Secondary limits: 403/429 with `retry-after`, or a "secondary
 * rate limit" message (exponential backoff); primary: `x-ratelimit-remaining: 0`
 * with its reset time.
 */
export function rateLimitWait(res: RawResponse, attempt: number, now = Date.now()): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = res.headers.get("retry-after")?.trim();
  if (retryAfter && /^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
  const reset = res.headers.get("x-ratelimit-reset")?.trim();
  if (res.headers.get("x-ratelimit-remaining") === "0" && reset && /^\d+$/.test(reset)) {
    return Math.max(0, Number(reset) * 1000 - now) + 1000;
  }
  if (res.status === 429 || /secondary rate limit/i.test(res.text)) return Math.min(60_000, 15_000 * 2 ** attempt);
  return null;
}

/** Per-process LRU of ETag'd GET responses: a 304 answers from here and costs no rate limit. */
const ETAG_CACHE_SIZE = 200;
const etagCache = new Map<string, { etag: string; text: string; status: number }>();
/** Identical GETs on the wire, per fetch implementation. */
const inflight = new WeakMap<typeof fetch, Map<string, Promise<RawResponse>>>();

/** Forget every cached GET (tests; after switching tokens). */
export function clearGitHubCache(): void {
  etagCache.clear();
}

type ErrorEntry = string | { message?: string; field?: string; code?: string; resource?: string };

function errorMessage(detail: string, status: number): string {
  try {
    const parsed = JSON.parse(detail) as { message?: string; errors?: ErrorEntry[] };
    const base = parsed.message ?? detail;
    if (status !== 422 || !Array.isArray(parsed.errors)) return base;
    const errors = parsed.errors
      .map((e) => (typeof e === "string" ? e : (e.message ?? [e.resource, e.field, e.code].filter(Boolean).join(" "))))
      .filter(Boolean);
    return errors.length ? `${base}: ${errors.join("; ")}` : base;
  } catch {
    return detail;
  }
}

async function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | undefined,
  opts: ApiOptions,
): Promise<RawResponse> {
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    const response = await (opts.fetchImpl ?? fetch)(url, {
      method,
      headers,
      body,
      signal: opts.signal ?? AbortSignal.timeout(30_000),
      redirect: "follow",
    });
    const res: RawResponse = { status: response.status, headers: response.headers, text: await response.text().catch(() => "") };
    const wait = rateLimitWait(res, attempt);
    if (wait === null || attempt >= MAX_RETRIES || waited + wait > MAX_TOTAL_WAIT_MS) return res;
    waited += wait;
    await sleep(wait, opts.signal);
  }
}

async function call<T>(
  method: string,
  pathname: string,
  body: unknown,
  opts: ApiOptions & { accept?: string; raw?: boolean } = {},
): Promise<T> {
  const token = opts.token === undefined ? await resolveGithubToken() : opts.token;
  const accept = opts.accept ?? "application/vnd.github+json";
  const headers: Record<string, string> = {
    Accept: accept,
    "User-Agent": "Viberon",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const url = `${API}${pathname}`;

  let res: RawResponse;
  if (method === "GET") {
    // Keyed by token so one user's cached answer never serves another.
    const key = `${token ?? ""}\n${accept}\n${url}`;
    const run = async (): Promise<RawResponse> => {
      const cached = etagCache.get(key);
      const r = await send(method, url, cached ? { ...headers, "If-None-Match": cached.etag } : headers, undefined, opts);
      if (r.status === 304 && cached) {
        etagCache.delete(key);
        etagCache.set(key, cached);
        return { status: cached.status, headers: r.headers, text: cached.text };
      }
      const etag = r.headers.get("etag");
      if (r.status >= 200 && r.status < 300 && etag) {
        etagCache.delete(key);
        etagCache.set(key, { etag, text: r.text, status: r.status });
        while (etagCache.size > ETAG_CACHE_SIZE) etagCache.delete(etagCache.keys().next().value!);
      }
      return r;
    };
    if (opts.signal) {
      // A caller with its own abort signal gets its own request.
      res = await run();
    } else {
      const impl = opts.fetchImpl ?? fetch;
      let flights = inflight.get(impl);
      if (!flights) inflight.set(impl, (flights = new Map()));
      let pending = flights.get(key);
      if (!pending) {
        const map = flights;
        pending = run().finally(() => map.delete(key));
        map.set(key, pending);
      }
      res = await pending;
    }
  } else {
    res = await send(method, url, headers, body === undefined ? undefined : JSON.stringify(body), opts);
  }

  if (res.status < 200 || res.status >= 300) {
    const message = redactSecret(errorMessage(res.text, res.status), token);
    const hint =
      res.status === 401
        ? " Check the GitHub token in Settings → Integrations."
        : /rate limit/i.test(message) || rateLimitWait(res, MAX_RETRIES) !== null
          ? token
            ? " GitHub's rate limit for this token is used up; wait for it to reset."
            : " Add a GitHub token in Settings → Integrations (or set GITHUB_TOKEN) for a higher limit."
          : res.status === 403 || res.status === 404
          ? " The token may lack access to this repository."
          : "";
    throw new GitHubApiError(`GitHub ${method} ${pathname} → ${res.status}: ${message.slice(0, 500)}${hint}`, res.status);
  }
  if (opts.raw) return res.text as T;
  // 204, and 201 with no body (e.g. a job re-run), carry nothing to parse.
  return (res.text ? JSON.parse(res.text) : undefined) as T;
}

/* ------------------------------ pull requests ----------------------------- */

export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string };
}

export function getPullRequest(pr: PrRef, opts?: ApiOptions): Promise<PullRequest> {
  return call("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, undefined, opts);
}

/** Unified diff of a PR. */
export function getPullRequestDiff(pr: PrRef, opts?: ApiOptions): Promise<string> {
  return call("GET", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, undefined, {
    ...opts,
    accept: "application/vnd.github.v3.diff",
    raw: true,
  });
}

/** The open PR from `branch` (on `headOwner`'s copy, default the repo's owner), or null. */
export function findOpenPullRequest(
  repo: RepoId,
  branch: string,
  opts?: ApiOptions,
  headOwner = repo.owner,
): Promise<PullRequest | null> {
  return call<PullRequest[]>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/pulls?state=open&head=${encodeURIComponent(`${headOwner}:${branch}`)}`,
    undefined,
    opts,
  ).then((list) => list[0] ?? null);
}

export function createPullRequest(
  repo: RepoId,
  input: { title: string; body: string; head: string; base: string; draft?: boolean; maintainer_can_modify?: boolean },
  opts?: ApiOptions,
): Promise<PullRequest> {
  return call("POST", `/repos/${repo.owner}/${repo.repo}/pulls`, { ...input, body: truncateBody(input.body) }, opts);
}

export function updatePullRequest(
  pr: PrRef,
  input: { title?: string; body?: string },
  opts?: ApiOptions,
): Promise<PullRequest> {
  const body = input.body === undefined ? {} : { body: truncateBody(input.body) };
  return call("PATCH", `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, { ...input, ...body }, opts);
}

/** False only when GitHub says the token's user cannot push to `repo` (→ deliver through a fork). */
export function canPush(repo: RepoId, opts?: ApiOptions): Promise<boolean> {
  return call<{ permissions?: { push?: boolean } }>("GET", `/repos/${repo.owner}/${repo.repo}`, undefined, opts).then(
    (r) => r.permissions?.push !== false,
  );
}

/**
 * The token user's fork of `repo`, created if needed. GitHub creates forks
 * asynchronously, so this waits until the fork answers (up to ~60s).
 */
export async function ensureFork(repo: RepoId, opts?: ApiOptions): Promise<RepoId> {
  const fork = await call<{ owner: { login: string }; name: string }>(
    "POST",
    `/repos/${repo.owner}/${repo.repo}/forks`,
    { default_branch_only: true },
    opts,
  );
  const id = { owner: fork.owner.login, repo: fork.name };
  for (let i = 0; i < 20; i += 1) {
    const ready = await call("GET", `/repos/${id.owner}/${id.repo}`, undefined, opts).then(() => true, () => false);
    if (ready) return id;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new GitHubApiError(`GitHub did not finish creating the fork ${id.owner}/${id.repo} in time; try again shortly.`, 504);
}

export function getDefaultBranch(repo: RepoId, opts?: ApiOptions): Promise<string> {
  return call<{ default_branch: string }>("GET", `/repos/${repo.owner}/${repo.repo}`, undefined, opts).then(
    (r) => r.default_branch,
  );
}

export interface ReviewComment {
  body: string;
  path: string;
  user: { login: string } | null;
  created_at: string;
}

/** Recent inline review comments across the repo's PRs, newest first. */
export function listRepoReviewComments(repo: RepoId, limit = 50, opts?: ApiOptions): Promise<ReviewComment[]> {
  const perPage = Math.min(100, Math.max(1, limit));
  return call<ReviewComment[]>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/pulls/comments?sort=created&direction=desc&per_page=${perPage}`,
    undefined,
    opts,
  );
}

/* --------------------------------- issues --------------------------------- */

/** Issues and PRs share the comments endpoint. */
export function createIssueComment(
  issue: PrRef,
  body: string,
  opts?: ApiOptions,
): Promise<{ html_url: string; id: number }> {
  return call("POST", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments`, { body: truncateBody(body) }, opts);
}

/* ----------------------------------- CI ----------------------------------- */

export interface CheckRun {
  id: number;
  name: string;
  status: "queued" | "in_progress" | "completed" | string;
  conclusion: string | null;
  html_url: string;
  details_url: string | null;
}

export function listCheckRuns(repo: RepoId, sha: string, opts?: ApiOptions): Promise<CheckRun[]> {
  return call<{ check_runs: CheckRun[] }>(
    "GET",
    `/repos/${repo.owner}/${repo.repo}/commits/${sha}/check-runs?per_page=100`,
    undefined,
    opts,
  ).then((r) => r.check_runs);
}

/** For GitHub Actions the check run id is the job id; other CI providers have none. */
export function actionsJobId(check: CheckRun): number | null {
  return /\/actions\/runs\//.test(`${check.details_url ?? ""} ${check.html_url}`) ? check.id : null;
}

/** Plain-text log of an Actions job (GitHub redirects to a signed URL). */
export function getJobLogs(repo: RepoId, jobId: number, opts?: ApiOptions): Promise<string> {
  return call("GET", `/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/logs`, undefined, { ...opts, raw: true });
}

export function rerunJob(repo: RepoId, jobId: number, opts?: ApiOptions): Promise<void> {
  return call("POST", `/repos/${repo.owner}/${repo.repo}/actions/jobs/${jobId}/rerun`, {}, opts);
}

/* -------------------------------- issue list ------------------------------- */

export interface IssueSummary {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: string[];
  author: string | null;
  comments: number;
  created_at: string;
  updated_at: string;
}

interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: (string | { name?: string })[];
  user: { login: string } | null;
  comments: number;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
}

function toSummary(i: RawIssue): IssueSummary {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    html_url: i.html_url,
    state: i.state,
    labels: i.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    author: i.user?.login ?? null,
    comments: i.comments,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

/** Open issues, newest activity first. Fetch pages until the requested issue limit is reached. */
export async function listIssues(
  repo: RepoId,
  query: { labels?: string[]; state?: "open" | "closed" | "all"; limit?: number } = {},
  opts?: ApiOptions,
): Promise<IssueSummary[]> {
  const limit = Math.max(1, query.limit ?? 50);
  const issues: IssueSummary[] = [];
  const perPage = Math.min(100, limit);
  for (let page = 1; issues.length < limit; page += 1) {
    const params = new URLSearchParams({
      state: query.state ?? "open",
      sort: "updated",
      direction: "desc",
      per_page: String(perPage),
      page: String(page),
    });
    if (query.labels?.length) params.set("labels", query.labels.join(","));
    const raw = await call<RawIssue[]>("GET", `/repos/${repo.owner}/${repo.repo}/issues?${params}`, undefined, opts);
    issues.push(...raw.filter((i) => !i.pull_request).map(toSummary));
    if (raw.length < perPage) break;
  }
  return issues.slice(0, limit);
}

export function getIssue(issue: PrRef, opts?: ApiOptions): Promise<IssueSummary> {
  return call<RawIssue>("GET", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`, undefined, opts).then(toSummary);
}

export function listIssueComments(
  issue: PrRef,
  limit = 20,
  opts?: ApiOptions,
): Promise<{ body: string; user: { login: string } | null }[]> {
  return call("GET", `/repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments?per_page=${Math.min(100, limit)}`, undefined, opts);
}

/** `https://github.com/o/r/issues/12` → { owner, repo, number }. */
export function parseIssueUrl(value: string): PrRef | null {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)/i.exec(value.trim());
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/, ""), number: Number(m[3]) } : null;
}

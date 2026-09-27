import { Readable } from "node:stream";
import path from "node:path";
import * as tar from "tar";

import { SOURCE_EXTENSIONS } from "@/lib/lang/extract";

export interface RepoRefParts {
  owner: string;
  repo: string;
  ref: string;
}

export interface RepoFile {
  path: string;
  source: string;
}

export interface TarballResult {
  repoRef: string;
  files: RepoFile[];
}

export class GitHubFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubFetchError";
  }
}

export function isSourceFilePath(filePath: string): boolean {
  return SOURCE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

/* ------------------------------- issues ---------------------------------- */

export interface GitHubIssue {
  title: string;
  body: string;
  url: string;
}

const ISSUE_URL_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/;

export function parseGitHubIssueUrl(
  value: string,
): { owner: string; repo: string; number: number } | null {
  const match = ISSUE_URL_RE.exec(value.trim());
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!.replace(/\.git$/, ""), number: Number(match[3]) };
}

const SHORT_ISSUE_RE = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/**
 * An issue named either way people write it: its URL, or `owner/repo#N`
 * (Pramana `repo/issue.py`). Null for anything else.
 */
export function parseGitHubIssueRef(
  value: string,
): { owner: string; repo: string; number: number } | null {
  const url = parseGitHubIssueUrl(value);
  if (url) return url;
  const short = SHORT_ISSUE_RE.exec(value.trim());
  if (!short || short[1]!.startsWith(".")) return null;
  return { owner: short[1]!, repo: short[2]!.replace(/\.git$/, ""), number: Number(short[3]) };
}

/** The canonical issue URL for a URL or `owner/repo#N`; null when neither. */
export function issueUrlFromRef(value: string): string | null {
  const ref = parseGitHubIssueRef(value);
  return ref ? `https://github.com/${ref.owner}/${ref.repo}/issues/${ref.number}` : null;
}

/**
 * Fetch an issue (or PR) through the REST API. `token` (default
 * `GITHUB_TOKEN`) is optional: it raises the rate limit and reaches private
 * repos. Callers pass the stored integration token (`resolveGithubToken`).
 */
export async function fetchGitHubIssue(
  url: string,
  fetchImpl: typeof fetch = fetch,
  token: string | null | undefined = process.env.GITHUB_TOKEN,
): Promise<GitHubIssue> {
  const parts = parseGitHubIssueUrl(url);
  if (!parts) throw new GitHubFetchError("Not a GitHub issue URL");
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "Viberon",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(
    `https://api.github.com/repos/${parts.owner}/${parts.repo}/issues/${parts.number}`,
    { headers },
  );
  if (!response.ok) {
    throw new GitHubFetchError(`GitHub issue fetch failed: ${response.status}`, response.status);
  }
  const data = (await response.json()) as { title?: string; body?: string | null; html_url?: string };
  return {
    title: data.title ?? `Issue #${parts.number}`,
    body: data.body ?? "",
    url: data.html_url ?? url,
  };
}

export function toRepoRef(parts: RepoRefParts): string {
  return `${parts.owner}/${parts.repo}@${parts.ref}`;
}

export function parseRepoRef(repoRef: string): RepoRefParts | null {
  const match = repoRef.match(/^([^/\s]+)\/([^@\s]+)@(.+)$/);
  if (!match) {
    return null;
  }

  const [, owner, repo, ref] = match;
  if (!owner || !repo || !ref) {
    return null;
  }

  return { owner, repo: repo.replace(/\.git$/, ""), ref };
}

export function parseGitHubUrl(value: string): RepoRefParts | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const repo = segments[1]?.replace(/\.git$/, "");
  if (!owner || !repo || repo === "." || repo === "..") {
    return null;
  }

  const ref = segments[2] === "tree" && segments.length > 3 ? segments.slice(3).join("/") : "main";
  return { owner, repo, ref };
}

export function formatGitHubUrl(repoRefOrParts: string | RepoRefParts): string {
  const parts = typeof repoRefOrParts === "string" ? parseRepoRef(repoRefOrParts) : repoRefOrParts;
  if (!parts) {
    throw new Error(`Invalid repoRef: ${repoRefOrParts}`);
  }

  return `https://github.com/${parts.owner}/${parts.repo}/tree/${parts.ref}`;
}

function tarballUrl(parts: RepoRefParts): string {
  const encodedRef = parts.ref.split("/").map(encodeURIComponent).join("/");
  return `https://codeload.github.com/${parts.owner}/${parts.repo}/tar.gz/${encodedRef}`;
}

function stripTopLevelDir(entryPath: string): string {
  const normalized = entryPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  return segments.slice(1).join("/");
}

async function readTarball(response: Response): Promise<RepoFile[]> {
  if (!response.body) {
    throw new GitHubFetchError("GitHub tarball response did not include a body", response.status);
  }

  const files: RepoFile[] = [];
  const nodeStream = Readable.fromWeb(response.body as never);

  await new Promise<void>((resolve, reject) => {
    const parser = tar.t({
      onentry(entry) {
        const filePath = stripTopLevelDir(entry.path);
        if (entry.type !== "File" || !filePath || !isSourceFilePath(filePath)) {
          entry.resume();
          return;
        }

        const chunks: Buffer[] = [];
        entry.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        entry.on("end", () => {
          files.push({ path: filePath, source: Buffer.concat(chunks).toString("utf8") });
        });
        entry.on("error", reject);
      },
    });

    parser.on("error", reject);
    parser.on("finish", resolve);
    nodeStream.on("error", reject);
    nodeStream.pipe(parser);
  });

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function fetchAttempt(parts: RepoRefParts): Promise<TarballResult> {
  const response = await fetch(tarballUrl(parts), {
    headers: {
      Accept: "application/x-gzip",
      "User-Agent": "Viberon MVP",
    },
  });

  if (!response.ok) {
    throw new GitHubFetchError(`GitHub fetch failed: ${response.status}`, response.status);
  }

  return {
    repoRef: toRepoRef(parts),
    files: await readTarball(response),
  };
}

export async function fetchTarball(repoRef: string): Promise<TarballResult> {
  const parts = parseRepoRef(repoRef);
  if (!parts) {
    throw new GitHubFetchError(`Invalid repoRef: ${repoRef}`);
  }

  const attempts =
    parts.ref === "main" ? [parts, { ...parts, ref: "master" }] : [parts];

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      return await fetchAttempt(attempt);
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitHubFetchError) || error.status !== 404) {
        break;
      }
    }
  }

  throw lastError instanceof Error ? lastError : new GitHubFetchError("GitHub fetch failed");
}


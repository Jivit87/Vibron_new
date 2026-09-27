/**
 * Pramana web/github.py behaviour: a repeat click on "Open PR" returns the
 * already-open pull request (no "could not commit", no second PR, no reset
 * branch); issues are named by URL or `owner/repo#N`; the PR body and the
 * issue comment carry the evidence table. Real git against a local bare
 * remote, GitHub REST stubbed with a stateful fetch.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deliver, renderPrBody, reportOnIssue, type DeliveryEvidence } from "@/lib/deliver";
import { issueUrlFromRef, parseGitHubIssueRef } from "@/lib/github";
import { parseIssueUrl } from "@/lib/github-api";
import { makeTmpRepo, type TmpRepo } from "@/tests/helpers/tmp-repo";

const TOKEN = "ghp_SECRETTOKEN123";
const REPO = { owner: "o", repo: "r" };

/** GitHub stand-in that remembers the PRs it opened, like the real one. */
function statefulGitHub() {
  const open = new Map<string, { number: number; html_url: string }>();
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (method === "GET" && url.endsWith("/repos/o/r")) return json({ default_branch: "main", permissions: { push: true } });
    if (method === "GET" && url.includes("/pulls?state=open")) {
      const head = decodeURIComponent(/head=([^&]+)/.exec(url)![1]!);
      const pr = open.get(head);
      return json(pr ? [pr] : []);
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      const head = `o:${String(body!.head)}`;
      if (open.has(head)) return json({ message: "Validation Failed: A pull request already exists" }, 422);
      const pr = { number: open.size + 7, html_url: `https://github.com/o/r/pull/${open.size + 7}` };
      open.set(head, pr);
      return json(pr, 201);
    }
    if (method === "PATCH") {
      const n = Number(/pulls\/(\d+)/.exec(url)![1]);
      return json({ number: n, html_url: `https://github.com/o/r/pull/${n}` });
    }
    if (method === "POST" && url.endsWith("/comments")) return json({ id: 1, html_url: `${url}#issuecomment-1` }, 201);
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { calls, fetchImpl, posts: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/pulls")).length };
}

let repo: TmpRepo;
let bare: string;
const remoteRef = (ref: string) => execFileSync("git", ["--git-dir", bare, "rev-parse", ref], { encoding: "utf8" }).trim();

beforeEach(() => {
  repo = makeTmpRepo({ "a.txt": "a\n" });
  repo.git("config", "user.name", "t");
  repo.git("config", "user.email", "t@t");
  bare = mkdtempSync(path.join(os.tmpdir(), "viberon-remote-"));
  execFileSync("git", ["init", "-q", "--bare", bare]);
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "origin", "HEAD:refs/heads/main");
});

afterEach(() => {
  repo.cleanup();
  rmSync(bare, { recursive: true, force: true });
});

describe("repeat click on Open PR", () => {
  it("returns the already-open PR, re-pushes the committed branch, and leaves the checkout alone", async () => {
    const gh = statefulGitHub();
    const opts = { root: repo.root, repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl, title: "Fix it", body: "b", branch: "viberon/fix-it", expectedFiles: ["a.txt"] };
    repo.write("a.txt", "fixed\n");
    const first = await deliver(opts);
    expect(first.created).toBe(true);
    // The user goes back to their own branch; the fix lives on viberon/fix-it.
    repo.git("switch", "-q", "-");
    const home = repo.git("rev-parse", "HEAD").trim();

    const second = await deliver(opts);
    expect(second.prUrl).toBe(first.prUrl);
    expect(second.created).toBe(false);
    expect(second.commit).toBe(first.commit);
    expect(gh.posts()).toBe(1);
    expect(remoteRef("refs/heads/viberon/fix-it")).toBe(first.commit);
    expect(repo.git("rev-parse", "HEAD").trim()).toBe(home);
  });

  it("replaceBranch: a repeat does not reset the issue branch to the base (no empty PR)", async () => {
    const gh = statefulGitHub();
    const opts = { root: repo.root, repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl, title: "Fix #5", body: "b", branch: "viberon/issue-5-x", replaceBranch: true };
    repo.write("a.txt", "fixed\n");
    const first = await deliver(opts);
    repo.git("switch", "-q", "-");
    const second = await deliver(opts);
    expect(second.commit).toBe(first.commit);
    expect(repo.git("rev-parse", "viberon/issue-5-x").trim()).toBe(first.commit);
    expect(remoteRef("refs/heads/viberon/issue-5-x")).toBe(first.commit);
    expect(second.prUrl).toBe(first.prUrl);
  });

  it("a named branch outside viberon/ that is checked out is a repeat, not 'nothing to deliver'", async () => {
    const gh = statefulGitHub();
    const opts = { root: repo.root, repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl, title: "Fix it", body: "b", branch: "my-fix" };
    repo.write("a.txt", "fixed\n");
    const first = await deliver(opts);
    const second = await deliver(opts);
    expect(second.prUrl).toBe(first.prUrl);
    expect(gh.posts()).toBe(1);
  });

  it("still refuses a clean tree when nothing was ever delivered", async () => {
    const gh = statefulGitHub();
    await expect(deliver({ root: repo.root, repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl, title: "x", body: "" })).rejects.toMatchObject({
      code: "nothing_to_deliver",
    });
  });
});

describe("issue refs", () => {
  it("parses issue URLs and owner/repo#N", () => {
    expect(parseGitHubIssueRef("https://github.com/o/r/issues/5")).toEqual({ owner: "o", repo: "r", number: 5 });
    expect(parseGitHubIssueRef(" o/r.js#12 ")).toEqual({ owner: "o", repo: "r.js", number: 12 });
    expect(parseGitHubIssueRef("o/r")).toBeNull();
    expect(parseGitHubIssueRef("../r#1")).toBeNull();
    expect(issueUrlFromRef("o/r#3")).toBe("https://github.com/o/r/issues/3");
    expect(parseIssueUrl("https://www.github.com/o/r/issues/9")).toEqual({ owner: "o", repo: "r", number: 9 });
    expect(parseIssueUrl("o/r#9")).toEqual({ owner: "o", repo: "r", number: 9 });
  });
});

describe("evidence", () => {
  const evidence: DeliveryEvidence = {
    status: "resolved",
    filesChanged: ["a.txt"],
    checks: [{ command: "pytest -k a|b", original: "1 failed", patched: "1 passed", verdict: "fixed 1, no regressions" }],
  };

  it("PR body has the original → patched table and closes owner/repo#N", () => {
    const body = renderPrBody({ summary: "s", evidence, issueUrl: "o/r#5" });
    expect(body).toContain("| check | original code | with patch | verdict |");
    expect(body).toContain("`pytest -k a\\|b` | 1 failed | 1 passed |");
    expect(body).toContain("Fixes o/r#5");
  });

  it("comments the evidence on an issue named owner/repo#N", async () => {
    const gh = statefulGitHub();
    const out = await reportOnIssue(
      { issueUrl: "o/r#5", prUrl: "https://github.com/o/r/pull/7", summary: "done", evidence },
      { token: TOKEN, fetchImpl: gh.fetchImpl },
    );
    const post = gh.calls.find((c) => c.url.endsWith("/repos/o/r/issues/5/comments"))!;
    expect(String(post.body!.body)).toContain("| check | original code | with patch | verdict |");
    expect(out.commentUrl).toContain("issuecomment");
  });
});

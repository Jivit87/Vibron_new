/**
 * Delivery, offline: real git on a temp repo whose "origin" is a local bare
 * repo, and a fake GitHub REST fetch.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  branchName,
  deliver,
  DeliverError,
  deliveryTarget,
  evidenceFromResult,
  explainPushFailure,
  MAX_BRANCH_LENGTH,
  renderPrBody,
  reportOnIssue,
} from "@/lib/deliver";
import { emptySolveResult } from "@/lib/headless/run";
import { makeTmpRepo, type TmpRepo } from "@/tests/helpers/tmp-repo";

const TOKEN = "ghp_SECRETTOKEN123";
const REPO = { owner: "o", repo: "r" };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** GitHub REST stand-in: default branch main, PRs created/updated in memory. */
function fakeGitHub(options: { openPr?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (method === "GET" && url.endsWith("/repos/o/r")) return json({ default_branch: "main" });
    if (method === "GET" && url.includes("/pulls?state=open")) {
      return json(options.openPr ? [{ number: options.openPr, html_url: `https://github.com/o/r/pull/${options.openPr}` }] : []);
    }
    if (method === "POST" && url.endsWith("/pulls")) return json({ number: 7, html_url: "https://github.com/o/r/pull/7" }, 201);
    if (method === "PATCH") return json({ number: options.openPr, html_url: `https://github.com/o/r/pull/${options.openPr}` });
    if (method === "POST" && url.endsWith("/comments")) return json({ id: 1, html_url: "https://github.com/o/r/issues/5#issuecomment-1" }, 201);
    return json({ message: "Not Found" }, 404);
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

let repo: TmpRepo;
let bare: string;

function remoteRef(ref: string): string {
  return execFileSync("git", ["--git-dir", bare, "rev-parse", ref], { encoding: "utf8" }).trim();
}

beforeEach(() => {
  repo = makeTmpRepo({ "a.txt": "a\n", "b.txt": "b\n" });
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

const base = (gh: ReturnType<typeof fakeGitHub>) => ({ root: repo.root, repo: REPO, token: TOKEN, fetchImpl: gh.fetchImpl });

describe("branchName", () => {
  it("slugs the title under viberon/, at most 48 chars", () => {
    expect(branchName("Fix: parser crashes on `None`!")).toBe("viberon/fix-parser-crashes-on-none");
    expect(branchName("   ")).toBe("viberon/change");
    const long = branchName("a very long title that keeps going well past any sensible branch name length");
    expect(long.length).toBeLessThanOrEqual(MAX_BRANCH_LENGTH);
    expect(long).toMatch(/^viberon\/[a-z0-9-]+[a-z0-9]$/);
  });

  it("dedupes against existing branches", () => {
    expect(branchName("Fix it", ["viberon/fix-it"])).toBe("viberon/fix-it-2");
    expect(branchName("Fix it", ["viberon/fix-it", "viberon/fix-it-2"])).toBe("viberon/fix-it-3");
    const title = "x".repeat(60);
    const first = branchName(title);
    const second = branchName(title, [first]);
    expect(second.length).toBeLessThanOrEqual(MAX_BRANCH_LENGTH);
    expect(second.endsWith("-2")).toBe(true);
  });
});

describe("deliveryTarget", () => {
  const fork = { owner: "me", repo: "x" };
  const original = { owner: "them", repo: "x" };

  it("opens the PR on upstream and pushes to origin as the fork, when origin already points at a different repo", () => {
    // This is exactly the bug that shipped: a repo already set up with
    // origin = fork, upstream = original silently opened the PR on the fork.
    expect(deliveryTarget(fork, original)).toEqual({ repo: original, originIsFork: true });
  });

  it("targets origin directly when there is no upstream remote", () => {
    expect(deliveryTarget(original, null)).toEqual({ repo: original, originIsFork: false });
  });

  it("does not call origin a fork of itself", () => {
    expect(deliveryTarget(original, original)).toEqual({ repo: original, originIsFork: false });
  });

  it("an explicit repo wins over both", () => {
    const explicit = { owner: "explicit", repo: "y" };
    expect(deliveryTarget(fork, original, explicit)).toEqual({ repo: explicit, originIsFork: true });
  });

  it("null when origin cannot be identified and nothing else names a repo", () => {
    expect(deliveryTarget(null, null)).toBeNull();
  });
});

describe("deliver", () => {
  it("branches, commits, pushes and opens a draft PR", async () => {
    const gh = fakeGitHub();
    repo.write("a.txt", "fixed\n");
    const out = await deliver({ ...base(gh), title: "Fix the parser crash", body: "Body", expectedFiles: ["a.txt"] });
    expect(out).toMatchObject({ branch: "viberon/fix-the-parser-crash", prNumber: 7, prUrl: "https://github.com/o/r/pull/7", created: true });
    expect(remoteRef(`refs/heads/${out.branch}`)).toBe(out.commit);
    expect(repo.git("status", "--porcelain").trim()).toBe("");
    const message = repo.git("log", "-1", "--format=%B");
    expect(message).toContain("Fix the parser crash");
    expect(message).toContain("- a.txt");
    expect(message).not.toContain(TOKEN);
    const create = gh.calls.find((c) => c.method === "POST");
    expect(create?.body).toEqual({ title: "Fix the parser crash", body: "Body", head: out.branch, base: "main", draft: true });
  });

  it("dedupes the branch against local and remote branches", async () => {
    repo.git("branch", "viberon/fix-it");
    repo.git("push", "-q", "origin", "HEAD:refs/heads/viberon/fix-it-2");
    repo.write("a.txt", "fixed\n");
    const out = await deliver({ ...base(fakeGitHub()), title: "Fix it", body: "" });
    expect(out.branch).toBe("viberon/fix-it-3");
  });

  it("continues the current viberon/ branch and updates its open PR", async () => {
    repo.write("a.txt", "one\n");
    const first = await deliver({ ...base(fakeGitHub()), title: "Fix it", body: "" });
    repo.write("a.txt", "two\n");
    const gh = fakeGitHub({ openPr: 7 });
    const second = await deliver({ ...base(gh), title: "Fix it better", body: "v2" });
    expect(second.branch).toBe(first.branch);
    expect(second.created).toBe(false);
    expect(remoteRef(`refs/heads/${first.branch}`)).toBe(second.commit);
    expect(gh.calls.find((c) => c.method === "PATCH")?.body).toEqual({ title: "Fix it better", body: "v2" });
  });

  it("refuses changes outside expectedFiles before touching anything", async () => {
    const gh = fakeGitHub();
    repo.write("a.txt", "fixed\n");
    repo.write("stray.txt", "oops\n");
    const head = repo.git("rev-parse", "HEAD");
    const error = await deliver({ ...base(gh), title: "Fix", body: "", expectedFiles: ["a.txt"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeliverError);
    expect((error as DeliverError).code).toBe("unexpected_changes");
    expect((error as DeliverError).message).toContain("stray.txt");
    expect(repo.git("rev-parse", "HEAD")).toBe(head);
    expect(repo.git("branch", "--show-current").trim()).not.toMatch(/^viberon\//);
    expect(gh.calls).toEqual([]);
  });

  it("refuses CI workflow changes unless re-confirmed", async () => {
    repo.write(".github/workflows/ci.yml", "on: push\n");
    const files = [".github/workflows/ci.yml"];
    const refused = await deliver({ ...base(fakeGitHub()), title: "CI", body: "", expectedFiles: files }).catch((e: unknown) => e);
    expect((refused as DeliverError).code).toBe("workflow_changes");
    expect((refused as DeliverError).status).toBe(409);
    const ok = await deliver({ ...base(fakeGitHub()), title: "CI", body: "", expectedFiles: files, allowWorkflowChanges: true });
    expect(ok.prNumber).toBe(7);
  });

  it("refuses an empty tree and a missing token", async () => {
    const empty = await deliver({ ...base(fakeGitHub()), title: "Fix", body: "" }).catch((e: unknown) => e);
    expect((empty as DeliverError).code).toBe("nothing_to_deliver");
    repo.write("a.txt", "x\n");
    const noToken = await deliver({ ...base(fakeGitHub()), token: null, title: "Fix", body: "" }).catch((e: unknown) => e);
    expect((noToken as DeliverError).status).toBe(401);
  });

  it("keeps the local branch and commit when the push fails, and says why", async () => {
    const gh = fakeGitHub();
    repo.write("a.txt", "fixed\n");
    const missing = path.join(os.tmpdir(), "viberon-no-such-remote", "x.git");
    const error = (await deliver({ ...base(gh), remote: missing, title: "Fix it", body: "" }).catch((e: unknown) => e)) as DeliverError;
    expect(error.code).toBe("push_failed");
    expect(error.message).toMatch(/Push to .* failed: .+local branch viberon\/fix-it/);
    expect(error.message).not.toContain(TOKEN);
    expect(error.partial?.branch).toBe("viberon/fix-it");
    expect(repo.git("rev-parse", "viberon/fix-it").trim()).toBe(error.partial?.commit);
    expect(gh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("explains a non-fast-forward push in plain language and keeps the branch and commit", async () => {
    // The remote branch has a commit the local one does not.
    repo.git("switch", "-q", "-c", "elsewhere");
    repo.write("b.txt", "theirs\n");
    repo.git("commit", "-qam", "theirs");
    repo.git("push", "-q", "origin", "HEAD:refs/heads/viberon/moved");
    repo.git("switch", "-q", "-");
    repo.git("branch", "-q", "-D", "elsewhere");
    const gh = fakeGitHub();
    repo.write("a.txt", "fixed\n");
    const error = (await deliver({ ...base(gh), branch: "viberon/moved", title: "Fix it", body: "" }).catch((e: unknown) => e)) as DeliverError;
    expect(error.code).toBe("push_failed");
    expect(error.message).toMatch(/the remote branch has new commits/);
    expect(error.message).toContain("local branch viberon/moved");
    expect(repo.git("rev-parse", "viberon/moved").trim()).toBe(error.partial?.commit);
  });
});

describe("explainPushFailure", () => {
  it("names auth failures, protected branches and non-fast-forwards", () => {
    expect(explainPushFailure("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'").message).toMatch(/GitHub rejected the token/);
    expect(explainPushFailure("remote: Permission to o/r.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403").reason).toBe("auth");
    expect(explainPushFailure("remote: error: GH006: Protected branch update failed for refs/heads/main.").reason).toBe("protected");
    expect(explainPushFailure(" ! [rejected]        HEAD -> x (fetch first)\nhint: Updates were rejected because the remote contains work").reason).toBe("non_fast_forward");
    expect(explainPushFailure("fatal: something odd").message).toBe("fatal: something odd");
  });
});

describe("report", () => {
  it("comments the PR link, status, checks table and files on the issue", async () => {
    const gh = fakeGitHub();
    const result = emptySolveResult("resolved");
    result.filesChanged = ["src/a.py"];
    result.gate = {
      ...result.gate,
      enabled: true,
      command: "pytest -q",
      baseline: { counts: { passed: 3, failed: 1, errors: 0, skipped: 0 }, parsed: true, exitCode: 1, timedOut: false } as never,
      final: { counts: { passed: 4, failed: 0, errors: 0, skipped: 0 }, parsed: true, exitCode: 0, timedOut: false } as never,
      fixed: ["test_a"],
    };
    const evidence = evidenceFromResult(result);
    expect(evidence.checks).toEqual([
      { command: "pytest -q", original: "3 passed, 1 failed", patched: "4 passed, 0 failed", verdict: "fixed 1, no regressions" },
    ]);
    const out = await reportOnIssue(
      { issueUrl: "https://github.com/o/r/issues/5", prUrl: "https://github.com/o/r/pull/7", summary: "Fixed a.", evidence },
      { token: TOKEN, fetchImpl: gh.fetchImpl },
    );
    expect(out.commentUrl).toContain("issuecomment");
    const call = gh.calls[0]!;
    expect(call.url).toBe("https://api.github.com/repos/o/r/issues/5/comments");
    const body = (call.body as { body: string }).body;
    expect(body).toContain("https://github.com/o/r/pull/7");
    expect(body).toContain("VERIFIED FIX");
    expect(body).toContain("| `pytest -q` | 3 passed, 1 failed | 4 passed, 0 failed | fixed 1, no regressions |");
    expect(body).toContain("`src/a.py`");
    expect(renderPrBody({ summary: "s", evidence, issueUrl: "https://github.com/o/r/issues/5" })).toContain("Fixes o/r#5");
  });

  it("rejects non-issue URLs", async () => {
    const error = await reportOnIssue({
      issueUrl: "https://example.com/x",
      prUrl: "https://github.com/o/r/pull/7",
      summary: "",
      evidence: { status: "resolved", filesChanged: [], checks: [] },
    }).catch((e: unknown) => e);
    expect((error as DeliverError).status).toBe(400);
  });
});

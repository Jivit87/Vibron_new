import { describe, expect, it, vi } from "vitest";

import {
  actionsJobId,
  createPullRequest,
  getPullRequestDiff,
  GitHubApiError,
  listIssues,
  parsePrUrl,
  parseRemote,
  type CheckRun,
} from "@/lib/github-api";

describe("github-api", () => {
  it("reads subsequent pages when pull requests occupy the first issue page", async () => {
    const raw = (number: number, pullRequest = false) => ({
      number, title: `#${number}`, body: "", html_url: `https://github.com/o/r/issues/${number}`,
      state: "open", labels: [], user: null, comments: 0, created_at: "", updated_at: "",
      ...(pullRequest ? { pull_request: {} } : {}),
    });
    const fake = vi.fn(async (url: string) => new Response(JSON.stringify(
      new URL(url).searchParams.get("page") === "1" ? [raw(1, true), raw(2, true)] : [raw(3), raw(4)],
    )));
    const issues = await listIssues({ owner: "o", repo: "r" }, { limit: 2 }, { token: "test", fetchImpl: fake as unknown as typeof fetch });
    expect(issues.map((issue) => issue.number)).toEqual([3, 4]);
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("parses PR URLs and remotes", () => {
    expect(parsePrUrl("https://github.com/o/r/pull/12/files")).toEqual({ owner: "o", repo: "r", number: 12 });
    expect(parsePrUrl("o/r#7")).toEqual({ owner: "o", repo: "r", number: 7 });
    expect(parsePrUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(parseRemote("git@github.com:o/r.git")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("https://github.com/o/r")).toEqual({ owner: "o", repo: "r" });
    expect(parseRemote("https://gitlab.com/o/r.git")).toBeNull();
  });

  it("sends the token only as a bearer header and asks for a diff", async () => {
    const fake = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response("diff --git a/x b/x\n"));
    const diff = await getPullRequestDiff({ owner: "o", repo: "r", number: 1 }, { token: "t0k", fetchImpl: fake as unknown as typeof fetch });
    expect(diff).toContain("diff --git");
    const [url, init] = fake.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/o/r/pulls/1");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer t0k");
    expect(headers.Accept).toBe("application/vnd.github.v3.diff");
  });

  it("turns API errors into actionable messages", async () => {
    const fake = vi.fn(async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
    const error = await createPullRequest(
      { owner: "o", repo: "r" },
      { title: "t", body: "b", head: "h", base: "main" },
      { token: "bad", fetchImpl: fake as unknown as typeof fetch },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).message).toMatch(/401: Bad credentials.*Settings → Integrations/);
  });

  it("identifies Actions jobs", () => {
    const run = (details: string | null): CheckRun => ({
      id: 99,
      name: "test",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/o/r/runs/99",
      details_url: details,
    });
    expect(actionsJobId(run("https://github.com/o/r/actions/runs/5/job/99"))).toBe(99);
    expect(actionsJobId(run("https://ci.example.com/build/1"))).toBeNull();
  });
});

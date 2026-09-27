/**
 * GitHub client resilience, offline: rate-limit retries, ETag caching,
 * in-flight dedupe, 422 messages, body truncation and token redaction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearGitHubCache,
  createIssueComment,
  createPullRequest,
  getDefaultBranch,
  getIssue,
  GITHUB_BODY_LIMIT,
  GitHubApiError,
  redactSecret,
  truncateBody,
} from "@/lib/github-api";

const REPO = { owner: "o", repo: "r" };
type Fake = (url: string, init?: RequestInit) => Promise<Response>;
const asFetch = (f: Fake) => f as unknown as typeof fetch;

beforeEach(() => clearGitHubCache());

describe("rate limits", () => {
  it("retries a secondary rate limit after Retry-After", async () => {
    let n = 0;
    const fake = vi.fn<Fake>(async () =>
      ++n === 1
        ? new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 403, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ default_branch: "main" })),
    );
    expect(await getDefaultBranch(REPO, { token: "t", fetchImpl: asFetch(fake) })).toBe("main");
    expect(fake).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 retries", async () => {
    const fake = vi.fn<Fake>(async () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }));
    const error = await getDefaultBranch(REPO, { token: "t", fetchImpl: asFetch(fake) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect((error as GitHubApiError).message).toMatch(/rate limit/);
    expect(fake).toHaveBeenCalledTimes(4);
  });

  it("does not wait past the cap for a far-off primary reset", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3600);
    const fake = vi.fn<Fake>(async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset },
      }),
    );
    const started = Date.now();
    await expect(getDefaultBranch(REPO, { token: "t", fetchImpl: asFetch(fake) })).rejects.toThrow(/rate limit/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it("the caller's signal aborts the backoff", async () => {
    const fake = vi.fn<Fake>(async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stopped")), 20);
    const started = Date.now();
    await expect(getDefaultBranch(REPO, { token: "t", fetchImpl: asFetch(fake), signal: controller.signal })).rejects.toThrow(/stopped/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("conditional GETs", () => {
  it("sends If-None-Match and answers a 304 from the cache", async () => {
    const seen: (string | undefined)[] = [];
    const fake = vi.fn<Fake>(async (_url, init) => {
      const inm = (init?.headers as Record<string, string>)["If-None-Match"];
      seen.push(inm);
      return inm === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(JSON.stringify({ default_branch: "main" }), { headers: { etag: '"v1"' } });
    });
    const opts = { token: "t", fetchImpl: asFetch(fake) };
    expect(await getDefaultBranch(REPO, opts)).toBe("main");
    expect(await getDefaultBranch(REPO, opts)).toBe("main");
    expect(seen).toEqual([undefined, '"v1"']);
  });

  it("does not share cached bodies between tokens", async () => {
    const seen: (string | undefined)[] = [];
    const fake = vi.fn<Fake>(async (_url, init) => {
      seen.push((init?.headers as Record<string, string>)["If-None-Match"]);
      return new Response(JSON.stringify({ default_branch: "main" }), { headers: { etag: '"v1"' } });
    });
    await getDefaultBranch(REPO, { token: "a", fetchImpl: asFetch(fake) });
    await getDefaultBranch(REPO, { token: "b", fetchImpl: asFetch(fake) });
    expect(seen).toEqual([undefined, undefined]);
  });

  it("dedupes identical in-flight GETs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = vi.fn<Fake>(async () => {
      await gate;
      return new Response(JSON.stringify({ number: 1, title: "x", body: "", html_url: "", state: "open", labels: [], user: null, comments: 0, created_at: "", updated_at: "" }));
    });
    const opts = { token: "t", fetchImpl: asFetch(fake) };
    const both = Promise.all([getIssue({ ...REPO, number: 1 }, opts), getIssue({ ...REPO, number: 1 }, opts)]);
    release();
    const [a, b] = await both;
    expect(a.number).toBe(1);
    expect(b.number).toBe(1);
    expect(fake).toHaveBeenCalledTimes(1);
  });
});

describe("errors and bodies", () => {
  it("surfaces GitHub's errors[].message on a 422", async () => {
    const fake = vi.fn<Fake>(async () =>
      new Response(JSON.stringify({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for o:viberon/x." }] }), { status: 422 }),
    );
    const error = (await createPullRequest(REPO, { title: "t", body: "b", head: "viberon/x", base: "main" }, { token: "t", fetchImpl: asFetch(fake) }).catch((e: unknown) => e)) as GitHubApiError;
    expect(error.status).toBe(422);
    expect(error.message).toContain("Validation Failed: A pull request already exists for o:viberon/x.");
  });

  it("truncates to the limit keeping head, tail and a note, never splitting a surrogate pair", () => {
    const text = "H".repeat(50_000) + "😀".repeat(20_000) + "T".repeat(10_000);
    const out = truncateBody(text);
    expect(out.length).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(out.startsWith("HHHH")).toBe(true);
    expect(out.endsWith("TTTT")).toBe(true);
    const n = Number(/…truncated (\d+) chars…/.exec(out)?.[1]);
    expect(out.length - `\n\n…truncated ${n} chars…\n\n`.length + n).toBe(text.length);
    expect(() => encodeURIComponent(out)).not.toThrow(); // throws on a lone surrogate
    for (let cut = GITHUB_BODY_LIMIT - 40; cut < GITHUB_BODY_LIMIT; cut += 1) {
      expect(() => encodeURIComponent(truncateBody("😀".repeat(40_000), cut))).not.toThrow();
    }
    expect(truncateBody("short")).toBe("short");
  });

  it("truncates PR bodies and issue comments before sending", async () => {
    const bodies: number[] = [];
    const fake = vi.fn<Fake>(async (_url, init) => {
      bodies.push((JSON.parse(String(init?.body)) as { body: string }).body.length);
      return new Response(JSON.stringify({ number: 1, html_url: "u", id: 1 }), { status: 201 });
    });
    const opts = { token: "t", fetchImpl: asFetch(fake) };
    const huge = "x".repeat(100_000);
    await createPullRequest(REPO, { title: "t", body: huge, head: "h", base: "main" }, opts);
    await createIssueComment({ ...REPO, number: 1 }, huge, opts);
    expect(bodies.every((n) => n <= GITHUB_BODY_LIMIT)).toBe(true);
  });

  it("redacts the token in raw, base64 and URL forms, including from API errors", async () => {
    const token = "ghp_TopSecret123";
    const b64 = Buffer.from(`x-access-token:${token}`).toString("base64");
    const text = [
      `raw ${token}`,
      `header AUTHORIZATION: basic ${b64}`,
      `bare ${Buffer.from(token).toString("base64")}`,
      `url https://x-access-token:${token}@github.com/o/r.git`,
      `other https://user:hunter2@example.com/x`,
      `enc ${encodeURIComponent(token + "/")}`,
    ].join("\n");
    const out = redactSecret(text, token);
    expect(out).not.toContain(token);
    expect(out).not.toContain(b64);
    expect(out).not.toContain(b64.replace(/=+$/, ""));
    expect(out).not.toContain("hunter2");
    expect(out).toContain("https://x-access-token:***@github.com/o/r.git");

    const fake = vi.fn<Fake>(async () => new Response(JSON.stringify({ message: `bad credentials ${token}` }), { status: 401 }));
    const error = (await getDefaultBranch(REPO, { token, fetchImpl: asFetch(fake) }).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(token);
  });
});

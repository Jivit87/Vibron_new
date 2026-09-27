/** CI watch and flaky re-runs against a fake GitHub REST fetch. */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ciFixTask, ciStatus, DeliverError, MAX_RERUNS_PER_HEAD, rerunFlaky } from "@/lib/deliver";
import type { CheckRun } from "@/lib/github-api";
import { resetMemoryStoreForTests } from "@/lib/store";

process.env.VIBERON_STORE = "memory";

const PR = "https://github.com/o/r/pull/1";
const LOG = [
  "2026-01-01T00:00:00Z Run pytest",
  "collected 2 items",
  "FAILED tests/test_x.py::test_a - AssertionError: assert 1 == 2",
  "=== 1 failed, 1 passed in 0.1s ===",
].join("\n");

function check(id: number, name: string, status: string, conclusion: string | null, actions = true): CheckRun {
  return {
    id,
    name,
    status,
    conclusion,
    html_url: `https://github.com/o/r/runs/${id}`,
    details_url: actions ? `https://github.com/o/r/actions/runs/5/job/${id}` : "https://ci.example.com/b/1",
  };
}

function fakeGitHub(state: { sha: string; checks: CheckRun[] }) {
  const calls: { method: string; url: string }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    if (url.endsWith("/pulls/1")) return Response.json({ number: 1, head: { ref: "viberon/x", sha: state.sha }, base: { ref: "main" } });
    if (url.includes("/check-runs")) return Response.json({ check_runs: state.checks });
    if (url.endsWith("/logs")) return new Response(LOG);
    if (method === "POST" && url.endsWith("/rerun")) return new Response(null, { status: 201 });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  return { calls, opts: { token: "t", fetchImpl: fetchImpl as unknown as typeof fetch } };
}

beforeEach(() => resetMemoryStoreForTests());

describe("ciStatus", () => {
  it("reports failure with the failing Actions job's extracted log", async () => {
    const gh = fakeGitHub({
      sha: "abc123",
      checks: [check(1, "lint", "completed", "success"), check(2, "test", "completed", "failure"), check(3, "build", "in_progress", null)],
    });
    const status = await ciStatus({ prUrl: PR }, gh.opts);
    expect(status.headSha).toBe("abc123");
    expect(status.state).toBe("failure");
    const failed = status.checks.find((c) => c.name === "test")!;
    expect(failed.logExcerpt).toContain("AssertionError");
    expect(status.checks.find((c) => c.name === "lint")!.logExcerpt).toBeUndefined();
    expect(gh.calls.filter((c) => c.url.endsWith("/logs"))).toHaveLength(1);

    const task = ciFixTask(status);
    expect(task).toContain("### test (failure)");
    expect(task).toContain("AssertionError");
    expect(task).not.toContain("### lint");
  });

  it("is pending while checks run or none registered, success when all pass", async () => {
    expect((await ciStatus({ prUrl: PR }, fakeGitHub({ sha: "s", checks: [check(1, "t", "queued", null)] }).opts)).state).toBe("pending");
    expect((await ciStatus({ prUrl: PR }, fakeGitHub({ sha: "s", checks: [] }).opts)).state).toBe("pending");
    const ok = await ciStatus({ prUrl: PR }, fakeGitHub({ sha: "s", checks: [check(1, "t", "completed", "success")] }).opts);
    expect(ok.state).toBe("success");
    expect(ciFixTask(ok)).toBe("");
  });

  it("rejects a non-PR URL", async () => {
    const error = await ciStatus({ prUrl: "https://github.com/o/r/issues/1" }).catch((e: unknown) => e);
    expect((error as DeliverError).status).toBe(400);
  });
});

describe("rerunFlaky", () => {
  const evidence = "Runner lost connection: 'The hosted runner lost communication with the server'";

  it("requires evidence", async () => {
    const gh = fakeGitHub({ sha: "s", checks: [check(2, "test", "completed", "failure")] });
    const error = await rerunFlaky({ prUrl: PR, checkName: "test", evidence: " " }, gh.opts).catch((e: unknown) => e);
    expect((error as DeliverError).code).toBe("no_evidence");
    expect(gh.calls).toEqual([]);
  });

  it(`re-runs at most ${MAX_RERUNS_PER_HEAD} times per head sha`, async () => {
    const state = { sha: "head1", checks: [check(2, "test", "completed", "failure")] };
    const gh = fakeGitHub(state);
    for (let i = 1; i <= MAX_RERUNS_PER_HEAD; i += 1) {
      expect(await rerunFlaky({ prUrl: PR, checkName: "test", evidence }, gh.opts)).toEqual({
        ok: true,
        attempt: i,
        remaining: MAX_RERUNS_PER_HEAD - i,
      });
    }
    const limited = await rerunFlaky({ prUrl: PR, checkName: "test", evidence }, gh.opts).catch((e: unknown) => e);
    expect((limited as DeliverError).code).toBe("rerun_limit");
    expect((limited as DeliverError).status).toBe(429);
    expect(gh.calls.filter((c) => c.url.endsWith("/actions/jobs/2/rerun"))).toHaveLength(MAX_RERUNS_PER_HEAD);

    state.sha = "head2"; // a new push resets the budget
    expect((await rerunFlaky({ prUrl: PR, checkName: "test", evidence }, gh.opts)).attempt).toBe(1);
  });

  it("only re-runs failed Actions jobs that exist", async () => {
    const gh = fakeGitHub({
      sha: "s",
      checks: [check(1, "ok", "completed", "success"), check(2, "ext", "completed", "failure", false)],
    });
    const codes = await Promise.all(
      ["ok", "ext", "missing"].map((checkName) =>
        rerunFlaky({ prUrl: PR, checkName, evidence }, gh.opts).catch((e: unknown) => (e as DeliverError).code),
      ),
    );
    expect(codes).toEqual(["not_failed", "not_actions", "not_found"]);
  });

  it(`never exceeds ${MAX_RERUNS_PER_HEAD} re-runs when requests race on one head sha`, async () => {
    const gh = fakeGitHub({ sha: "race", checks: [check(2, "test", "completed", "failure")] });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () =>
        rerunFlaky({ prUrl: PR, checkName: "test", evidence }, gh.opts).then(
          (r) => r.attempt,
          (e: unknown) => (e as DeliverError).code,
        ),
      ),
    );
    expect(outcomes.filter((o) => typeof o === "number").sort()).toEqual([1, 2, 3]);
    expect(outcomes.filter((o) => o === "rerun_limit")).toHaveLength(5);
    expect(gh.calls.filter((c) => c.url.endsWith("/actions/jobs/2/rerun"))).toHaveLength(MAX_RERUNS_PER_HEAD);
  });
});

/** `viberon run --deliver` and `viberon review`: parsing, delivery after a headless run, exit codes. */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CliError, main, parseCliArgs } from "@/cli/viberon";
import { deliver, type DeliverOptions } from "@/lib/deliver";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { emptySolveResult, runHeadless } from "@/lib/headless/run";
import { makeTmpRepo, type TmpRepo } from "@/tests/helpers/tmp-repo";

describe("parseCliArgs: deliver and review", () => {
  it("parses run --deliver --issue-url", () => {
    expect(
      parseCliArgs(["run", "--repo", "/r", "--task", "t", "--deliver", "--issue-url", "https://github.com/o/r/issues/1"]),
    ).toMatchObject({ command: "run", deliver: true, issueUrl: "https://github.com/o/r/issues/1" });
    expect(() => parseCliArgs(["run", "--repo", "/r", "--task", "t", "--issue-url", "u"])).toThrow(CliError);
  });

  it("parses review targets", () => {
    expect(parseCliArgs(["review"])).toEqual({ command: "review", repo: ".", base: undefined, pr: undefined, model: undefined, json: false });
    expect(parseCliArgs(["review", "--repo", "/r", "--base", "main", "--json"])).toMatchObject({ repo: "/r", base: "main", json: true });
    expect(parseCliArgs(["review", "--pr", "https://github.com/o/r/pull/2"])).toMatchObject({ pr: "https://github.com/o/r/pull/2" });
    expect(() => parseCliArgs(["review", "--base", "main", "--pr", "x"])).toThrow(CliError);
  });

  it("reviews by default; --no-review turns it off; --review-model picks the reviewer", () => {
    expect(parseCliArgs(["run", "--repo", "/r", "--task", "t"])).toMatchObject({ review: true });
    expect(parseCliArgs(["run", "--repo", "/r", "--task", "t", "--review-model", "m"])).toMatchObject({
      review: true,
      reviewModel: "m",
    });
    expect(parseCliArgs(["run", "--repo", "/r", "--task", "t", "--no-review"])).toMatchObject({ review: false });
    expect(() => parseCliArgs(["run", "--repo", "/r", "--task", "t", "--no-review", "--review-model", "m"])).toThrow(CliError);
  });

  it("review: exit 0 with nothing to review, 2 on a bad base ref", async () => {
    const repo = makeTmpRepo({ "a.txt": "a\n" });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["review", "--repo", repo.root])).toBe(0);
      expect(await main(["review", "--repo", repo.root, "--base", "--evil"])).toBe(2);
      const printed = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(printed).toContain("nothing to review");
      expect(printed).toContain("target.base must be a branch name or commit sha");
    } finally {
      stderr.mockRestore();
      repo.cleanup();
    }
  });
});

describe("runHeadless --deliver", () => {
  let repo: TmpRepo;
  let bare: string;

  beforeEach(() => {
    repo = makeTmpRepo({ "a.txt": "bug\n" });
    repo.git("config", "user.name", "t");
    repo.git("config", "user.email", "t@t");
    bare = mkdtempSync(path.join(os.tmpdir(), "viberon-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    repo.git("remote", "add", "origin", bare);
  });

  afterEach(() => {
    repo.cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  const seen: SolveOptions[] = [];
  const solve = (status: SolveResult["status"]) => async (options: SolveOptions): Promise<SolveResult> => {
    seen.push(options);
    writeFileSync(path.join(options.handle.rootPath!, "a.txt"), "fixed\n");
    return { ...emptySolveResult(status), summary: "Fixed a.", filesChanged: ["a.txt"] };
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main" });
    if (url.includes("/pulls?state=open")) return Response.json([]);
    if (init?.method === "POST" && url.endsWith("/pulls")) return Response.json({ number: 3, html_url: "https://github.com/o/r/pull/3" });
    if (url.endsWith("/comments")) return Response.json({ id: 1, html_url: "https://github.com/o/r/issues/1#c" });
    return Response.json({}, { status: 404 });
  }) as typeof fetch;
  const localDeliver = (options: DeliverOptions) => deliver({ ...options, repo: { owner: "o", repo: "r" }, token: "t", fetchImpl });

  it("delivers a resolved fix and comments on the issue; the exit code is unchanged", async () => {
    const out = await runHeadless(
      {
        repo: repo.root,
        task: "Fix the bug in a",
        noGate: true,
        deliver: true,
        issueUrl: "https://github.com/o/r/issues/1",
        review: true,
        reviewModel: "cheap",
      },
      {
        solve: solve("resolved"),
        deliver: localDeliver,
        reportOnIssue: (input) => import("@/lib/deliver").then((m) => m.reportOnIssue(input, { token: "t", fetchImpl })),
      },
    );
    expect(out.exitCode).toBe(0);
    expect(seen.at(-1)).toMatchObject({ review: true, reviewModel: "cheap" });
    expect(out.result.delivery).toMatchObject({
      branch: "viberon/fix-the-bug-in-a",
      prUrl: "https://github.com/o/r/pull/3",
      commentUrl: "https://github.com/o/r/issues/1#c",
    });
    const pushed = execFileSync("git", ["--git-dir", bare, "show", "viberon/fix-the-bug-in-a:a.txt"], { encoding: "utf8" });
    expect(pushed).toBe("fixed\n");
  });

  it("does not deliver an unproven fix and keeps its exit code", async () => {
    const deliverSpy = vi.fn(localDeliver);
    const out = await runHeadless(
      { repo: repo.root, task: "Fix", noGate: true, deliver: true },
      { solve: solve("failed"), deliver: deliverSpy },
    );
    expect(out.exitCode).toBe(1);
    expect(out.result.delivery).toEqual({ error: expect.stringContaining("only a verified (resolved) fix is delivered") });
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});

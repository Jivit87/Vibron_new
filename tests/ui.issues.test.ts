import { describe, expect, it } from "vitest";

import {
  canFix,
  clampInterval,
  ERROR_TEXT,
  issueStatus,
  isAllIssuesFixRequest,
  issuePromptRepo,
  issuesError,
  normalizeFix,
  normalizeIssueRow,
  normalizeIssues,
  normalizeWatch,
  pollInterval,
  POLL_ACTIVE_MS,
  POLL_IDLE_MS,
  type IssueRow,
} from "@/lib/client/issues";

const row = (task: IssueRow["task"]): IssueRow => ({
  number: 1,
  title: "t",
  url: "",
  labels: [],
  author: null,
  comments: 0,
  updatedAt: 0,
  task,
});

describe("issues reader", () => {
  it("recognizes a prompt to fix every issue from either agent mode", () => {
    expect(isAllIssuesFixRequest("Get the issues of the repo on GitHub and fix them all, then raise a PR")).toBe(true);
    expect(isAllIssuesFixRequest("Fix every GitHub issue")).toBe(true);
    expect(isAllIssuesFixRequest("Explain GitHub issues to me")).toBe(false);
    expect(issuePromptRepo("Fix all issues in https://github.com/acme/widgets.git and open a PR"))
      .toBe("https://github.com/acme/widgets");
    expect(issuePromptRepo("Fix all issues in this repo")).toBeNull();
    expect(issuePromptRepo("Fix every issue in repo acme/widgets"))
      .toBe("acme/widgets");
  });
  it("reads the plan's list shape", () => {
    const data = normalizeIssues({
      repo: { owner: "acme", repo: "textkit" },
      issues: [
        {
          number: 12,
          title: " Crash ",
          url: "https://github.com/acme/textkit/issues/12",
          labels: ["bug", "viberon"],
          author: "jdoe",
          comments: 3,
          updatedAt: "2026-09-01T00:00:00Z",
          task: { id: "t1", state: "running" },
        },
        { title: "no number" },
      ],
      watch: { enabled: true, label: "fixme", intervalMinutes: 30, lastCheckedAt: 1_700_000_000, handled: 4 },
    });
    expect(data.repo).toEqual({ owner: "acme", repo: "textkit" });
    expect(data.issues).toHaveLength(1);
    expect(data.issues[0]).toMatchObject({
      number: 12,
      title: "Crash",
      labels: ["bug", "viberon"],
      author: "jdoe",
      comments: 3,
      updatedAt: Date.parse("2026-09-01T00:00:00Z"),
      task: { id: "t1", state: "running" },
    });
    expect(data.watch).toMatchObject({ enabled: true, label: "fixme", intervalMinutes: 30, lastCheckedAt: 1_700_000_000_000, handled: 4 });
  });

  it("tolerates GitHub-style aliases", () => {
    const r = normalizeIssueRow({
      number: "7",
      title: "x",
      html_url: "https://github.com/a/b/issues/7",
      labels: [{ name: "bug" }, "docs", { color: "fff" }],
      user: { login: "octo" },
      comments: [{}, {}],
      updated_at: "2026-01-01T00:00:00Z",
      task: { id: 5, status: "completed", result: { prUrl: "https://github.com/a/b/pull/9" } },
    });
    expect(r).toMatchObject({
      number: 7,
      url: "https://github.com/a/b/issues/7",
      labels: ["bug", "docs"],
      author: "octo",
      comments: 2,
      task: { id: "5", state: "done", prUrl: "https://github.com/a/b/pull/9" },
    });
    expect(normalizeIssues({ repo: "a/b", issues: [] }).repo).toEqual({ owner: "a", repo: "b" });
    expect(normalizeIssues(null)).toEqual({ repo: null, issues: [], watch: null });
  });

  it("defaults and clamps the watch config", () => {
    expect(normalizeWatch({})).toEqual({ enabled: false, label: "viberon", intervalMinutes: 15, lastCheckedAt: undefined, lastError: undefined, handled: 0 });
    expect(normalizeWatch({ watch: { enabled: true, intervalMinutes: 1, lastError: "403" } })).toMatchObject({ enabled: true, intervalMinutes: 5, lastError: "403" });
    expect(clampInterval(99999)).toBe(1440);
    expect(clampInterval("60")).toBe(60);
    expect(clampInterval("abc")).toBe(15);
  });

  it("reads the fix response with skipped reasons", () => {
    const fix = normalizeFix(
      { tasks: [{ id: "t9", state: "queued", task: "Fix #3" }], skipped: [{ number: 4, reason: "already has a pull request" }, { number: 5 }] },
      200,
    );
    expect(fix.ok).toBe(true);
    expect(fix.tasks.map((t) => t.id)).toEqual(["t9"]);
    expect(fix.skipped).toEqual([
      { number: 4, reason: "already has a pull request" },
      { number: 5, reason: "skipped" },
    ]);
    const bad = normalizeFix({ error: "dirty", code: "no_folder" }, 400);
    expect(bad.ok).toBe(false);
    expect(bad.error?.kind).toBe("no_folder");
  });
});

describe("issues errors", () => {
  it("maps codes to clear messages", () => {
    expect(issuesError({ error: "x", code: "no_github_remote" }, 400)).toEqual({ kind: "no_github_remote", message: ERROR_TEXT.no_github_remote });
    expect(issuesError({ error: "x", code: "no_folder" }, 400).message).toBe("Open a local folder or clone a repository first.");
    expect(issuesError({ error: "GitHub GET /repos/a/b/issues → 401: Bad credentials. Check the GitHub token in Settings → Integrations." }, 502).kind).toBe("token");
    expect(issuesError({ code: "no_token" }, 400).kind).toBe("token");
    expect(issuesError(null, 404).kind).toBe("missing");
    expect(issuesError({ error: "rate limited" }, 502)).toEqual({ kind: "other", message: "rate limited" });
  });
});

describe("issue status", () => {
  it("maps a task to the row status", () => {
    expect(issueStatus(null).kind).toBe("none");
    expect(issueStatus({ id: "a", state: "queued" }).label).toBe("queued");
    expect(issueStatus({ id: "a", state: "running" }).kind).toBe("running");
    expect(issueStatus({ id: "a", state: "done", prUrl: "https://github.com/a/b/pull/1" }).kind).toBe("done");
    expect(issueStatus({ id: "a", state: "failed", error: "No proof" })).toEqual({ kind: "failed", label: "failed", detail: "No proof" });
    expect(issueStatus({ id: "a", state: "done", note: "unproven, kept local" })).toEqual({
      kind: "not_delivered",
      label: "not delivered",
      detail: "unproven, kept local",
    });
  });

  it("decides fixability and the poll interval", () => {
    expect(canFix(row(null))).toBe(true);
    expect(canFix(row({ id: "a", state: "failed" }))).toBe(true);
    expect(canFix(row({ id: "a", state: "done" }))).toBe(true);
    expect(canFix(row({ id: "a", state: "running" }))).toBe(false);
    expect(canFix(row({ id: "a", state: "done", prUrl: "u" }))).toBe(false);
    expect(pollInterval([row(null), row({ id: "a", state: "queued" })])).toBe(POLL_ACTIVE_MS);
    expect(pollInterval([row({ id: "a", state: "done", prUrl: "u" })])).toBe(POLL_IDLE_MS);
    expect(pollInterval(null)).toBe(POLL_IDLE_MS);
  });
});

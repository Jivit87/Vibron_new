import { describe, expect, it } from "vitest";

import {
  applySuggestion,
  findingsForPath,
  isPrUrl,
  normalizeDescribe,
  normalizeFinding,
  normalizeLearn,
  normalizeReview,
  normalizeSuggestions,
} from "@/lib/client/review";
import {
  batchIssueElapsedMs,
  batchIssueTotals,
  batchTimingPct,
  branchError,
  branchSlug,
  checkState,
  ciFailureTask,
  normalizeBatchIssueResult,
  normalizeBatchIssueStatus,
  normalizeCi,
  normalizeDeliver,
  normalizeRerun,
  normalizeTask,
  normalizeTasks,
  shortRef,
  taskTitle,
} from "@/lib/client/deliver";
import { initialDraft } from "@/store/deliver";
import { suggestionKey } from "@/store/review";

describe("review reader", () => {
  it("reads the plan's Review shape, wrapped or bare, sorted by severity", () => {
    const review = {
      summary: "Adds a hook.",
      effort: 3,
      findings: [
        { file: "a.ts", line: 4, severity: "low", title: "Nit", detail: "x" },
        { file: "b.ts", line: 9, severity: "high", title: "Crash", detail: "y" },
      ],
      security: null,
      tests: "missing",
    };
    for (const body of [review, { review }, { result: review }, { result: { review } }]) {
      const r = normalizeReview(body)!;
      expect(r.summary).toBe("Adds a hook.");
      expect(r.effort).toBe(3);
      expect(r.tests).toBe("missing");
      expect(r.findings.map((f) => f.title)).toEqual(["Crash", "Nit"]);
    }
  });

  it("tolerates aliases and bad rows", () => {
    expect(normalizeFinding({ path: "src/x.ts:12", severity: "Critical", message: "Boom", description: "d" })).toEqual({
      file: "src/x.ts",
      line: 12,
      severity: "high",
      title: "Boom",
      detail: "d",
    });
    expect(normalizeFinding({ file: "a", severity: "warning", title: "t", line: "0" })?.line).toBeUndefined();
    expect(normalizeFinding({ file: "a" })).toBeNull();
    expect(normalizeReview({ issues: [{ title: "t", level: "medium" }, 3, null] })?.findings).toHaveLength(1);
    expect(normalizeReview(null)).toBeNull();
    expect(normalizeReview({ foo: 1 })).toBeNull();
  });

  it("drops 'none' security, clamps effort, reads omitted files", () => {
    const r = normalizeReview({ summary: "s", findings: [], security: "None.", effort: 9, omitted: ["lock.json", 3] })!;
    expect(r.security).toBeNull();
    expect(r.effort).toBe(5);
    expect(r.omitted).toEqual(["lock.json"]);
    expect(normalizeReview({ summary: "s", findings: [], security: "Token logged" })?.security).toBe("Token logged");
  });

  it("reads describe and learn", () => {
    expect(normalizeDescribe({ title: "Fix x", body: "b", type: "bug" })).toEqual({ title: "Fix x", body: "b", type: "bug" });
    expect(normalizeDescribe({ describe: { title: "T", description: "D" } })).toEqual({ title: "T", body: "D", type: undefined });
    expect(normalizeDescribe({ body: "no title" })).toBeNull();
    expect(normalizeLearn({ notes: [{ title: "Early returns" }, "No default exports"] })).toEqual({
      count: 2,
      notes: ["Early returns", "No default exports"],
    });
    expect(normalizeLearn({ written: 5 }).count).toBe(5);
  });

  it("reads suggestions (snake_case too), sorted by score", () => {
    const list = normalizeSuggestions({
      suggestions: [
        { file: "a.ts", startLine: 2, endLine: 3, existing: "x", improved: "y", why: "w", score: 7 },
        { relevant_file: "b.ts", start_line: 5, existing_code: "p", improved_code: "q", summary: "s", score: "9" },
        { file: "c.ts", existing: "", improved: "z" },
      ],
    });
    expect(list.map((s) => s.file)).toEqual(["b.ts", "a.ts"]);
    expect(list[0]).toMatchObject({ startLine: 5, endLine: 5, score: 9, why: "s" });
    expect(normalizeSuggestions([{ file: "a", existing: "e", improved: "i" }])).toHaveLength(1);
  });

  it("matches findings to a path loosely", () => {
    const findings = [
      { file: "./src/a.ts", severity: "low" as const, title: "1", detail: "" },
      { file: "b/src/a.ts", severity: "low" as const, title: "2", detail: "" },
      { file: "src/b.ts", severity: "low" as const, title: "3", detail: "" },
    ];
    expect(findingsForPath(findings, "src/a.ts").map((f) => f.title)).toEqual(["1", "2"]);
  });

  it("recognises PR URLs", () => {
    expect(isPrUrl("https://github.com/a/b/pull/12")).toBe(true);
    expect(isPrUrl(" https://github.com/a/b/pull/12/files ")).toBe(true);
    expect(isPrUrl("https://github.com/a/b/issues/12")).toBe(false);
  });
});

describe("applySuggestion", () => {
  const source = "a\nconst x = 1;\nconst y = 2;\nb\n";

  it("replaces at the stated lines, ignoring trailing whitespace", () => {
    const r = applySuggestion(source, { startLine: 2, endLine: 3, existing: "const x = 1;  \nconst y = 2;", improved: "const xy = [1, 2];" });
    expect(r).toEqual({ ok: true, source: "a\nconst xy = [1, 2];\nb\n" });
  });

  it("follows the snippet when lines shifted above it", () => {
    const r = applySuggestion("new\n" + source, { startLine: 2, endLine: 2, existing: "const y = 2;", improved: "const y = 3;" });
    expect(r.ok && r.source).toBe("new\na\nconst x = 1;\nconst y = 3;\nb\n");
  });

  it("is out of date when the code is gone or ambiguous", () => {
    expect(applySuggestion(source, { startLine: 2, endLine: 2, existing: "const z = 9;", improved: "q" })).toEqual({ ok: false, reason: "out_of_date" });
    expect(applySuggestion("x\nx\n", { startLine: 0, endLine: 0, existing: "x", improved: "y" })).toEqual({ ok: false, reason: "out_of_date" });
    expect(applySuggestion(source, { startLine: 1, endLine: 1, existing: "", improved: "y" }).ok).toBe(false);
  });

  it("handles CRLF files", () => {
    const r = applySuggestion("a\r\nb\r\n", { startLine: 2, endLine: 2, existing: "b", improved: "c" });
    expect(r).toEqual({ ok: true, source: "a\nc\n" });
  });

  it("keys suggestions stably", () => {
    const s = { file: "a.ts", startLine: 2, existing: "x" };
    expect(suggestionKey(s)).toBe(suggestionKey({ ...s }));
    expect(suggestionKey(s)).not.toBe(suggestionKey({ ...s, startLine: 3 }));
  });
});

describe("branch names", () => {
  it("slugs the task title under viberon/", () => {
    expect(branchSlug("Fix slugify dropping accented letters")).toBe("viberon/fix-slugify-dropping-accented-letters");
    expect(branchSlug("Crème brûlée: `slugify()` breaks!")).toBe("viberon/creme-brulee-slugify-breaks");
    expect(branchSlug("   ")).toBe("viberon/fix");
  });

  it("stays within 48 characters and cuts on a word", () => {
    const b = branchSlug("Windows path separators are mangled when the CLI writes the output file");
    expect(b.length).toBeLessThanOrEqual(48);
    expect(b.startsWith("viberon/windows-path-separators")).toBe(true);
    expect(b.endsWith("-")).toBe(false);
  });

  it("takes the title from an issue prompt", () => {
    expect(taskTitle("Fix this issue: Crash on empty input\n\nhttps://github.com/a/b/issues/3\n\nbody")).toBe("Crash on empty input");
    expect(initialDraft("Fix this issue: Crash on empty input\n\nhttps://x").branch).toBe("viberon/crash-on-empty-input");
    expect(initialDraft("x").draft).toBe(true);
  });

  it("validates branch names", () => {
    expect(branchError("viberon/ok-name")).toBeNull();
    expect(branchError("")).not.toBeNull();
    expect(branchError("has space")).not.toBeNull();
    expect(branchError("a..b")).not.toBeNull();
    expect(branchError("x.lock")).not.toBeNull();
  });
});

describe("deliver reader", () => {
  it("reads success", () => {
    expect(normalizeDeliver({ branch: "viberon/x", commit: "abc", prUrl: "https://github.com/a/b/pull/4", prNumber: 4 }, 200)).toEqual({
      ok: true,
      branch: "viberon/x",
      commit: "abc",
      prUrl: "https://github.com/a/b/pull/4",
      prNumber: 4,
      updated: false,
    });
    expect(normalizeDeliver({ result: { html_url: "u", number: 9 } }, 201)).toMatchObject({ ok: true, prUrl: "u", prNumber: 9 });
  });

  it("keeps the exact error and detects a confirmation request", () => {
    const msg = "Refusing: .github/workflows/ci.yml changed";
    expect(normalizeDeliver({ error: msg }, 409)).toEqual({ ok: false, error: msg, needsConfirm: true, files: [] });
    expect(normalizeDeliver({ error: "x", needsConfirmation: true, workflowFiles: [".github/workflows/a.yml"] }, 400)).toMatchObject({
      needsConfirm: true,
      files: [".github/workflows/a.yml"],
    });
    expect(normalizeDeliver({ error: "push rejected" }, 500)).toMatchObject({ ok: false, error: "push rejected", needsConfirm: false });
    expect(normalizeDeliver(null, 404).error).toMatch(/not available/);
  });
});

describe("CI reader", () => {
  it("maps conclusions", () => {
    expect(checkState("success")).toBe("success");
    expect(checkState("timed_out")).toBe("failure");
    expect(checkState(null, "in_progress")).toBe("pending");
    expect(checkState(null, "completed")).toBe("success");
    expect(checkState("skipped")).toBe("skipped");
  });

  it("reads the plan's shape and derives the state when missing", () => {
    const ci = normalizeCi({
      headSha: "abc1234",
      checks: [
        { name: "lint", conclusion: "success", url: "u1" },
        { name: "test", conclusion: "failure", url: "u2", logExcerpt: "FAILED t" },
      ],
    })!;
    expect(ci.state).toBe("failure");
    expect(ci.checks[1]).toMatchObject({ state: "failure", logExcerpt: "FAILED t", url: "u2" });
    expect(normalizeCi({ state: "pending", checks: [] })?.state).toBe("pending");
    expect(normalizeCi({ check_runs: [{ name: "a", status: "queued", html_url: "h" }] })?.checks[0]).toMatchObject({ state: "pending", url: "h" });
    expect(normalizeCi({ foo: 1 })).toBeNull();
  });

  it("builds a fix task from the failures", () => {
    const ci = normalizeCi({ headSha: "abcdef1234", checks: [{ name: "test", conclusion: "failure", logExcerpt: "FAILED x" }, { name: "lint", conclusion: "success" }] })!;
    const task = ciFailureTask(ci, "https://github.com/a/b/pull/4");
    expect(task).toContain("https://github.com/a/b/pull/4 (head abcdef1)");
    expect(task).toContain('Check "test" (failure):\nFAILED x');
    expect(task).not.toContain("lint");
  });

  it("reads re-run counts and limits", () => {
    expect(normalizeRerun({ ok: true, reruns: 2, limit: 3 }, 200)).toEqual({ ok: true, error: undefined, reruns: 2, limit: 3 });
    expect(normalizeRerun({ remaining: 1, max: 3 }, 200)).toMatchObject({ ok: true, reruns: 2, limit: 3 });
    expect(normalizeRerun({ error: "Re-run limit reached (3 per head sha)" }, 429)).toMatchObject({ ok: false, error: "Re-run limit reached (3 per head sha)" });
  });
});

describe("tasks reader", () => {
  it("normalizes states, times and PR links", () => {
    const t = normalizeTask({ id: 7, kind: "fix", task: "Fix x", source: "cli", status: "completed", createdAt: "2026-09-27T10:00:00Z", result: { prUrl: "p" } })!;
    expect(t).toMatchObject({ id: "7", state: "done", source: "cli", prUrl: "p", createdAt: Date.parse("2026-09-27T10:00:00Z") });
    expect(normalizeTask({ id: "a", state: "canceled", createdAt: 1_700_000_000 })).toMatchObject({ state: "cancelled", createdAt: 1_700_000_000_000 });
    expect(normalizeTask({ task: "no id" })).toBeNull();
  });

  it("orders running, then queued FIFO, then finished newest first", () => {
    const rows = normalizeTasks({
      tasks: [
        { id: "d1", state: "done", createdAt: 1, finishedAt: 10 },
        { id: "q2", state: "queued", createdAt: 5 },
        { id: "f1", state: "failed", createdAt: 2, finishedAt: 20 },
        { id: "r1", state: "running", createdAt: 3 },
        { id: "q1", state: "queued", createdAt: 4 },
      ],
    });
    expect(rows.map((r) => r.id)).toEqual(["r1", "q1", "q2", "f1", "d1"]);
    expect(normalizeTasks([{ id: "x" }])[0].state).toBe("queued");
    expect(normalizeTasks({ nope: true })).toEqual([]);
  });

  it("shortens GitHub refs", () => {
    expect(shortRef("https://github.com/acme/textkit/pull/42")).toBe("acme/textkit#42");
    expect(shortRef("https://github.com/acme/textkit/issues/7")).toBe("acme/textkit#7");
  });
});

describe("batch issue results", () => {
  it("normalizes a rich issue row, defensively", () => {
    const row = normalizeBatchIssueResult({
      url: "https://github.com/acme/textkit/issues/52",
      number: 52,
      title: "slugify() drops accents",
      status: "verified",
      startedAt: "2026-09-27T10:00:00Z",
      finishedAt: "2026-09-27T10:00:08Z",
      timing: { modelMs: 4_200, toolsMs: 2_600, proofMs: 700 },
      usage: { input: 5_400, output: 380, cached: 2_100, calls: 1 },
      prUrl: "https://github.com/acme/textkit/pull/70",
      fastPath: { used: true, calls: 1, accepted: true },
    })!;
    expect(row).toMatchObject({
      url: "https://github.com/acme/textkit/issues/52",
      number: 52,
      status: "verified",
      timing: { modelMs: 4_200, toolsMs: 2_600, proofMs: 700 },
      usage: { input: 5_400, output: 380, cached: 2_100, calls: 1 },
      fastPath: { used: true, calls: 1, accepted: true },
    });
    expect(normalizeBatchIssueResult({ number: 1 })).toBeNull();
  });

  it("maps every status alias, and falls back to the task's own state", () => {
    expect(normalizeBatchIssueStatus("resolved")).toBe("verified");
    expect(normalizeBatchIssueStatus("gave_up")).toBe("unproven");
    expect(normalizeBatchIssueStatus("canceled")).toBe("cancelled");
    expect(normalizeBatchIssueStatus(undefined, "running")).toBe("running");
    expect(normalizeBatchIssueStatus(undefined, "done")).toBe("verified");
  });

  it("ignores empty timing and usage instead of a zeroed object", () => {
    const row = normalizeBatchIssueResult({ url: "u", status: "running", timing: { modelMs: 0, toolsMs: 0, proofMs: 0 }, usage: {} })!;
    expect(row.timing).toBeUndefined();
    expect(row.usage).toBeUndefined();
  });

  it("computes elapsed time and a fallback bar for untimed rows", () => {
    expect(batchIssueElapsedMs({ startedAt: 1_000, finishedAt: 4_000 }, 9_999)).toBe(3_000);
    expect(batchIssueElapsedMs({ startedAt: 1_000 }, 4_000)).toBe(3_000);
    expect(batchIssueElapsedMs({}, 4_000)).toBe(0);
    expect(batchTimingPct(undefined)).toEqual({ modelPct: 0, toolsPct: 0, proofPct: 0 });
    expect(batchTimingPct({ modelMs: 3, toolsMs: 1, proofMs: 0 })).toEqual({ modelPct: 75, toolsPct: 25, proofPct: 0 });
  });

  it("sums tokens and calls across a batch's rows", () => {
    const rows = [
      { url: "a", status: "verified" as const, usage: { input: 100, output: 10, cached: 20, calls: 1 } },
      { url: "b", status: "running" as const, usage: { input: 50, output: 0, cached: 0, calls: 2 } },
      { url: "c", status: "queued" as const },
    ];
    expect(batchIssueTotals(rows)).toEqual({ tokens: 180, calls: 3 });
  });

  it("carries a batch task's issueResults through normalizeTask", () => {
    const t = normalizeTask({
      id: "t1",
      state: "running",
      model: "claude-sonnet-5",
      issueResults: [
        { url: "https://github.com/acme/textkit/issues/1", status: "verified" },
        { number: 1 },
      ],
    })!;
    expect(t.model).toBe("claude-sonnet-5");
    expect(t.issueResults).toHaveLength(1);
    expect(t.issueResults?.[0].status).toBe("verified");
  });
});

describe("batch rows from the server's issueProgress", () => {
  it("reads issueProgress rows, maps boolean fastPath and fills the combined PR for fixed issues", async () => {
    const { normalizeTask } = await import("@/lib/client/deliver");
    const row = normalizeTask({
      id: "t1",
      kind: "fix",
      repoKey: "r",
      state: "done",
      prUrl: "https://github.com/o/r/pull/9",
      issueResults: [{ url: "https://github.com/o/r/issues/1", fixed: true }, { url: "https://github.com/o/r/issues/2", fixed: false }],
      issueProgress: [
        { url: "https://github.com/o/r/issues/1", number: 1, title: "a", status: "verified", fastPath: true, usage: { input: 1000, output: 200, cached: 0, calls: 1 }, timing: { modelMs: 900, toolsMs: 0, proofMs: 300 } },
        { url: "https://github.com/o/r/issues/2", number: 2, title: "b", status: "unproven", detail: "gave up" },
      ],
    });
    const rows = row?.issueResults ?? [];
    expect(rows.map((r) => r.status)).toEqual(["verified", "unproven"]);
    expect(rows[0]?.fastPath).toEqual({ used: true, calls: 1, accepted: true });
    expect(rows[0]?.prUrl).toBe("https://github.com/o/r/pull/9");
    expect(rows[1]?.prUrl).toBeUndefined();
    expect(rows[0]?.usage?.calls).toBe(1);
  });
});

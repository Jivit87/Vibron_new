/**
 * /api/runs: run history, one run, its report, and the stop-everything button
 * (ported from Pramana Studio's /api/runs, /api/runs/:id/report and stop_all).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listRuns } from "@/app/api/runs/route";
import { GET as getRunRoute } from "@/app/api/runs/[id]/route";
import { GET as getReport } from "@/app/api/runs/[id]/report/route";
import { POST as stopAll } from "@/app/api/runs/stop/route";
import { createRun, getRun, resetRunsForTests } from "@/lib/harness/runs";
import type { SolveResult } from "@/lib/harness/solve-types";
import { resetMemoryStoreForTests } from "@/lib/store";
import { TaskQueue, type Task, type TaskRunner } from "@/lib/tasks";

const G = globalThis as { __viberonTaskQueue?: TaskQueue; __viberonTaskQueueManaged?: TaskQueue };

function solveResult(status: SolveResult["status"] = "resolved"): SolveResult {
  return {
    status,
    summary: "Fixed the off-by-one in add().",
    diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n",
    filesChanged: ["src/a.ts"],
    gate: {
      enabled: true,
      command: "npm test",
      baseline: null,
      final: null,
      newFailures: [],
      fixed: ["adds"],
      rejections: 0,
      ranAfterLastEdit: true,
      reason: "tests pass",
    },
    recovery: { checkpoints: 1, rollbacks: 0, restoredBest: false, stuckEvents: 0, failureClasses: {} },
    metrics: {
      modelCalls: 3,
      toolCalls: 5,
      toolCallsByName: {},
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      cacheHitRate: 0.5,
      costUsd: 0.01,
      uncachedCostUsd: 0.02,
      contextSentTokens: 1200,
      contextSavedTokens: 4000,
      compactions: 0,
      verifyRuns: 1,
      verifyMs: 1000,
      durationMs: 4200,
    },
  };
}

/** A runner that finishes at once with a SolveResult, or blocks until aborted for "block" tasks. */
const fix: TaskRunner = (task, { signal }) =>
  task.task.startsWith("block")
    ? new Promise((resolve) => signal.addEventListener("abort", () => resolve({}), { once: true }))
    : Promise.resolve({ result: solveResult() });
const review: TaskRunner = async () => ({
  result: {
    summary: "Looks fine.",
    effort: 2,
    findings: [{ file: "src/a.ts", line: 3, severity: "minor", title: "Unused var", detail: "x is never read" }],
    security: null,
    tests: "adequate",
  } as unknown as Task["result"],
});

let queue: TaskQueue;

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timed out");
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetMemoryStoreForTests();
  resetRunsForTests();
  queue = new TaskQueue({ fix, review }, { storeKey: `tasks:runs-api:${Date.now()}:${Math.random()}`, cancelGraceMs: 50 });
  G.__viberonTaskQueue = queue; // unmanaged: getTaskQueue() returns it as-is
});

afterEach(async () => {
  resetRunsForTests();
  delete G.__viberonTaskQueue;
});

describe("GET /api/runs", () => {
  it("lists past runs newest first with verdict, tokens and wall time, without the full result", async () => {
    const a = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "fix add\nmore detail", source: "api" });
    await queue.idle();
    const b = await queue.enqueue({ kind: "review", repoKey: "r1", task: "review it", source: "api" });
    await queue.idle();
    await queue.enqueue({ kind: "fix", repoKey: "r2", task: "other repo", source: "api" });
    await queue.idle();

    const res = await listRuns(new Request("http://x/api/runs?repoKey=r1"));
    const { runs } = (await res.json()) as { runs: Record<string, unknown>[] };
    expect(runs.map((r) => r.id)).toEqual([b.id, a.id]);
    const fixRow = runs[1]!;
    expect(fixRow).toMatchObject({ kind: "fix", title: "fix add", status: "done", verdict: "resolved", tokens: 2300, hasReport: true });
    expect(typeof fixRow.wallMs).toBe("number");
    expect(fixRow).not.toHaveProperty("result");
    expect(runs[0]).toMatchObject({ kind: "review", verdict: "reviewed" });

    const all = (await (await listRuns(new Request("http://x/api/runs?limit=1"))).json()) as { runs: unknown[] };
    expect(all.runs).toHaveLength(1);
  });

  it("includes live agent runs and filters by status", async () => {
    const run = createRun("r1", () => undefined);
    const { runs } = (await (await listRuns(new Request("http://x/api/runs?repoKey=r1&status=running"))).json()) as {
      runs: Record<string, unknown>[];
    };
    expect(runs).toEqual([expect.objectContaining({ id: run.runId, kind: "agent", status: "running" })]);
  });

  it("is compact: a history row is far smaller than the full run", async () => {
    const t = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "fix add", source: "api" });
    await queue.idle();
    const row = await (await listRuns(new Request("http://x/api/runs?repoKey=r1"))).text();
    const full = await (await getRunRoute(new Request("http://x"), ctx(t.id))).text();
    expect(row.length).toBeLessThan(full.length);
  });
});

describe("GET /api/runs/:id", () => {
  it("returns the full run or 404", async () => {
    const t = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "fix add", source: "api" });
    await queue.idle();
    const body = (await (await getRunRoute(new Request("http://x"), ctx(t.id))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: t.id, task: "fix add", verdict: "resolved" });
    expect((body.result as SolveResult).diff).toContain("+b");
    expect((await getRunRoute(new Request("http://x"), ctx("nope"))).status).toBe(404);
  });
});

describe("GET /api/runs/:id/report", () => {
  it("renders the Markdown report of a finished fix", async () => {
    const t = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "fix add", source: "api" });
    await queue.idle();
    const res = await getReport(new Request("http://x"), ctx(t.id));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const md = await res.text();
    expect(md).toContain("# Viberon run: fix add");
    expect(md).toContain("npm test");
    const json = (await (await getReport(new Request("http://x?format=json"), ctx(t.id))).json()) as { markdown: string };
    expect(json.markdown).toBe(md);
  });

  it("renders a review's findings", async () => {
    const t = await queue.enqueue({ kind: "review", repoKey: "r1", task: "review it", source: "api" });
    await queue.idle();
    const md = await (await getReport(new Request("http://x"), ctx(t.id))).text();
    expect(md).toContain("Unused var");
    expect(md).toContain("`src/a.ts:3`");
  });

  it("404s for unknown runs and runs still in progress", async () => {
    expect((await getReport(new Request("http://x"), ctx("nope"))).status).toBe(404);
    const t = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "block", source: "api" });
    const res = await getReport(new Request("http://x"), ctx(t.id));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("report not ready");
    await queue.cancel(t.id);
    await queue.idle();
  });
});

describe("POST /api/runs/stop", () => {
  it("cancels every running and queued task and every agent run of the repo, and nothing else", async () => {
    const running = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "block 1", source: "api" });
    const queued = await queue.enqueue({ kind: "fix", repoKey: "r1", task: "block 2", source: "api" });
    const other = await queue.enqueue({ kind: "fix", repoKey: "r2", task: "block 3", source: "api" });
    await until(async () => (await queue.get(running.id))?.state === "running");
    const agent = createRun("r1", () => undefined);
    const otherAgent = createRun("r2", () => undefined);

    const res = await stopAll(new Request("http://x", { method: "POST", body: JSON.stringify({ repoKey: "r1" }) }));
    const body = (await res.json()) as { tasks: number; agentRuns: number; taskIds: string[]; runIds: string[] };
    expect(body.tasks).toBe(2);
    expect(body.taskIds.sort()).toEqual([running.id, queued.id].sort());
    expect(body.runIds).toEqual([agent.runId]);
    expect(getRun(agent.runId)?.signal.aborted).toBe(true);
    expect(getRun(otherAgent.runId)?.signal.aborted).toBe(false);

    await until(async () => (await queue.get(running.id))?.state === "cancelled");
    expect((await queue.get(queued.id))?.state).toBe("cancelled");
    expect((await queue.get(other.id))?.state).not.toBe("cancelled");

    // A second press finds nothing left to stop in r1.
    const again = (await (await stopAll(new Request("http://x", { method: "POST", body: JSON.stringify({ repoKey: "r1" }) }))).json()) as {
      agentRuns: number;
    };
    expect(again.agentRuns).toBe(0);

    // No repoKey: stops everything everywhere.
    const everywhere = (await (await stopAll(new Request("http://x", { method: "POST" }))).json()) as {
      taskIds: string[];
      runIds: string[];
    };
    expect(everywhere.taskIds).toContain(other.id);
    expect(everywhere.runIds).toEqual([otherAgent.runId]);
    await queue.idle();
  });

  it("rejects bad bodies", async () => {
    expect((await stopAll(new Request("http://x", { method: "POST", body: "{" }))).status).toBe(400);
    expect((await stopAll(new Request("http://x", { method: "POST", body: JSON.stringify({ repoKey: 3 }) }))).status).toBe(400);
  });
});

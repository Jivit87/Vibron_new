import { describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import {
  activeTodos,
  createRun,
  findOpenCall,
  pendingApprovals,
  reduceRun,
  type RunState,
} from "@/lib/client/run-reducer";
import { mockScript } from "@/lib/client/mock-run";

let n = 0;
const ctx = { now: 1000, nextId: (p: string) => `${p}_${++n}` };

function fresh(): RunState {
  return createRun({ id: "r", prompt: "p", model: "m", mode: "orchestrated", now: 0 });
}

function fold(events: OrchestrationEvent[], run = fresh()): RunState {
  return events.reduce((r, e) => reduceRun(r, e, ctx), run);
}

const start = (agentId: string): OrchestrationEvent => ({
  type: "agent_start",
  agentId,
  stepId: agentId,
  role: "frontend",
  title: agentId,
  model: "m",
  wave: 0,
});

describe("reduceRun", () => {
  it("records rules and the server run id from run_start", () => {
    const run = fold([
      { type: "run_start", runId: "srv", mode: "single", model: "x", at: 0, rules: [{ path: "AGENTS.md", tokens: 10 }] },
    ]);
    expect(run.id).toBe("srv");
    expect(run.rules).toEqual([{ path: "AGENTS.md", tokens: 10 }]);
  });

  it("pairs tool start/end by callId even when names repeat", () => {
    const run = fold([
      start("a"),
      { type: "agent_tool", agentId: "a", callId: "1", tool: "read_file", args: "x", phase: "start" },
      { type: "agent_tool", agentId: "a", callId: "2", tool: "read_file", args: "y", phase: "start" },
      { type: "agent_tool", agentId: "a", callId: "1", tool: "read_file", args: "x", phase: "end", result: "ok-x", ok: true },
    ]);
    const tools = run.agents[0].tools;
    expect(tools[0]).toMatchObject({ callId: "1", running: false, result: "ok-x" });
    expect(tools[1]).toMatchObject({ callId: "2", running: true });
  });

  it("falls back to newest same-name call without callId", () => {
    expect(
      findOpenCall(
        [
          { tool: "a", args: "", running: true, at: 0 },
          { tool: "a", args: "", running: true, at: 0 },
        ],
        undefined,
        "a",
      ),
    ).toBe(1);
  });

  it("builds a chronological feed, coalescing streamed text", () => {
    const run = fold([
      start("a"),
      { type: "agent_text", agentId: "a", text: "hel" },
      { type: "agent_text", agentId: "a", text: "lo" },
      { type: "agent_tool", agentId: "a", callId: "1", tool: "t", args: "", phase: "start" },
      { type: "agent_retry", agentId: "a", attempt: 1, maxAttempts: 3, delayMs: 500, reason: "529" },
      { type: "compaction", agentId: "a", strategy: "elide", beforeTokens: 10, afterTokens: 5 },
      { type: "agent_text", agentId: "a", text: "again" },
    ]);
    const kinds = run.agents[0].feed.map((f) => f.kind);
    expect(kinds).toEqual(["text", "tool", "retry", "compaction", "text"]);
    expect(run.agents[0].feed[0]).toEqual({ kind: "text", text: "hello" });
    expect(run.retries).toHaveLength(1);
    expect(run.compactions).toHaveLength(1);
  });

  it("creates a lane for events from an unseen agent", () => {
    const run = fold([{ type: "agent_text", agentId: "pending", text: "x" }]);
    expect(run.agents.map((a) => a.id)).toEqual(["pending"]);
  });

  it("replaces todos wholesale per agent", () => {
    const run = fold([
      { type: "todos", agentId: "a", items: [{ id: "1", content: "one", status: "pending" }] },
      { type: "todos", agentId: "a", items: [{ id: "2", content: "two", status: "completed" }] },
    ]);
    expect(run.todos.a).toEqual([{ id: "2", content: "two", status: "completed" }]);
    expect(activeTodos(run)).toHaveLength(1);
  });

  it("tracks approvals through approval_resolved", () => {
    const run = fold([
      start("a"),
      {
        type: "approval_request",
        approvalId: "x",
        agentId: "a",
        kind: "edit",
        title: "Edit a.ts",
        command: "Edit a.ts",
        reason: "r",
        detail: { path: "a.ts", before: "1", after: "2" },
      },
    ]);
    expect(pendingApprovals(run)).toHaveLength(1);
    expect(run.approvals[0].kind).toBe("edit");
    expect(run.agents[0].feed.at(-1)).toEqual({ kind: "approval", approvalId: "x" });
    const resolved = reduceRun(run, { type: "approval_resolved", approvalId: "x", decision: "deny" }, ctx);
    expect(pendingApprovals(resolved)).toHaveLength(0);
    expect(resolved.approvals[0].resolution).toBe("deny");
  });

  it("keeps a plan awaiting approval without starting the run", () => {
    const plan = { summary: "s", steps: [], waves: [] };
    const run = fold([{ type: "plan", plan, awaitingApproval: true }]);
    expect(run.planAwaitingApproval).toBe(true);
    expect(run.status).toBe("planning");
  });

  it("branches on run_done.status and settles pending work", () => {
    const base = fold([
      start("a"),
      { type: "approval_request", approvalId: "x", agentId: "a", command: "ls", reason: "r" },
    ]);
    const cancelled = reduceRun(
      base,
      { type: "run_done", status: "cancelled", summary: "", filesChanged: 0, durationMs: 1, costUsd: 0 },
      ctx,
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.approvals[0].resolution).toBe("cancelled");
    expect(cancelled.agents[0].status).toBe("cancelled");

    const legacy = reduceRun(
      fresh(),
      { type: "run_done", summary: "ok", filesChanged: 0, durationMs: 1, costUsd: 0 },
      ctx,
    );
    expect(legacy.status).toBe("done");
  });

  it("folds the whole mock script without throwing and ends done", () => {
    const events = mockScript({ prompt: "x", interaction: "agent" }).map((s) => s.event);
    const run = fold(events);
    expect(run.status).toBe("done");
    expect(run.changes.length).toBeGreaterThan(0);
    expect(run.agents.every((a) => a.status === "done")).toBe(true);
    const failed = fold(mockScript({ prompt: "please fail", interaction: "agent" }).map((s) => s.event));
    expect(failed.status).toBe("failed");
  });
});

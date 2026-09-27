import { beforeEach, describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { StoredRun } from "@/lib/client/conversations";
import {
  focusFromFile,
  focusFromReceipt,
  focusFromRun,
  focusFromTask,
  focusIsEmpty,
  focusNodes,
  runsTouching,
  tokensFor,
} from "@/lib/client/graph-focus";
import { createRun, evidenceOf, isRunActive, reduceRun, settleRun, todoView, type RunState } from "@/lib/client/run-reducer";
import type { TaskRow } from "@/lib/client/deliver";
import type { IssueRow } from "@/lib/client/issues";
import { emptySummary } from "@/lib/client/usage";
import { issueForTask, issueNumber, prForIssue, taskForIssue } from "@/store/links";
import {
  DEFAULT_SETTINGS,
  finalRunStatus,
  GRAPH_TAB_PATH,
  initialTabs,
  useViberon,
  WELCOME_TAB_PATH,
} from "@/store/viberon";

let n = 0;
const ctx = { now: 1000, nextId: (p: string) => `${p}_${++n}` };

function fold(events: OrchestrationEvent[], run = createRun({ id: "r", prompt: "Fix #2499 batch", model: "m", mode: "single", now: 0 })): RunState {
  return events.reduce((r, e) => reduceRun(r, e, ctx), run);
}

const start = (agentId: string): OrchestrationEvent => ({
  type: "agent_start",
  agentId,
  stepId: agentId,
  role: "backend",
  title: agentId,
  model: "m",
  wave: 0,
});

/** A batch fix mid-flight: a todo list with one item in progress, a running tool and lane. */
function midBatch(): RunState {
  const run = fold([
    start("a"),
    {
      type: "todos",
      agentId: "a",
      items: [
        { id: "1", content: "#2499 reproduce", status: "completed" },
        { id: "2", content: "#2499 patch", status: "in_progress" },
        { id: "3", content: "#2500 reproduce", status: "pending" },
      ],
    },
    { type: "agent_tool", agentId: "a", callId: "c1", tool: "run_tests", args: "", phase: "start" },
  ]);
  // A second lane that never started, and a terminal command still running.
  return {
    ...run,
    agents: [
      {
        ...run.agents[0],
        feed: [...run.agents[0].feed, { kind: "command", command: "pytest", sessionId: "s1", status: "running", exitCode: null }],
      },
      { ...run.agents[0], id: "b", status: "queued", tools: [], feed: [] },
    ],
  };
}

function noSpinners(run: RunState): void {
  expect(isRunActive(run)).toBe(false);
  for (const lane of run.agents) {
    expect(["running", "queued"]).not.toContain(lane.status);
    expect(lane.tools.some((t) => t.running)).toBe(false);
    expect(lane.feed.some((f) => f.kind === "command" && f.status === "running")).toBe(false);
  }
  for (const items of Object.values(run.todos)) {
    expect(items.some((t) => t.status === "in_progress")).toBe(false);
  }
}

describe("stopping a run settles every live indicator", () => {
  it("run_done{cancelled} stops lanes, tools, commands and todos", () => {
    const done = reduceRun(
      midBatch(),
      { type: "run_done", status: "cancelled", summary: "", filesChanged: 0, durationMs: 1, costUsd: 0 },
      ctx,
    );
    expect(done.status).toBe("cancelled");
    noSpinners(done);
    expect(done.agents.map((a) => a.status)).toEqual(["cancelled", "cancelled"]);
    expect(done.todos.a.map((t) => t.status)).toEqual(["completed", "cancelled", "pending"]);
    const command = done.agents[0].feed.find((f) => f.kind === "command");
    expect(command).toMatchObject({ status: "cancelled" });
  });

  it("a finished run closes open work without marking todos stopped", () => {
    const done = settleRun(midBatch(), "done");
    expect(done.agents[0].status).toBe("done");
    expect(done.agents[0].tools.every((t) => !t.running)).toBe(true);
    expect(done.todos.a[1].status).toBe("in_progress");
  });

  it("is idempotent", () => {
    const once = settleRun(midBatch(), "cancelled");
    expect(settleRun(once, "cancelled")).toBe(once);
  });

  it("the store's endRun settles a stream that ended after a cancel (task state cancelled)", () => {
    useViberon.setState({ run: midBatch(), streaming: true, messages: [], conversationRuns: [], runHistory: [], repoKey: "" });
    useViberon.getState().endRun("cancelled");
    const { run, streaming, runHistory } = useViberon.getState();
    expect(streaming).toBe(false);
    expect(run?.status).toBe("cancelled");
    noSpinners(run!);
    expect(runHistory[0].status).toBe("cancelled");
  });

  it("the server's status wins over the transport's guess", () => {
    expect(finalRunStatus("cancelled", "done")).toBe("cancelled");
    expect(finalRunStatus("done", "cancelled")).toBe("done");
    expect(finalRunStatus("running", "cancelled")).toBe("cancelled");
    expect(finalRunStatus("planning", "failed")).toBe("failed");
  });
});

describe("defaults", () => {
  beforeEach(() => {
    useViberon.setState({ settings: DEFAULT_SETTINGS });
  });

  it("a new user starts in Fix", () => {
    expect(DEFAULT_SETTINGS.interaction).toBe("fix");
  });

  it("a user's saved interaction is kept; a reset goes back to Fix", () => {
    const store = useViberon.getState();
    store.setSettings({ interaction: "ask" });
    expect(useViberon.getState().settings.interaction).toBe("ask");
    useViberon.getState().resetSettings();
    expect(useViberon.getState().settings.interaction).toBe("fix");
  });

  it("a workspace opens with Welcome and the graph, graph in front", () => {
    const tabs = initialTabs();
    expect(tabs.tabs.map((t) => t.path)).toEqual([WELCOME_TAB_PATH, GRAPH_TAB_PATH]);
    expect(tabs.activeTabPath).toBe(GRAPH_TAB_PATH);
    useViberon.getState().init({ repoKey: "k", repoLabel: "K" });
    const state = useViberon.getState();
    expect(state.tabs.map((t) => t.path)).toEqual([WELCOME_TAB_PATH, GRAPH_TAB_PATH]);
    expect(state.activeTabPath).toBe(GRAPH_TAB_PATH);
    expect(state.graph).toBeUndefined();
    expect(state.graphFocus).toBeNull();
  });
});

/* ------------------------------ graph focus ------------------------------- */

const graph = {
  nodes: [
    { id: "a.ts#A", file: "src/a.ts" },
    { id: "a.ts#A2", file: "src/a.ts" },
    { id: "b.ts#B", file: "src/b.ts" },
    { id: "c.ts#C", file: "src/c.ts" },
  ],
} as unknown as Parameters<typeof focusNodes>[1];

function runWithLedger(): RunState {
  return fold([
    start("a"),
    {
      type: "ledger",
      ledger: {
        sentTokens: 900,
        dedupedTokens: 0,
        baselineTokens: 2000,
        savedTokens: 1100,
        savedPercent: 55,
        events: [{ at: 1, source: "graph_slice", label: "q", tokens: 900, deduped: false, paths: ["src/b.ts"], nodeIds: ["c.ts#C"] }],
        files: [{ path: "src/b.ts", sentTokens: 600, dedupedTokens: 0, reads: 2 }],
        nodes: [{ id: "c.ts#C", sentTokens: 300, dedupedTokens: 0, reads: 1 }],
      },
      tokensIn: 900,
      tokensOut: 10,
      tokensCached: 0,
      costUsd: 0.01,
    } as OrchestrationEvent,
    { type: "file_change", agentId: "a", kind: "update", path: "src/a.ts", before: "1", after: "2", summary: "" } as OrchestrationEvent,
  ]);
}

describe("graph focus", () => {
  it("a run's focus is what its ledger read and what it changed", () => {
    const focus = focusFromRun(runWithLedger());
    expect(focus).toMatchObject({ kind: "run", read: ["src/b.ts"], changed: ["src/a.ts"], nodeIds: ["c.ts#C"] });
    const nodes = focusNodes(focus, graph);
    expect([...nodes.changed].sort()).toEqual(["a.ts#A", "a.ts#A2"]);
    expect([...nodes.read].sort()).toEqual(["b.ts#B", "c.ts#C"]);
  });

  it("a write outranks a read, and unknown node ids are dropped", () => {
    const nodes = focusNodes(
      { kind: "run", id: "x", label: "", read: ["src/a.ts"], changed: ["src/a.ts"], nodeIds: ["a.ts#A", "gone#X"] },
      graph,
    );
    expect(nodes.read.size).toBe(0);
    expect(nodes.changed.has("a.ts#A")).toBe(true);
  });

  it("reverted edits are not shown as changed", () => {
    const run = runWithLedger();
    const reverted = { ...run, changes: run.changes.map((c) => ({ ...c, reverted: true })) };
    expect(focusFromRun(reverted).changed).toEqual([]);
  });

  it("receipts, tasks and files each make a focus", () => {
    const summary = { ...emptySummary(), files: [{ key: "src/b.ts", sentTokens: 10, dedupedTokens: 0, reads: 1 }] };
    const receipt = { id: "old", prompt: "Old run\nmore", filesChanged: ["src/c.ts"], usage: summary } as StoredRun;
    expect(focusFromReceipt(receipt)).toMatchObject({ label: "Old run", read: ["src/b.ts"], changed: ["src/c.ts"] });

    const run = { ...runWithLedger(), taskId: "t1" };
    expect(focusFromTask({ id: "t1", task: "Fix it" }, [run])).toMatchObject({ kind: "task", changed: ["src/a.ts"], read: ["src/b.ts"] });
    expect(focusFromTask({ id: "t2", task: "Other", files: ["src/c.ts"] }, [run]).changed).toEqual(["src/c.ts"]);
    expect(focusIsEmpty(focusFromTask({ id: "t3", task: "Nothing" }, []))).toBe(true);
    expect(focusFromFile("src/a.ts")).toMatchObject({ kind: "file", label: "a.ts", changed: ["src/a.ts"] });
  });

  it("finds the runs and tasks that touched a file, and its tokens", () => {
    const live = { ...runWithLedger(), id: "live", startedAt: 50 };
    const task = { ...runWithLedger(), id: "tr", taskId: "t9", startedAt: 60 };
    const receipt = {
      id: "old",
      prompt: "Earlier",
      startedAt: 10,
      filesChanged: [],
      usage: { ...emptySummary(), files: [{ key: "src/b.ts", sentTokens: 40, dedupedTokens: 0, reads: 1 }] },
    } as unknown as StoredRun;
    const touches = runsTouching("src/b.ts", { runs: [live, task], receipts: [receipt, { ...receipt, id: "live" }] });
    expect(touches.map((t) => [t.kind, t.id, t.role])).toEqual([
      ["task", "t9", "read"],
      ["run", "live", "read"],
      ["run", "old", "read"],
    ]);
    expect(touches[1].tokens).toBe(600);
    expect(runsTouching("src/a.ts", { runs: [live], receipts: [] })[0].role).toBe("changed");

    const usage = {
      files: [{ key: "src/b.ts", sentTokens: 600.4, dedupedTokens: 0, reads: 2 }],
      nodes: [{ key: "b.ts#B", sentTokens: 120, dedupedTokens: 0, reads: 1 }],
    };
    expect(tokensFor(usage, "src/b.ts", "b.ts#B")).toEqual({ fileTokens: 600, fileReads: 2, nodeTokens: 120, nodeReads: 1 });
  });

  it("showOnGraph opens the graph in the IDE and a new run clears the focus", () => {
    useViberon.setState({ tabs: [{ path: WELCOME_TAB_PATH, label: "Welcome" }], activeTabPath: WELCOME_TAB_PATH, appMode: "chat" });
    const focus = focusFromRun(runWithLedger());
    useViberon.getState().showOnGraph(focus);
    let state = useViberon.getState();
    expect(state.appMode).toBe("ide");
    expect(state.activeTabPath).toBe(GRAPH_TAB_PATH);
    expect(state.graphFocus).toEqual(focus);
    useViberon.getState().startRun({ prompt: "next", model: "m", mode: "single", taskId: "t1" });
    state = useViberon.getState();
    expect(state.graphFocus).toBeNull();
    expect(state.run?.taskId).toBe("t1");
  });
});

/* --------------------------- issues, tasks, PRs --------------------------- */

describe("issue / task / PR links", () => {
  const issue = (number: number, task: IssueRow["task"] = null): IssueRow => ({
    number,
    title: `Issue ${number}`,
    url: `https://github.com/acme/kit/issues/${number}`,
    labels: [],
    author: null,
    comments: 0,
    updatedAt: 0,
    task,
  });
  const task = (id: string, extra: Partial<TaskRow> = {}): TaskRow => ({
    id,
    kind: "fix",
    repoKey: "k",
    task: id,
    source: "issue",
    state: "done",
    createdAt: 0,
    ...extra,
  });

  it("links an issue to its task by id, else by URL", () => {
    const tasks = [task("t1"), task("t2", { issueUrl: "https://github.com/acme/kit/issues/7/", prUrl: "https://github.com/acme/kit/pull/9" })];
    expect(taskForIssue(issue(5, { id: "t1", state: "done" }), tasks)?.id).toBe("t1");
    expect(taskForIssue(issue(7), tasks)?.id).toBe("t2");
    expect(taskForIssue(issue(8), tasks)).toBeUndefined();
    expect(prForIssue(issue(7), tasks)).toBe("https://github.com/acme/kit/pull/9");
    expect(prForIssue(issue(5, { id: "t1", state: "done", prUrl: "https://x/pull/1" }), tasks)).toBe("https://x/pull/1");
  });

  it("links a task back to its issue", () => {
    const issues = [issue(7), issue(5, { id: "t1", state: "running" })];
    expect(issueForTask(task("tx", { issueUrl: "https://github.com/acme/kit/issues/7" }), issues)?.number).toBe(7);
    expect(issueForTask(task("t1"), issues)?.number).toBe(5);
    expect(issueNumber("https://github.com/acme/kit/issues/2499")).toBe(2499);
    expect(issueNumber(undefined)).toBeNull();
  });
});

describe("todoView", () => {
  it("passes the server's cancelled status through", () => {
    expect(todoView({ id: "1", content: "#2503 patch", status: "cancelled" }, "cancelled").status).toBe("cancelled");
  });

  it("never spins once the run ended cancelled or failed", () => {
    const item = { id: "1", content: "x", status: "in_progress" as const };
    expect(todoView(item, "cancelled").status).toBe("cancelled");
    expect(todoView(item, "failed").status).toBe("cancelled");
    expect(todoView(item, "running").status).toBe("in_progress");
    expect(todoView({ ...item, status: "pending" }, "cancelled").status).toBe("pending");
  });

  it("the evidence of a stopped run says stopped", () => {
    expect(evidenceOf(settleRun(midBatch(), "cancelled")).outcome).toBe("stopped");
  });
});

import { describe, expect, it, vi } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { createRun, reduceRun, type RunState } from "@/lib/client/run-reducer";
import { reduceUsageExtra } from "@/store/usage";
import {
  cacheHitRate,
  cacheSavings,
  compactSummary,
  contextFill,
  formatPercent,
  formatTok,
  formatUsd,
  graphSavings,
  legacySummary,
  mergeSummaries,
  normalizeSummary,
  PERSIST_LIMITS,
  runTotals,
  scopeUsage,
  summarizeRun,
  totalTokens,
  usageLine,
  type RunUsageExtra,
  type UsageReceipt,
} from "@/lib/client/usage";
import { computeHeat, heatAlpha, heatIntensity } from "@/lib/client/usage-heat";
import { mockScript, mockTargets } from "@/lib/client/mock-run";
import { loadConversation, saveConversation, createConversationMeta } from "@/lib/client/conversations";

let seq = 0;
const ctx = { now: 1_000, nextId: (p: string) => `${p}_${(seq += 1)}` };

/** Usage the reducer does not keep, folded alongside it like the store does. */
const extras = new WeakMap<RunState, RunUsageExtra>();

function fold(events: OrchestrationEvent[], base?: RunState): RunState {
  let run = base ?? createRun({ id: "r1", prompt: "Add a toggle", model: "claude-sonnet-5", mode: "orchestrated", now: 1_000 });
  let extra = base ? extras.get(base) : undefined;
  for (const event of events) {
    run = reduceRun(run, event, ctx);
    extra = reduceUsageExtra(extra, event);
  }
  if (extra) extras.set(run, extra);
  return run;
}

const sum = (run: RunState) => summarizeRun(run, extras.get(run));
const tot = (run: RunState) => runTotals(run, extras.get(run));

function turn(agentId: string, model: string, input: number, output: number, cacheRead: number, cost: number, at = 2_000): OrchestrationEvent {
  return {
    type: "turn_usage",
    agentId,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: 0,
    costUsd: cost,
    uncachedUsd: cost * 2,
    contextTokens: input + cacheRead + output,
    at,
  };
}

const LEDGER: OrchestrationEvent = {
  type: "ledger",
  ledger: {
    sentTokens: 3_000,
    dedupedTokens: 800,
    baselineTokens: 12_000,
    savedTokens: 9_000,
    savedPercent: 75,
    events: [],
    files: [
      { path: "src/a.ts", sentTokens: 2_000, dedupedTokens: 800, reads: 3 },
      { path: "src/b.ts", sentTokens: 1_000, dedupedTokens: 0, reads: 1 },
    ],
    nodes: [{ id: "src/a.ts#A", sentTokens: 1_500, dedupedTokens: 0, reads: 2 }],
    sources: [{ source: "graph_slice", tokens: 3_000, dedupedTokens: 800, count: 2 }],
  },
  tokensIn: 16_000,
  tokensOut: 1_500,
  tokensCached: 9_000,
  tokensCacheWrite: 500,
  costUsd: 0.05,
  uncachedUsd: 0.09,
};

const AGENTS: OrchestrationEvent[] = [
  { type: "agent_start", agentId: "s1", stepId: "s1", role: "frontend", title: "Hook", model: "claude-sonnet-5", wave: 0 },
  { type: "agent_start", agentId: "s2", stepId: "s2", role: "tester", title: "Tests", model: "claude-haiku-4-5", wave: 1 },
];

describe("usage store reducer", () => {
  it("records turn_usage events in order and the ledger's cache writes", () => {
    const run = fold([...AGENTS, turn("s1", "claude-sonnet-5", 5_000, 500, 4_000, 0.02), turn("s2", "claude-haiku-4-5", 2_000, 400, 5_000, 0.01), LEDGER]);
    expect(extras.get(run)!.turns.map((t) => t.agentId)).toEqual(["s1", "s2"]);
    expect(extras.get(run)!.cacheWrite).toBe(500);
  });

  it("ignores ledger events without tokensCacheWrite", () => {
    const { tokensCacheWrite: _omit, ...legacy } = LEDGER as Extract<OrchestrationEvent, { type: "ledger" }>;
    void _omit;
    expect(extras.get(fold([legacy as OrchestrationEvent]))).toBeUndefined();
  });
});

describe("summarizeRun", () => {
  const run = fold([
    ...AGENTS,
    turn("s1", "claude-sonnet-5", 5_000, 500, 4_000, 0.02, 2_000),
    turn("s2", "claude-haiku-4-5", 2_000, 400, 5_000, 0.01, 3_000),
    LEDGER,
  ]);
  const summary = sum(run);

  it("takes totals from the ledger: input excludes cache reads", () => {
    expect(summary.totals).toEqual({ input: 7_000, output: 1_500, cacheRead: 9_000, cacheWrite: 500, costUsd: 0.05, uncachedUsd: 0.09 });
    expect(tot(run)).toEqual(summary.totals);
  });

  it("breaks down by model and agent and assigns the un-itemized rest to the orchestrator", () => {
    const models = Object.fromEntries(summary.byModel.map((r) => [r.key, r]));
    // 0.05 total - 0.03 itemized lands on the run's model.
    expect(models["claude-sonnet-5"].costUsd).toBeCloseTo(0.04, 6);
    expect(models["claude-haiku-4-5"].costUsd).toBeCloseTo(0.01, 6);
    const sumModels = summary.byModel.reduce((s, r) => s + totalTokens(r), 0);
    const sumAgents = summary.byAgent.reduce((s, r) => s + totalTokens(r), 0);
    expect(sumModels).toBe(totalTokens(summary.totals));
    expect(sumAgents).toBe(totalTokens(summary.totals));
    expect(summary.byAgent.map((r) => r.key)).toContain("orchestrator");
    expect(summary.byAgent.find((r) => r.key === "s2")?.detail).toBe("tester");
  });

  it("builds a per-call timeline and the last call's context size", () => {
    expect(summary.timeline).toHaveLength(2);
    expect(summary.timeline[0]).toMatchObject({ input: 5_000, output: 500, cacheRead: 4_000, label: "Hook · call 1" });
    expect(summary.lastContext).toEqual({ model: "claude-haiku-4-5", tokens: 7_400 });
  });

  it("carries the ledger's per-file / per-node attribution and savings", () => {
    expect(summary.files.map((f) => f.key)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(summary.nodes[0]).toEqual({ key: "src/a.ts#A", sentTokens: 1_500, dedupedTokens: 0, reads: 2 });
    expect(summary.context).toEqual({ sent: 3_000, deduped: 800, baseline: 12_000, saved: 9_000 });
    expect(graphSavings(summary.context)).toEqual({ tokens: 9_000, percent: 75 });
  });

  it("lets live turns run ahead of the last ledger total", () => {
    const live = fold([turn("s1", "claude-sonnet-5", 50_000, 100, 0, 0.3)], run);
    // 5k + 2k + 50k itemized now exceeds the ledger's 7k uncached input.
    expect(tot(live).input).toBe(57_000);
  });

  it("falls back to agent_done totals when a producer emits no turn_usage", () => {
    const legacy = fold([
      ...AGENTS,
      { type: "agent_done", agentId: "s1", summary: "", tokensIn: 3_000, tokensOut: 200, cost: 0.01, durationMs: 1 },
    ]);
    const s = sum(legacy);
    expect(s.byAgent[0]).toMatchObject({ key: "s1", input: 3_000, output: 200 });
  });

  it("rebuilds attribution from events for snapshots without rollups", () => {
    const old = fold([
      {
        ...LEDGER,
        ledger: {
          sentTokens: 100,
          dedupedTokens: 0,
          baselineTokens: 0,
          savedTokens: 0,
          savedPercent: 0,
          events: [
            { at: 1, source: "read_file", label: "src/x.ts", tokens: 60, deduped: false },
            { at: 2, source: "graph_slice", label: "q", tokens: 40, deduped: false, paths: ["src/x.ts", "src/y.ts"], nodeIds: ["n1"] },
          ],
        },
      } as OrchestrationEvent,
    ]);
    const s = sum(old);
    expect(s.files).toEqual([
      { key: "src/x.ts", sentTokens: 80, dedupedTokens: 0, reads: 2 },
      { key: "src/y.ts", sentTokens: 20, dedupedTokens: 0, reads: 1 },
    ]);
    expect(s.nodes).toEqual([{ key: "n1", sentTokens: 40, dedupedTokens: 0, reads: 1 }]);
    expect(s.bySource.map((r) => r.source)).toEqual(["read_file", "graph_slice"]);
  });
});

describe("mergeSummaries / scopes", () => {
  const a = sum(fold([...AGENTS, turn("s1", "claude-sonnet-5", 5_000, 500, 4_000, 0.02), LEDGER]));
  const b = legacySummary({ tokensIn: 1_000, tokensOut: 100, costUsd: 0.01, startedAt: 5_000, prompt: "old run" });

  it("sums totals, merges models by id, agents by role, files by path, one bar per run", () => {
    const merged = mergeSummaries([
      { summary: a, label: "first", at: 1_000 },
      { summary: b, label: "second", at: 5_000 },
      { summary: a, label: "third", at: 9_000 },
    ]);
    expect(merged.runs).toBe(3);
    expect(merged.totals.costUsd).toBeCloseTo(0.11, 6);
    expect(merged.timeline.map((t) => t.label)).toEqual(["first", "second", "third"]);
    expect(merged.files.find((f) => f.key === "src/a.ts")).toEqual({ key: "src/a.ts", sentTokens: 4_000, dedupedTokens: 1_600, reads: 6 });
    expect(merged.byAgent.map((r) => r.key).sort()).toEqual(["frontend", "planning"]);
    expect(merged.byAgent.find((r) => r.key === "planning")?.label).toBe("Orchestrator");
    expect(merged.context.baseline).toBe(24_000);
  });

  const receipt = (id: string, usage = a): UsageReceipt => ({ id, prompt: id, startedAt: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, usage });

  it("run scope prefers the live run, then the conversation's last receipt", () => {
    const live = fold([LEDGER]);
    expect(scopeUsage({ scope: "run", run: live, conversationRuns: [], sessionRuns: [] }).totals.costUsd).toBe(0.05);
    expect(scopeUsage({ scope: "run", run: null, conversationRuns: [receipt("x", b)], sessionRuns: [] }).totals.costUsd).toBe(0.01);
    expect(scopeUsage({ scope: "run", run: null, conversationRuns: [], sessionRuns: [] }).runs).toBe(0);
  });

  it("conversation and session scopes add the live run once, never twice", () => {
    const live = fold([LEDGER]);
    const conv = scopeUsage({ scope: "conversation", run: live, conversationRuns: [receipt("x")], sessionRuns: [] });
    expect(conv.runs).toBe(2);
    const landed = scopeUsage({ scope: "session", run: live, conversationRuns: [], sessionRuns: [receipt("x"), receipt(live.id)] });
    expect(landed.runs).toBe(2);
  });
});

describe("persistence", () => {
  function installStorage(): void {
    const backing = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => void backing.set(k, v),
        removeItem: (k: string) => void backing.delete(k),
      },
    });
  }

  it("round-trips a compacted run summary with its conversation", () => {
    installStorage();
    const big = sum(fold([...AGENTS, ...Array.from({ length: 80 }, (_, i) => turn("s1", "claude-sonnet-5", 100 + i, 10, 0, 0.001, 2_000 + i)), LEDGER]));
    const usage = compactSummary(big);
    expect(usage.timeline).toHaveLength(PERSIST_LIMITS.timeline);
    const meta = createConversationMeta();
    saveConversation("repo", {
      meta,
      messages: [{ id: "m1", role: "user", content: "hi", at: 1 }],
      runs: [{ id: "r1", prompt: "hi", status: "done", startedAt: 1, filesChanged: [], agentCount: 2, costUsd: 0.05, tokensIn: 16_000, tokensOut: 1_500, usage }],
    });
    const loaded = loadConversation("repo", meta.id)!;
    expect(loaded.runs[0].usage).toEqual(usage);
    vi.unstubAllGlobals();
  });

  it("drops a corrupt stored summary but keeps the receipt", () => {
    installStorage();
    const meta = createConversationMeta();
    saveConversation("repo", {
      meta,
      messages: [{ id: "m1", role: "user", content: "hi", at: 1 }],
      runs: [{ id: "r1", prompt: "hi", status: "done", startedAt: 1, filesChanged: [], agentCount: 1, costUsd: 0.01, tokensIn: 10, tokensOut: 5, usage: "nonsense" as never }],
    });
    const run = loadConversation("repo", meta.id)!.runs[0];
    expect(run.id).toBe("r1");
    expect(run.usage).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("normalizeSummary fills missing numbers and rejects non-summaries", () => {
    expect(normalizeSummary(null)).toBeNull();
    expect(normalizeSummary({ runs: 1 })).toBeNull();
    const n = normalizeSummary({ totals: { input: 5, costUsd: "x" }, files: [{ key: "a", sentTokens: 3 }, { nope: 1 }] })!;
    expect(n.totals).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, uncachedUsd: 0 });
    expect(n.files).toEqual([{ key: "a", sentTokens: 3, dedupedTokens: 0, reads: 0 }]);
    expect(n.runs).toBe(1);
  });
});

describe("context fill and savings math", () => {
  it("measures against the model's window with warn / high levels", () => {
    expect(contextFill(100_000, "claude-haiku-4-5")).toEqual({ used: 100_000, window: 200_000, ratio: 0.5, level: "ok" });
    expect(contextFill(130_000, "claude-haiku-4-5")?.level).toBe("warn");
    expect(contextFill(190_000, "claude-haiku-4-5")?.level).toBe("high");
    expect(contextFill(5_000_000, "claude-haiku-4-5")?.ratio).toBe(1);
    expect(contextFill(1_000, "openai:local")?.window).toBe(128_000);
    expect(contextFill(1_000, "no-such-model")).toBeNull();
    expect(contextFill(0, "claude-haiku-4-5")).toBeNull();
  });

  it("computes cache hit rate and cache savings", () => {
    const t = { input: 2_000, output: 0, cacheRead: 6_000, cacheWrite: 2_000, costUsd: 0.03, uncachedUsd: 0.12 };
    expect(cacheHitRate(t)).toBeCloseTo(0.6, 6);
    expect(cacheSavings(t)).toEqual({ usd: 0.09, percent: 75 });
    expect(cacheSavings({ ...t, uncachedUsd: 0 })).toEqual({ usd: 0, percent: 0 });
  });
});

describe("formatting", () => {
  it("formats token counts compactly", () => {
    expect(formatTok(0)).toBe("0");
    expect(formatTok(950)).toBe("950");
    expect(formatTok(1_000)).toBe("1k");
    expect(formatTok(12_400)).toBe("12.4k");
    expect(formatTok(99_960)).toBe("100k");
    expect(formatTok(124_000)).toBe("124k");
    expect(formatTok(1_240_000)).toBe("1.24M");
    expect(formatTok(1_000_000)).toBe("1M");
    expect(formatTok(-5)).toBe("0");
  });

  it("formats dollars and percentages", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(0.031)).toBe("$0.03");
    expect(formatUsd(12.4)).toBe("$12.40");
    expect(formatUsd(240.2)).toBe("$240");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatPercent(0.623)).toBe("62%");
  });

  it("renders the status-bar line", () => {
    expect(usageLine({ input: 8_000, output: 1_400, cacheRead: 3_000, cacheWrite: 0, costUsd: 0.031, uncachedUsd: 0.05 })).toBe("12.4k tok · $0.03");
  });
});

describe("graph heat", () => {
  const graph = {
    nodes: [
      { id: "a#1", file: "a.ts" },
      { id: "a#2", file: "a.ts" },
      { id: "b#1", file: "b.ts" },
      { id: "c#1", file: "c.ts" },
    ] as never[],
  };
  // a.ts symbols collapsed into one folder bubble; b.ts expanded.
  const toRender = new Map([
    ["a#1", "folder:a"],
    ["a#2", "folder:a"],
    ["b#1", "b#1"],
    ["c#1", "c#1"],
  ]);

  it("adds node attribution to the file's un-attributed remainder and sums into render nodes", () => {
    const heat = computeHeat(
      graph,
      toRender,
      [
        { key: "a.ts", sentTokens: 1_000, dedupedTokens: 0, reads: 3 },
        { key: "b.ts", sentTokens: 200, dedupedTokens: 0, reads: 1 },
        { key: "missing.json", sentTokens: 999, dedupedTokens: 0, reads: 1 },
      ],
      [{ key: "a#1", sentTokens: 600, dedupedTokens: 0, reads: 2 }],
    );
    expect(heat.byRenderId.get("folder:a")).toEqual({ tokens: 1_000, reads: 3, files: 1 });
    expect(heat.byRenderId.get("b#1")).toEqual({ tokens: 200, reads: 1, files: 1 });
    expect(heat.byRenderId.has("c#1")).toBe(false);
    expect(heat.max).toBe(1_000);
    expect(heat.hotFiles).toBe(2);
  });

  it("uses a square-root ramp with a visible floor", () => {
    expect(heatIntensity(0, 100)).toBe(0);
    expect(heatIntensity(25, 100)).toBe(0.5);
    expect(heatIntensity(400, 100)).toBe(1);
    expect(heatAlpha(0)).toBe(0);
    expect(heatAlpha(0.01)).toBeGreaterThan(0.14);
    expect(heatAlpha(1)).toBeCloseTo(0.64, 6);
  });
});

describe("mock replay", () => {
  const graph = {
    nodes: [
      ...["x", "y", "z"].map((n, i) => ({ id: `lib/big.ts#${n}`, file: "lib/big.ts", loc: 10 + i })),
      ...["p", "q"].map((n) => ({ id: `lib/mid.ts#${n}`, file: "lib/mid.ts", loc: 5 })),
      { id: "lib/small.ts#s", file: "lib/small.ts", loc: 3 },
      { id: "tests/a.test.ts#t", file: "tests/a.test.ts", loc: 50 },
    ],
  };

  it("targets real graph files, skipping tests", () => {
    expect(mockTargets(graph).map((t) => t.path)).toEqual(["lib/big.ts", "lib/mid.ts", "lib/small.ts"]);
    expect(mockTargets(null)[0].path).toBe("src/components/Header.tsx");
  });

  it("emits turn_usage and cumulative ledgers whose totals add up", () => {
    const steps = mockScript({ prompt: "add a toggle", interaction: "agent", graph });
    const run = fold(steps.map((step) => step.event));
    const s = sum(run);
    expect(extras.get(run)!.turns.length).toBeGreaterThanOrEqual(8);
    expect(s.byModel.map((r) => r.key).sort()).toEqual(["claude-haiku-4-5", "claude-sonnet-5"]);
    expect(s.files[0].key).toBe("lib/big.ts");
    expect(s.nodes.every((n) => n.key.startsWith("lib/"))).toBe(true);
    expect(s.context.deduped).toBeGreaterThan(0);
    expect(s.totals.costUsd).toBeCloseTo(run.costUsd, 9);
    const events = run.ledger!.events;
    expect(events.some((e) => e.paths?.length && e.nodeIds?.length)).toBe(true);
  });
});

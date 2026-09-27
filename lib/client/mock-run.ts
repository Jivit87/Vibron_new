/**
 * Dev-only replay of a canned run, enabled with `?mock=1`.
 *
 * Lets the run UI be built and screenshotted without API keys or a live
 * harness. The script touches every `OrchestrationEvent` variant: rules,
 * todos, paired tool calls, a provider retry, compaction, command and edit
 * approvals, file changes, diagnostics, hooks, the ledger, and each
 * `run_done` status. Nothing here runs in a normal session.
 */

import type { OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { MODELS } from "@/lib/ai/models";
import type { LedgerEvent, LedgerSnapshot } from "@/lib/context/ledger";
import type { Interaction } from "@/lib/harness/contracts";
import type { GitSnapshot, ProblemsResult } from "@/lib/client/workspace-types";

export function isMockMode(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("mock") === "1";
  } catch {
    return false;
  }
}

/** One scripted step: wait `delay` ms, then emit. */
export interface ScriptStep {
  delay: number;
  event: OrchestrationEvent;
}

const MOCK_PLAN: RunPlan = {
  summary:
    "Add a persisted theme toggle: a settings hook, the toggle control in the header, and tests.",
  steps: [
    {
      id: "s1",
      title: "Add useTheme hook with localStorage persistence",
      role: "frontend",
      detail: "Create src/hooks/useTheme.ts; read/write `theme` in localStorage.",
      files: ["src/hooks/useTheme.ts"],
      dependsOn: [],
    },
    {
      id: "s2",
      title: "Render toggle in Header",
      role: "frontend",
      detail: "Wire the hook into src/components/Header.tsx.",
      files: ["src/components/Header.tsx"],
      dependsOn: ["s1"],
    },
    {
      id: "s3",
      title: "Unit tests for useTheme",
      role: "tester",
      detail: "Cover default, toggle, and persistence.",
      files: ["src/hooks/useTheme.test.ts"],
      dependsOn: ["s1"],
    },
  ],
  waves: [["s1"], ["s2", "s3"]],
};

const HOOK_BEFORE = null;
const HOOK_AFTER = `import { useEffect, useState } from "react";

export type Theme = "light" | "dark";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() =>
    (localStorage.getItem("theme") as Theme) ?? "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
`;

const HEADER_BEFORE = `export function Header() {
  return (
    <header className="header">
      <Logo />
      <Nav />
    </header>
  );
}
`;
const HEADER_AFTER = `import { useTheme } from "../hooks/useTheme";

export function Header() {
  const [theme, toggle] = useTheme();
  return (
    <header className="header">
      <Logo />
      <Nav />
      <button type="button" onClick={toggle} aria-label="Toggle theme">
        {theme === "dark" ? "Light" : "Dark"}
      </button>
    </header>
  );
}
`;

function ledger(tokensIn: number, tokensOut: number, costUsd: number): OrchestrationEvent {
  return {
    type: "ledger",
    ledger: {
      sentTokens: Math.round(tokensIn * 0.3),
      dedupedTokens: 1200,
      baselineTokens: tokensIn * 2,
      savedTokens: Math.round(tokensIn * 1.7),
      savedPercent: 85,
      events: [],
    },
    tokensIn,
    tokensOut,
    tokensCached: Math.round(tokensIn * 0.6),
    costUsd,
    uncachedUsd: costUsd * 2.4,
  };
}

/* ------------------------------ mock usage -------------------------------- */

/** The slice of a code graph the mock needs to attribute context. */
export interface MockGraph {
  nodes: { id: string; file: string; loc: number }[];
}

interface MockTarget {
  path: string;
  nodeIds: string[];
  /** Whole-file token estimate, the naive baseline for a read. */
  tokens: number;
}

const FALLBACK_TARGETS: MockTarget[] = [
  { path: "src/components/Header.tsx", nodeIds: ["src/components/Header.tsx#Header"], tokens: 820 },
  { path: "src/hooks/useTheme.ts", nodeIds: ["src/hooks/useTheme.ts#useTheme"], tokens: 610 },
  { path: "src/app/layout.tsx", nodeIds: ["src/app/layout.tsx#RootLayout"], tokens: 1_400 },
  { path: "src/lib/settings.ts", nodeIds: ["src/lib/settings.ts#loadSettings", "src/lib/settings.ts#saveSettings"], tokens: 2_300 },
  { path: "src/components/Nav.tsx", nodeIds: ["src/components/Nav.tsx#Nav"], tokens: 900 },
  { path: "src/styles/theme.css", nodeIds: [], tokens: 700 },
];

/**
 * Real files and symbol ids from the open workspace's graph, so the usage
 * panel's "Top context" opens real files and the graph heatmap lights real
 * nodes. Deterministic: the files with the most symbols, tests skipped.
 */
export function mockTargets(graph?: MockGraph | null): MockTarget[] {
  if (!graph || graph.nodes.length === 0) return FALLBACK_TARGETS;
  const byFile = new Map<string, { ids: string[]; loc: number }>();
  for (const node of graph.nodes) {
    if (/(^|\/)(tests?|__tests__)\/|\.test\./.test(node.file)) continue;
    const entry = byFile.get(node.file) ?? { ids: [], loc: 0 };
    entry.ids.push(node.id);
    entry.loc += Math.max(1, node.loc);
    byFile.set(node.file, entry);
  }
  const ranked = [...byFile.entries()]
    .sort((a, b) => b[1].ids.length - a[1].ids.length || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([path, entry]) => ({ path, nodeIds: entry.ids, tokens: Math.max(2_400, Math.round(entry.loc * 40)) }));
  return ranked.length >= 3 ? ranked : FALLBACK_TARGETS;
}

/**
 * Accumulates a believable run's usage while the script is built: per-call
 * `turn_usage` events, and cumulative `ledger` snapshots whose events carry
 * paths and node ids. Totals always equal the sum of the calls (plus a
 * small planning call), so every view can be checked against the others.
 */
class MockUsage {
  private turns: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; uncached: number }[] = [];
  private events: LedgerEvent[] = [];
  private files = new Map<string, { path: string; sentTokens: number; dedupedTokens: number; reads: number }>();
  private nodes = new Map<string, { id: string; sentTokens: number; dedupedTokens: number; reads: number }>();
  private sources = new Map<string, { source: string; tokens: number; dedupedTokens: number; count: number }>();
  private sent = 0;
  private deduped = 0;
  private baseline = 0;
  private clock = Date.now();

  constructor(private targets: MockTarget[]) {}

  private target(index: number): MockTarget {
    return this.targets[index % this.targets.length];
  }

  /** Price a call the way `estimateCost` does. */
  private price(model: string, input: number, output: number, cacheRead: number, cacheWrite: number) {
    const pricing = MODELS.find((m) => m.id === model)?.pricing ?? { input: 3, output: 15 };
    const inRate = pricing.input / 1_000_000;
    const outRate = pricing.output / 1_000_000;
    return {
      cost: input * inRate + cacheRead * inRate * 0.1 + cacheWrite * inRate * 1.25 + output * outRate,
      uncached: (input + cacheRead + cacheWrite) * inRate + output * outRate,
    };
  }

  /** One model call. */
  turn(agentId: string, model: string, input: number, output: number, cacheRead: number, cacheWrite = 0): ScriptStep {
    const { cost, uncached } = this.price(model, input, output, cacheRead, cacheWrite);
    this.turns.push({ input, output, cacheRead, cacheWrite, cost, uncached });
    this.clock += 2_000 + Math.round(input / 20);
    return {
      delay: 30,
      event: {
        type: "turn_usage",
        agentId,
        model,
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd: cost,
        uncachedUsd: uncached,
        contextTokens: input + cacheRead + cacheWrite + output,
        at: this.clock,
      },
    };
  }

  /** Context delivered to an agent, attributed to targets by index. */
  read(
    source: string,
    label: string,
    targets: number[],
    tokens: number,
    options: { deduped?: boolean; untracked?: boolean; nodes?: "all" | "first" | "none" } = {},
  ): this {
    const picked = targets.map((i) => this.target(i));
    const paths = [...new Set(picked.map((t) => t.path))];
    const nodeMode = options.nodes ?? "all";
    const nodeIds = [
      ...new Set(
        picked.flatMap((t) => (nodeMode === "none" ? [] : nodeMode === "first" ? t.nodeIds.slice(0, 2) : t.nodeIds.slice(0, 6))),
      ),
    ];
    const deduped = Boolean(options.deduped);
    this.events.push({
      at: this.clock,
      source,
      label,
      tokens,
      deduped,
      ...(paths.length ? { paths } : {}),
      ...(nodeIds.length ? { nodeIds } : {}),
      ...(options.untracked ? { untracked: true } : {}),
    });
    const src = this.sources.get(source) ?? { source, tokens: 0, dedupedTokens: 0, count: 0 };
    src.count += 1;
    if (deduped) src.dedupedTokens += tokens;
    else src.tokens += tokens;
    this.sources.set(source, src);
    for (const path of paths) {
      const stat = this.files.get(path) ?? { path, sentTokens: 0, dedupedTokens: 0, reads: 0 };
      stat.reads += 1;
      if (deduped) stat.dedupedTokens += tokens / paths.length;
      else stat.sentTokens += tokens / paths.length;
      this.files.set(path, stat);
    }
    for (const id of nodeIds) {
      const stat = this.nodes.get(id) ?? { id, sentTokens: 0, dedupedTokens: 0, reads: 0 };
      stat.reads += 1;
      if (deduped) stat.dedupedTokens += tokens / nodeIds.length;
      else stat.sentTokens += tokens / nodeIds.length;
      this.nodes.set(id, stat);
    }
    if (!options.untracked) {
      if (deduped) this.deduped += tokens;
      else this.sent += tokens;
      if (!deduped) for (const t of picked) this.baseline += t.tokens;
    }
    return this;
  }

  private snapshot(): LedgerSnapshot {
    const round = <T extends { sentTokens: number; dedupedTokens: number }>(v: T): T => ({
      ...v,
      sentTokens: Math.round(v.sentTokens),
      dedupedTokens: Math.round(v.dedupedTokens),
    });
    const saved = Math.max(0, this.baseline - this.sent);
    return {
      sentTokens: this.sent,
      dedupedTokens: this.deduped,
      baselineTokens: this.baseline,
      savedTokens: saved,
      savedPercent: this.baseline > 0 ? Math.round((saved / this.baseline) * 100) : 0,
      events: [...this.events],
      files: [...this.files.values()].map(round).sort((a, b) => b.sentTokens - a.sentTokens),
      nodes: [...this.nodes.values()].map(round).sort((a, b) => b.sentTokens - a.sentTokens),
      sources: [...this.sources.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }

  /** Cumulative `ledger` event; `planning` adds un-itemized orchestrator usage. */
  ledger(planning: { input: number; output: number; model: string } | null = null): ScriptStep {
    if (planning) {
      const { cost, uncached } = this.price(planning.model, planning.input, planning.output, 0, 0);
      this.turns.push({ input: planning.input, output: planning.output, cacheRead: 0, cacheWrite: 0, cost, uncached });
    }
    const sum = this.turns.reduce(
      (acc, t) => ({
        input: acc.input + t.input,
        output: acc.output + t.output,
        cacheRead: acc.cacheRead + t.cacheRead,
        cacheWrite: acc.cacheWrite + t.cacheWrite,
        cost: acc.cost + t.cost,
        uncached: acc.uncached + t.uncached,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, uncached: 0 },
    );
    return {
      delay: 40,
      event: {
        type: "ledger",
        ledger: this.snapshot(),
        tokensIn: sum.input + sum.cacheRead,
        tokensOut: sum.output,
        tokensCached: sum.cacheRead,
        tokensCacheWrite: sum.cacheWrite,
        costUsd: sum.cost,
        uncachedUsd: sum.uncached,
      },
    };
  }

  get costUsd(): number {
    return this.turns.reduce((sum, t) => sum + t.cost, 0);
  }
}

function words(agentId: string, text: string, type: "agent_text" | "agent_thinking" = "agent_text"): ScriptStep[] {
  return text.split(/(?<= )/).map((chunk) => ({
    delay: 18,
    event: { type, agentId, text: chunk } as OrchestrationEvent,
  }));
}

function tool(
  agentId: string,
  callId: string,
  name: string,
  args: string,
  result: string,
  ok = true,
  wait = 260,
): ScriptStep[] {
  return [
    { delay: 60, event: { type: "agent_tool", agentId, callId, tool: name, args, phase: "start" } },
    {
      delay: wait,
      event: { type: "agent_tool", agentId, callId, tool: name, args, phase: "end", result, ok },
    },
  ];
}

/** The build script: plan → two waves → approvals → done. */
function buildScript(prompt: string, withPlan?: RunPlan, graph?: MockGraph | null): ScriptStep[] {
  const plan = withPlan ?? MOCK_PLAN;
  const fail = /\bfail\b/i.test(prompt);
  const a = "s1";
  const b = "s2";
  const c = "s3";
  const u = new MockUsage(mockTargets(graph));
  const t = mockTargets(graph);
  // Wave 0: orient with the graph, read one file, write the hook.
  u.read("graph_slice", 'graph slice for "theme"', [0, 1, 2], 3_400);
  u.read("symbol_outline", t[1].path, [1], 520, { untracked: true });
  u.read("read_file", t[0].path, [0], 1_900, { nodes: "first" });
  const wave0 = [
    u.turn(a, "claude-sonnet-5", 9_800, 420, 0, 6_200),
    u.turn(a, "claude-sonnet-5", 3_100, 610, 12_900),
    u.turn(a, "claude-sonnet-5", 2_400, 880, 15_600),
  ];
  const ledger0 = u.ledger({ input: 3_600, output: 540, model: "claude-sonnet-5" });
  // Wave 1: the header agent re-reads (deduped), the tester greps.
  u.read("read_file", t[0].path, [0], 1_900, { deduped: true, nodes: "first" });
  u.read("graph_slice", 'graph slice for "header toggle"', [0, 3], 2_300);
  u.read("grep", 'grep "theme"', [4, 5, 0], 640, { untracked: true, nodes: "first" });
  u.read("read_file", t[2].path, [2], 1_200, { nodes: "first" });
  u.read("find_symbols", "useTheme", [1], 180, { untracked: true, nodes: "first" });
  u.read("graph_slice", 'graph slice for "theme"', [0, 1, 2], 3_400, { deduped: true });
  const wave1 = [
    u.turn(b, "claude-sonnet-5", 8_600, 390, 0, 5_900),
    u.turn(c, "claude-haiku-4-5", 7_200, 520, 0, 4_100),
    u.turn(b, "claude-sonnet-5", 2_900, 740, 14_800),
    u.turn(c, "claude-haiku-4-5", 1_700, 910, 11_300),
    u.turn(b, "claude-sonnet-5", 1_600, 420, 17_900),
  ];
  const ledger1 = u.ledger();
  return [
    {
      delay: 80,
      event: {
        type: "run_start",
        runId: `mock_${Date.now().toString(36)}`,
        mode: "orchestrated",
        model: "claude-sonnet-5",
        at: Date.now(),
        rules: [
          { path: "AGENTS.md", tokens: 612 },
          { path: ".cursor/rules/style.mdc", tokens: 188 },
        ],
      },
    },
    { delay: 60, event: { type: "checkpoint", id: "cp_mock", label: "Before run", fileCount: 42 } },
    { delay: 40, event: { type: "intent", intent: "build", reason: "Asks for a code change." } },
    ...words("", "Reading the header and settings code to decide how to split this.").map((s) => ({
      delay: s.delay,
      event: { type: "orchestrator_text", text: (s.event as { text: string }).text } as OrchestrationEvent,
    })),
    { delay: 200, event: { type: "plan", plan } },
    { delay: 60, event: { type: "wave_start", wave: 0, stepIds: ["s1"] } },
    {
      delay: 80,
      event: {
        type: "agent_start",
        agentId: a,
        stepId: a,
        role: "frontend",
        title: plan.steps[0]?.title ?? "Step 1",
        model: "claude-sonnet-5",
        wave: 0,
      },
    },
    ...words(a, "The app reads theme from a CSS class today; a data attribute is simpler to toggle. ", "agent_thinking"),
    {
      delay: 60,
      event: {
        type: "todos",
        agentId: a,
        items: [
          { id: "t1", content: "Find where the theme is applied", status: "in_progress" },
          { id: "t2", content: "Write useTheme hook", status: "pending" },
          { id: "t3", content: "Persist to localStorage", status: "pending" },
        ],
      },
    },
    ...tool(a, "c1", "search", "theme", "4 matches in 3 files"),
    ...tool(a, "c2", "read_file", t[0].path, "9 lines"),
    wave0[0],
    {
      delay: 120,
      event: {
        type: "agent_retry",
        agentId: a,
        attempt: 1,
        maxAttempts: 4,
        delayMs: 2000,
        reason: "529 overloaded",
      },
    },
    {
      delay: 400,
      event: {
        type: "todos",
        agentId: a,
        items: [
          { id: "t1", content: "Find where the theme is applied", status: "completed" },
          { id: "t2", content: "Write useTheme hook", status: "in_progress" },
          { id: "t3", content: "Persist to localStorage", status: "pending" },
        ],
      },
    },
    wave0[1],
    ...words(a, "I'll add a small hook that owns the attribute and the persisted value."),
    { delay: 60, event: { type: "agent_tool", agentId: a, callId: "c3", tool: "write_file", args: "src/hooks/useTheme.ts", phase: "start" } },
    {
      delay: 200,
      event: {
        type: "file_change",
        agentId: a,
        kind: "create",
        path: "src/hooks/useTheme.ts",
        before: HOOK_BEFORE,
        after: HOOK_AFTER,
        summary: "New hook",
        adds: HOOK_AFTER.split("\n").length,
        removes: 0,
      },
    },
    { delay: 40, event: { type: "agent_tool", agentId: a, callId: "c3", tool: "write_file", args: "src/hooks/useTheme.ts", phase: "end", result: "created, 15 lines", ok: true } },
    {
      delay: 120,
      event: {
        type: "compaction",
        agentId: a,
        strategy: "elide",
        beforeTokens: 118_400,
        afterTokens: 46_200,
      },
    },
    {
      delay: 60,
      event: {
        type: "todos",
        agentId: a,
        items: [
          { id: "t1", content: "Find where the theme is applied", status: "completed" },
          { id: "t2", content: "Write useTheme hook", status: "completed" },
          { id: "t3", content: "Persist to localStorage", status: "completed" },
        ],
      },
    },
    wave0[2],
    ledger0,
    {
      delay: 80,
      event: {
        type: "agent_done",
        agentId: a,
        summary: "Added useTheme with persistence.",
        tokensIn: 24_000,
        tokensOut: 1_900,
        cost: 0.041,
        durationMs: 5_400,
      },
    },
    { delay: 40, event: { type: "wave_end", wave: 0 } },
    { delay: 60, event: { type: "wave_start", wave: 1, stepIds: ["s2", "s3"] } },
    {
      delay: 60,
      event: {
        type: "agent_start",
        agentId: b,
        stepId: b,
        role: "frontend",
        title: plan.steps[1]?.title ?? "Step 2",
        model: "claude-sonnet-5",
        wave: 1,
      },
    },
    {
      delay: 40,
      event: {
        type: "agent_start",
        agentId: c,
        stepId: c,
        role: "tester",
        title: plan.steps[2]?.title ?? "Step 3",
        model: "claude-haiku-4-5",
        wave: 1,
      },
    },
    wave1[0],
    wave1[1],
    ...tool(b, "c4", "read_file", t[0].path, "already in context"),
    ...tool(c, "c5", "grep", "theme", "4 matches in 3 files"),
    {
      delay: 120,
      event: {
        type: "approval_request",
        approvalId: "ap_edit",
        agentId: b,
        kind: "edit",
        title: "Edit src/components/Header.tsx",
        command: "Edit src/components/Header.tsx",
        reason: "Edits need approval",
        detail: { path: "src/components/Header.tsx", before: HEADER_BEFORE, after: HEADER_AFTER },
      },
    },
    {
      delay: 900,
      event: {
        type: "file_change",
        agentId: b,
        kind: "update",
        path: "src/components/Header.tsx",
        before: HEADER_BEFORE,
        after: HEADER_AFTER,
        summary: "Render theme toggle",
        adds: 6,
        removes: 0,
      },
    },
    {
      delay: 60,
      event: {
        type: "diagnostics",
        agentId: b,
        errorCount: 1,
        files: ["src/components/Header.tsx"],
        injected: true,
      },
    },
    wave1[2],
    ...tool(b, "c6", "edit_file", "src/components/Header.tsx", "1 replacement"),
    {
      delay: 60,
      event: {
        type: "file_change",
        agentId: b,
        kind: "update",
        path: "src/components/Header.tsx",
        before: HEADER_AFTER,
        after: HEADER_AFTER.replace('aria-label="Toggle theme"', 'aria-label="Toggle color theme"'),
        summary: "Fix label",
        adds: 1,
        removes: 1,
      },
    },
    {
      delay: 80,
      event: {
        type: "file_change",
        agentId: c,
        kind: "create",
        path: "src/hooks/useTheme.test.ts",
        before: null,
        after: 'import { describe, it, expect } from "vitest";\n\ndescribe("useTheme", () => {\n  it("defaults to dark", () => {\n    expect(true).toBe(true);\n  });\n});\n',
        summary: "Tests",
        adds: 7,
        removes: 0,
      },
    },
    {
      delay: 80,
      event: {
        type: "approval_request",
        approvalId: "ap_cmd",
        agentId: c,
        kind: "command",
        title: "npm test -- src/hooks",
        command: "npm test -- src/hooks",
        reason: "Not on the auto-approve list",
        detail: { command: "npm test -- src/hooks" },
      },
    },
    {
      delay: 80,
      event: {
        type: "hook",
        agentId: c,
        event: "post_tool",
        command: "prettier --check src/hooks",
        exitCode: 0,
        blocked: false,
        output: "All matched files use Prettier code style!",
      },
    },
    {
      delay: 60,
      event: {
        type: "command",
        agentId: c,
        command: "npm test -- src/hooks",
        sessionId: "mock_term",
        status: "exited",
        exitCode: fail ? 1 : 0,
      },
    },
    ...tool(c, "c7", "run_command", "npm test -- src/hooks", fail ? "1 failed" : "3 passed", !fail, 400),
    wave1[3],
    ...words(b, "Header now renders a toggle bound to the hook."),
    wave1[4],
    ledger1,
    {
      delay: 60,
      event: {
        type: "agent_done",
        agentId: b,
        summary: "Toggle rendered in Header.",
        tokensIn: 22_000,
        tokensOut: 1_700,
        cost: 0.04,
        durationMs: 4_100,
      },
    },
    {
      delay: 60,
      event: {
        type: "agent_done",
        agentId: c,
        summary: fail ? "" : "3 tests pass.",
        tokensIn: 15_000,
        tokensOut: 1_200,
        cost: 0.031,
        durationMs: 3_900,
        error: fail ? "Tests failed: expected light, received dark" : undefined,
      },
    },
    { delay: 40, event: { type: "wave_end", wave: 1 } },
    {
      delay: 60,
      event: {
        type: "run_done",
        status: fail ? "failed" : "done",
        summary: fail
          ? "The toggle is in place but one test fails; see the tester's output."
          : "Added a persisted theme toggle: `useTheme` in `src/hooks`, the button in `Header`, and tests.",
        filesChanged: 3,
        durationMs: 14_000,
        costUsd: u.costUsd,
      },
    },
  ];
}

function planScript(graph?: MockGraph | null): ScriptStep[] {
  const u = new MockUsage(mockTargets(graph));
  u.read("graph_slice", 'graph slice for "theme settings"', [0, 1, 3], 2_800);
  const planned = u.ledger({ input: 8_200, output: 700, model: "claude-sonnet-5" });
  return [
    {
      delay: 80,
      event: { type: "run_start", runId: `mock_plan_${Date.now().toString(36)}`, mode: "plan", model: "claude-sonnet-5", at: Date.now(), rules: [{ path: "AGENTS.md", tokens: 612 }] },
    },
    ...words("", "Looking at how the header and settings are wired.").map((s) => ({
      delay: s.delay,
      event: { type: "orchestrator_text", text: (s.event as { text: string }).text } as OrchestrationEvent,
    })),
    { delay: 300, event: { type: "plan", plan: MOCK_PLAN, awaitingApproval: true } },
    planned,
    { delay: 40, event: { type: "run_done", status: "done", summary: "", filesChanged: 0, durationMs: 1_200, costUsd: u.costUsd } },
  ];
}

function askScript(graph?: MockGraph | null): ScriptStep[] {
  const u = new MockUsage(mockTargets(graph));
  const t = mockTargets(graph);
  u.read("grep", 'grep "theme"', [2, 0, 5], 380, { untracked: true, nodes: "first" });
  u.read("read_file", t[2].path, [2], 1_300);
  const calls = [
    u.turn("assistant", "claude-haiku-4-5", 5_400, 160, 0, 3_900),
    u.turn("assistant", "claude-haiku-4-5", 1_900, 240, 9_300),
  ];
  const answer =
    "The theme is applied in `src/app/layout.tsx` via a `dark` class on `<html>`. Nothing persists it today, so it resets on reload.\n\nTwo options:\n\n1. Store it in `localStorage` and apply it before paint with an inline script.\n2. Store it in a cookie so the server can render the right class.";
  return [
    { delay: 80, event: { type: "run_start", runId: `mock_ask_${Date.now().toString(36)}`, mode: "single", model: "claude-haiku-4-5", at: Date.now() } },
    { delay: 40, event: { type: "intent", intent: "ask", reason: "A question about the code." } },
    ...tool("assistant", "q1", "grep", "theme", "4 matches"),
    calls[0],
    ...tool("assistant", "q2", "read_file", t[2].path, "38 lines"),
    calls[1],
    ...answer.split(/(?<= )/).map((chunk) => ({ delay: 14, event: { type: "answer", text: chunk } as OrchestrationEvent })),
    u.ledger(),
    { delay: 40, event: { type: "run_done", status: "done", summary: answer, filesChanged: 0, durationMs: 1_900, costUsd: u.costUsd } },
  ];
}

const SLUG_BEFORE = `import re

_SEP = re.compile(r"[^a-z0-9]+")


def slugify(text: str, sep: str = "-") -> str:
    lowered = text.lower()
    return _SEP.sub(sep, lowered).strip(sep)
`;
const SLUG_BAD = `import re
import unicodedata

_SEP = re.compile(r"[^a-z0-9]+")


def slugify(text: str, sep: str = "-") -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    lowered = ascii_text.lower()
    return _SEP.sub(sep, lowered)
`;
const SLUG_GOOD = `import re
import unicodedata

_SEP = re.compile(r"[^a-z0-9]+")


def slugify(text: str, sep: str = "-") -> str:
    # Transliterate accents (é -> e) before stripping to ASCII.
    decomposed = unicodedata.normalize("NFKD", text)
    ascii_text = decomposed.encode("ascii", "ignore").decode("ascii")
    return _SEP.sub(sep, ascii_text.lower()).strip(sep)
`;

const TEST_CMD = "python -m pytest -q -rA";

/**
 * A fix run: localize, a wrong first patch the gate rejects (regression),
 * a nudge, a rollback, a fresh second attempt, and a verified accept.
 * Both attempts share one agent id, as `solveTask` emits them.
 */
function fixScript(): ScriptStep[] {
  const a1 = "solver";
  const a2 = "solver";
  const solver = (agentId: string, title: string, attempt: number): ScriptStep => ({
    delay: 60,
    event: {
      type: "agent_start",
      agentId,
      stepId: agentId,
      role: "generalist",
      title,
      model: "claude-sonnet-5",
      wave: 0,
      attempt,
    } as OrchestrationEvent,
  });
  // Round 5 events, cast until they are part of the union.
  const phase = (name: string, ms: number, delay = 30): ScriptStep => ({
    delay,
    event: { type: "phase", name, ms } as unknown as OrchestrationEvent,
  });
  const loose = (delay: number, event: Record<string, unknown>): ScriptStep => ({
    delay,
    event: event as unknown as OrchestrationEvent,
  });
  const independentCmd = "python -m pytest -q tests/test_viberon_independent.py";
  return [
    {
      // First frame: the run exists before any model call.
      delay: 0,
      event: { type: "run_start", runId: `mock_fix_${Date.now().toString(36)}`, mode: "single", model: "claude-sonnet-5", at: Date.now() },
    },
    { delay: 40, event: { type: "checkpoint", id: "cp_fix", label: "Before fix", fileCount: 61, kind: "run" } },
    phase("setup", 1_840, 120),
    {
      delay: 80,
      event: {
        type: "localize",
        files: [
          { path: "textkit/slug.py", score: 9.4, why: ["in the issue traceback", "defines slugify"] },
          { path: "tests/test_slugify.py", score: 5.1, why: ["tests slugify"] },
          { path: "textkit/__init__.py", score: 2.3, why: ["re-exports slugify"] },
          { path: "textkit/cli.py", score: 1.2, why: ["calls slugify"] },
        ],
        snippetReproduced: true,
      } as unknown as OrchestrationEvent,
    },
    phase("localize", 620),
    loose(160, {
      type: "criteria",
      items: [
        "slugify(\"Crème brûlée\") returns \"creme-brulee\"; accented letters keep their base letter.",
        "Characters with no ASCII decomposition are dropped, not replaced with a separator.",
        "Leading and trailing separators are still stripped (\"Hello, world!\" -> \"hello-world\").",
        "A custom `sep` argument is honoured for transliterated input.",
        "Existing callers in textkit/cli.py see no change for ASCII input.",
      ],
    }),
    phase("criteria", 2_100),
    solver(a1, "Fix slugify transliteration", 1),
    {
      delay: 120,
      event: {
        type: "verification",
        agentId: a1,
        phase: "baseline",
        command: TEST_CMD,
        exitCode: 1,
        timedOut: false,
        passed: 38,
        failed: 3,
        newFailures: [],
        fixed: [],
        durationMs: 2140,
        excerpt: `FAILED tests/test_slugify.py::test_accents - AssertionError: 'crme-brle' != 'creme-brulee'
FAILED tests/test_slugify.py::test_mixed_script
FAILED tests/test_cli.py::test_windows_paths - OSError: [WinError 3]`,
      },
    },
    ...words(a1, "The traceback points at `textkit/slug.py`. Checking how `slugify` strips characters. ", "agent_thinking"),
    ...tool(a1, "f1", "graph_search", "slugify", "textkit/slug.py:6 slugify(text, sep) · 4 callers · tests/test_slugify.py"),
    ...tool(a1, "f2", "read_file", "textkit/slug.py", "9 lines"),
    ...words(a1, "`_SEP` removes every non-ASCII letter before anything transliterates it. Normalizing to NFKD first keeps the base letters."),
    ...tool(a1, "f3", "edit_file", "textkit/slug.py", "Replaced 3 lines"),
    { delay: 30, event: { type: "file_change", agentId: a1, kind: "update", path: "textkit/slug.py", before: SLUG_BEFORE, after: SLUG_BAD, summary: "NFKD-normalize before slugifying", adds: 3, removes: 2 } },
    { delay: 40, event: { type: "checkpoint", id: "cp_e1", label: "Edit batch 1", fileCount: 1, kind: "edit_batch", ref: "a41c0de" } },
    ...tool(a1, "f4", "run_command", "python -m pytest -q tests/test_slugify.py", "5 passed", true, 500),
    {
      delay: 420,
      event: {
        type: "verification",
        agentId: a1,
        phase: "gate",
        command: TEST_CMD,
        exitCode: 1,
        timedOut: false,
        passed: 39,
        failed: 2,
        newFailures: ["tests/test_slugify.py::test_trailing_separator"],
        fixed: ["tests/test_slugify.py::test_accents", "tests/test_slugify.py::test_mixed_script"],
        durationMs: 2210,
        excerpt: `FAILED tests/test_slugify.py::test_trailing_separator
    assert slugify(\"Hello, world!\") == \"hello-world\"
E   AssertionError: assert 'hello-world-' == 'hello-world'`,
        checks: [
          { name: "tests/test_slugify.py::test_accents", verdict: "fixes", before: "fail: 'crme-brle' != 'creme-brulee'", after: "pass" },
          { name: "tests/test_slugify.py::test_mixed_script", verdict: "fixes", before: "fail", after: "pass" },
          { name: "tests/test_slugify.py::test_trailing_separator", verdict: "regression", before: "pass", after: "fail: 'hello-world-' != 'hello-world'", excerpt: `assert slugify(\"Hello, world!\") == \"hello-world\"
E   AssertionError: assert 'hello-world-' == 'hello-world'` },
          { name: "tests/test_cli.py::test_windows_paths", verdict: "pre_existing", before: "fail: OSError", after: "fail: OSError" },
        ],
      } as OrchestrationEvent,
    },
    { delay: 60, event: { type: "gate", agentId: a1, decision: "reject", reason: "1 check that passed on the original now fails (test_trailing_separator).", attempt: 1 } },
    { delay: 60, event: { type: "recovery", agentId: a1, failureClass: "regression", action: "hint", detail: "The patch dropped `.strip(sep)`; trailing separators are no longer removed." } },
    ...tool(a1, "f5", "edit_file", "textkit/slug.py", "No match for old_string (closest: line 10)", false),
    ...tool(a1, "f6", "edit_file", "textkit/slug.py", "No match for old_string (closest: line 10)", false),
    { delay: 60, event: { type: "recovery", agentId: a1, failureClass: "patch_conflict", action: "rollback", detail: "Same failed edit twice. Restored the last good tree.", checkpointId: "cp_e1" } },
    { delay: 60, event: { type: "gate", agentId: a1, decision: "give_up", reason: "No proof after 2 edits; starting over with lessons.", attempt: 2 } },
    { delay: 40, event: { type: "agent_done", agentId: a1, summary: "Attempt 1 ended without proof.", tokensIn: 18_400, tokensOut: 1_900, cost: 0.041, durationMs: 4_200 } },
    solver(a2, "Fix slugify transliteration", 2),
    ...words(a2, "Lessons: keep `.strip(sep)`; normalize before lowercasing. "),
    ...tool(a2, "g1", "read_file", "textkit/slug.py", "10 lines"),
    ...tool(a2, "g2", "edit_file", "textkit/slug.py", "Replaced 4 lines"),
    { delay: 30, event: { type: "file_change", agentId: a2, kind: "update", path: "textkit/slug.py", before: SLUG_BAD, after: SLUG_GOOD, summary: "Transliterate, then strip separators", adds: 4, removes: 3 } },
    ...tool(a2, "g3", "run_command", "python -m pytest -q tests/test_slugify.py", "6 passed", true, 500),
    {
      delay: 420,
      event: {
        type: "verification",
        agentId: a2,
        phase: "gate",
        command: TEST_CMD,
        exitCode: 1,
        timedOut: false,
        passed: 40,
        failed: 1,
        newFailures: [],
        fixed: ["tests/test_slugify.py::test_accents", "tests/test_slugify.py::test_mixed_script"],
        durationMs: 2190,
        excerpt: "FAILED tests/test_cli.py::test_windows_paths - OSError: [WinError 3]",
        checks: [
          { name: "tests/test_slugify.py::test_accents", verdict: "fixes", before: "fail: 'crme-brle' != 'creme-brulee'", after: "pass" },
          { name: "tests/test_slugify.py::test_mixed_script", verdict: "fixes", before: "fail", after: "pass" },
          { command: "python repro_issue.py", verdict: "fixes", original: { exitCode: 1 }, patched: { exitCode: 0 } },
          { name: "tests/test_slugify.py::test_trailing_separator", verdict: "passes", before: "pass", after: "pass" },
          { name: "tests/test_cli.py::test_windows_paths", verdict: "pre_existing", before: "fail: OSError", after: "fail: OSError" },
        ],
      } as OrchestrationEvent,
    },
    { delay: 60, event: { type: "gate", agentId: a2, decision: "accept", reason: "Fixes 2 failing checks; no regressions. 1 failure was already failing on the original.", attempt: 1 } },
    { delay: 40, event: { type: "checkpoint", id: "cp_best", label: "Best", fileCount: 1, kind: "best", ref: "c93e1aa" } },
    ...words(a2, "Normalized to NFKD before the ASCII filter so accented letters keep their base letter, and kept the separator strip."),
    phase("gate", 4_300),
    { delay: 40, event: { type: "agent_done", agentId: a2, summary: "Verified fix.", tokensIn: 12_100, tokensOut: 1_300, cost: 0.029, durationMs: 3_100 } },
    phase("loop", 41_200),
    loose(80, { type: "independent_test", status: "written", command: independentCmd }),
    loose(1_400, { type: "independent_test", status: "ran", command: independentCmd, verdict: "fixes", seconds: 6.4 }),
    phase("testWriter", 9_800),
    phase("review", 7_600, 200),
    phase("deliver", 350),
    { delay: 40, event: ledger(30_500, 3_200, 0.07) },
    {
      delay: 60,
      event: {
        type: "run_done",
        status: "done",
        summary: "Fixed `slugify` dropping accented letters: it now NFKD-normalizes before stripping to ASCII. The reproduction and the repo's tests prove it (3 fixed, 0 regressions).",
        filesChanged: 1,
        // Setup, localize and criteria overlap, so this is under the phase sum.
        durationMs: 57_750,
        costUsd: 0.07,
      },
    },
  ];
}

export function mockScript(input: {
  prompt: string;
  interaction: Interaction;
  plan?: RunPlan;
  /** The open workspace's graph, so mock context points at real files. */
  graph?: MockGraph | null;
}): ScriptStep[] {
  if (input.interaction === "plan") return planScript(input.graph);
  if (input.interaction === "ask") return askScript(input.graph);
  if (input.interaction === "fix") return fixScript();
  return buildScript(input.prompt, input.plan, input.graph);
}

const pendingMockApprovals = new Map<string, (decision: string) => void>();

/** Called by the transport when the user answers an approval in mock mode. */
export function answerMockApproval(approvalId: string, decision: string): void {
  pendingMockApprovals.get(approvalId)?.(decision);
}

/**
 * Replay a script as an SSE `Response`, so the real transport (frame
 * parsing, batching, side effects) is exercised end to end.
 */
export function mockResponse(steps: ScriptStep[], signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let runId = "";
  const first = steps[0]?.event;
  if (first?.type === "run_start") runId = first.runId;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const step of steps) {
        await new Promise((r) => setTimeout(r, step.delay));
        if (signal.aborted) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "run_done", status: "cancelled", summary: "", filesChanged: 0, durationMs: 0, costUsd: 0 })}\n\n`,
            ),
          );
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(step.event)}\n\n`));
        // Park on approvals the way the real harness does, until answered.
        if (step.event.type === "approval_request") {
          const id = step.event.approvalId;
          const decision = await new Promise<string>((resolve) => {
            pendingMockApprovals.set(id, resolve);
            signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
          });
          pendingMockApprovals.delete(id);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "approval_resolved", approvalId: id, decision: decision === "allow_always" ? "allow" : decision })}\n\n`,
            ),
          );
        }
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "X-Run-Id": runId },
  });
}

/* ------------------------------ fixtures ---------------------------------- */

/** `GET /api/settings/keys` under `?mock=1`: DeepSeek from the env, the CLI logged in. */
export const MOCK_PROVIDER_STATUS = {
  providers: [
    { provider: "anthropic", configured: false, masked: null, fromEnv: false, envVar: "ANTHROPIC_API_KEY" },
    { provider: "deepseek", configured: true, masked: "sk-…9c2e", fromEnv: true, envVar: "DEEPSEEK_API_KEY" },
    { provider: "groq", configured: false, masked: null, fromEnv: false, envVar: "GROQ_API_KEY" },
    { provider: "gemini", configured: true, masked: "AIza…Qk3o", fromEnv: false, envVar: "GEMINI_API_KEY" },
    { provider: "nvidia", configured: false, masked: null, fromEnv: false, envVar: "NVIDIA_API_KEY" },
    { provider: "openai", configured: false, masked: null, fromEnv: false, envVar: "OPENAI_API_KEY" },
    { provider: "claude-cli", configured: true, masked: "claude 2.1.14" },
  ],
};

export const MOCK_GIT_SNAPSHOT: GitSnapshot = {
  virtual: false,
  isRepo: true,
  gitAvailable: true,
  parentRepo: null,
  status: {
    branch: { head: "feat/theme-toggle", oid: "3f9c2e1", upstream: "origin/feat/theme-toggle", ahead: 2, behind: 1 },
    files: [
      { path: "src/components/Header.tsx", group: "staged", letter: "M" },
      { path: "src/hooks/useTheme.ts", group: "staged", letter: "A" },
      { path: "src/app/layout.tsx", group: "changes", letter: "M" },
      { path: "src/styles/old.css", group: "changes", letter: "D" },
      { path: "src/lib/theme.ts", originalPath: "src/lib/colors.ts", group: "changes", letter: "R" },
      { path: "src/hooks/useTheme.test.ts", group: "untracked", letter: "U" },
      { path: "package.json", group: "conflicts", letter: "!" },
    ],
  },
  branches: [
    { name: "feat/theme-toggle", current: true, upstream: "origin/feat/theme-toggle" },
    { name: "main", current: false, upstream: "origin/main" },
    { name: "fix/header-overflow", current: false, upstream: null },
  ],
  log: [
    { hash: "3f9c2e1aa", shortHash: "3f9c2e1", author: "Dana", date: Date.now() - 3_600_000, subject: "Add header nav" },
    { hash: "a81d0c4bb", shortHash: "a81d0c4", author: "Dana", date: Date.now() - 86_400_000, subject: "Initial layout" },
  ],
};

export const MOCK_PROBLEMS: ProblemsResult = {
  virtual: false,
  running: false,
  finishedAt: Date.now(),
  checkers: [
    { checker: "tsc", ran: true, durationMs: 2400, count: 3 },
    { checker: "eslint", ran: true, durationMs: 1800, count: 2 },
  ],
  problems: [
    { file: "src/components/Header.tsx", line: 12, col: 7, severity: "error", message: "Property 'toggle' does not exist on type 'Theme'.", source: "ts", code: "TS2339" },
    { file: "src/components/Header.tsx", line: 4, col: 10, severity: "warning", message: "'Nav' is defined but never used.", source: "eslint", code: "no-unused-vars" },
    { file: "src/hooks/useTheme.ts", line: 6, col: 5, severity: "error", message: "Type 'string | null' is not assignable to type 'Theme'.", source: "ts", code: "TS2322" },
    { file: "src/app/layout.tsx", line: 21, col: 3, severity: "error", message: "Cannot find name 'ThemeScript'.", source: "ts", code: "TS2304" },
    { file: "src/lib/theme.ts", line: 2, col: 1, severity: "warning", message: "Unexpected console statement.", source: "eslint", code: "no-console" },
  ],
};

/* ------------------------- review / deliver / CI -------------------------- */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockUrlFlag(name: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

/** What the mock Source Control diff shows as the working copy of `path`. */
export function mockWorkingSource(path: string): string {
  return `// ${path}\nexport const value = 2;\nexport const added = true;\n`;
}

const MOCK_FINDINGS_WORKING = [
  {
    file: "src/hooks/useTheme.ts",
    line: 2,
    severity: "high",
    title: "localStorage read during render breaks SSR",
    detail: "`window.localStorage` is read in the initializer; on the server `window` is undefined. Read it in an effect or guard with `typeof window`.",
  },
  {
    file: "src/app/layout.tsx",
    line: 3,
    severity: "medium",
    title: "Theme class applied after first paint",
    detail: "The class is set in an effect, so dark-mode users see a light flash. Set it from an inline script in <head>.",
  },
  {
    file: "src/components/Header.tsx",
    line: 2,
    severity: "low",
    title: "Toggle button has no accessible name",
    detail: "The icon-only button needs aria-label.",
  },
];

const MOCK_FINDINGS_PR = [
  {
    file: "textkit/slug.py",
    line: 7,
    severity: "medium",
    title: "Letters without a decomposition are still dropped",
    detail: "Characters such as 'ø' have no NFKD decomposition and are removed rather than transliterated. Consider a small fallback table.",
  },
  {
    file: "tests/test_slugify.py",
    line: 18,
    severity: "low",
    title: "No test for an all-non-ASCII title",
    detail: "slugify('日本語') returns '' — assert the intended fallback.",
  },
];

/** Canned `/api/review` answers; `target: { prUrl }` gets the PR fixture. */
export async function mockReviewResponse(
  tool: string,
  target: unknown,
): Promise<{ ok: boolean; status: number; body: unknown; error?: string }> {
  await wait(tool === "improve" ? 900 : 600);
  const pr = Boolean(target && typeof target === "object" && "prUrl" in (target as object));
  if (tool === "review") {
    return {
      ok: true,
      status: 200,
      body: {
        review: {
          summary: pr
            ? "Normalizes to NFKD before the ASCII filter and keeps the separator strip. Small, well-tested change."
            : "Adds a persisted theme hook and wires it into the header and layout.",
          effort: pr ? 2 : 3,
          findings: pr ? MOCK_FINDINGS_PR : MOCK_FINDINGS_WORKING,
          security: null,
          tests: pr ? "adequate" : "missing",
          omitted: pr ? [] : ["package-lock.json"],
        },
      },
    };
  }
  if (tool === "describe") {
    return {
      ok: true,
      status: 200,
      body: {
        title: "Fix slugify dropping accented letters",
        body: "`slugify` removed every non-ASCII letter before transliterating, so `Crème brûlée` became `crme-brle`.\n\nIt now NFKD-normalizes first and keeps the trailing-separator strip.\n\n- 3 checks fixed, 0 regressions (`python -m pytest -q -rA`)\n- 1 pre-existing failure unchanged: `tests/test_cli.py::test_windows_paths`",
        type: "bug",
      },
    };
  }
  if (tool === "improve") {
    return {
      ok: true,
      status: 200,
      body: {
        suggestions: [
          {
            file: "src/app/layout.tsx",
            startLine: 3,
            endLine: 3,
            existing: "export const added = true;",
            improved: "export const added = true as const;",
            why: "Narrow the literal type so consumers can switch on it.",
            score: 8,
          },
          {
            file: "src/hooks/useTheme.ts",
            startLine: 6,
            endLine: 7,
            existing: 'const stored = localStorage.getItem("theme");\nreturn stored ?? "light";',
            improved:
              'const stored = typeof window === "undefined" ? null : localStorage.getItem("theme");\nreturn stored === "dark" ? "dark" : "light";',
            why: "Guard the server render and reject unknown stored values.",
            score: 9,
          },
        ],
      },
    };
  }
  if (tool === "learn") {
    return {
      ok: true,
      status: 200,
      body: { count: 4, notes: ["Prefer early returns", "Tests beside sources", "No default exports", "Name hooks useX"] },
    };
  }
  return { ok: false, status: 400, body: null, error: `Unknown tool ${tool}` };
}

let mockDeliverConfirmed = false;

/** `?mock=1&deliver=workflow` makes the first attempt ask for confirmation; `deliver=fail` fails. */
export async function mockDeliver(input: { branch: string; confirm?: boolean }) {
  await wait(900);
  const mode = mockUrlFlag("deliver");
  if (mode === "fail") {
    return {
      ok: false as const,
      error: "git push failed: remote rejected (protected branch hook declined)",
      needsConfirm: false,
      files: [] as string[],
    };
  }
  if (mode === "workflow" && !input.confirm && !mockDeliverConfirmed) {
    return {
      ok: false as const,
      error: "The change touches .github/workflows/ci.yml. Workflow changes need an explicit confirmation.",
      needsConfirm: true,
      files: [".github/workflows/ci.yml"],
    };
  }
  mockDeliverConfirmed = true;
  return {
    ok: true as const,
    branch: input.branch,
    commit: "b71c2e9",
    prUrl: "https://github.com/acme/textkit/pull/42",
    prNumber: 42,
    updated: false,
  };
}

export async function mockReport(issueUrl: string) {
  await wait(500);
  return { ok: true as const, commentUrl: `${issueUrl}#issuecomment-2210034` };
}

const mockCiPolls = new Map<string, { polls: number; rerunAt: number | null; reruns: number }>();

/** Pending, then a failing test job; after a re-run, pending once more, then green. */
export function mockCi(prUrl: string): unknown {
  const s = mockCiPolls.get(prUrl) ?? { polls: 0, rerunAt: null, reruns: 0 };
  s.polls += 1;
  mockCiPolls.set(prUrl, s);
  const base = "https://github.com/acme/textkit/actions/runs/9120/job/";
  const lint = {
    name: "lint",
    conclusion: s.polls > 1 ? "success" : null,
    status: s.polls > 1 ? "completed" : "in_progress",
    url: `${base}1`,
  };
  if (s.polls === 1 || (s.rerunAt !== null && s.polls === s.rerunAt + 1)) {
    return {
      headSha: "b71c2e9a0f",
      state: "pending",
      reruns: s.reruns,
      rerunLimit: 3,
      checks: [
        lint,
        { name: "test (3.12)", conclusion: null, status: "in_progress", url: `${base}2` },
        { name: "test (3.9)", conclusion: null, status: "queued", url: `${base}3` },
      ],
    };
  }
  const rerun = s.rerunAt !== null;
  return {
    headSha: "b71c2e9a0f",
    state: rerun ? "success" : "failure",
    reruns: s.reruns,
    rerunLimit: 3,
    checks: [
      lint,
      { name: "test (3.12)", conclusion: "success", status: "completed", url: `${base}2` },
      rerun
        ? { name: "test (3.9)", conclusion: "success", status: "completed", url: `${base}3` }
        : {
            name: "test (3.9)",
            conclusion: "failure",
            status: "completed",
            url: `${base}3`,
            logExcerpt:
              "FAILED tests/test_cli.py::test_windows_paths - OSError: [WinError 3] The system cannot find the path specified\n1 failed, 40 passed in 3.41s",
          },
    ],
  };
}

export async function mockRerun(checkName: string) {
  await wait(500);
  let reruns = 0;
  for (const s of mockCiPolls.values()) {
    s.reruns += 1;
    s.rerunAt = s.polls;
    reruns = s.reruns;
  }
  void checkName;
  return { ok: true, reruns, limit: 3 };
}

const mockTaskList: Record<string, unknown>[] = [
  {
    id: "t_8f2a",
    kind: "fix",
    repoKey: "mock",
    task: "Fix slugify dropping accented letters\n\nhttps://github.com/acme/textkit/issues/17",
    source: "issue",
    issueUrl: "https://github.com/acme/textkit/issues/17",
    state: "running",
    createdAt: Date.now() - 95_000,
    startedAt: Date.now() - 80_000,
  },
  {
    id: "t_77c1",
    kind: "fix",
    repoKey: "mock",
    task: "Fix the failing CI checks on https://github.com/acme/textkit/pull/41",
    source: "ui",
    state: "queued",
    createdAt: Date.now() - 40_000,
  },
  {
    id: "t_51de",
    kind: "review",
    repoKey: "mock",
    task: "Review https://github.com/acme/textkit/pull/39",
    source: "cli",
    state: "done",
    createdAt: Date.now() - 3_900_000,
    finishedAt: Date.now() - 3_700_000,
  },
  {
    id: "t_40b9",
    kind: "fix",
    repoKey: "mock",
    task: "Parse CRLF line endings in the config loader",
    source: "api",
    state: "done",
    createdAt: Date.now() - 7_600_000,
    finishedAt: Date.now() - 7_200_000,
    prUrl: "https://github.com/acme/textkit/pull/38",
  },
  {
    id: "t_3a07",
    kind: "fix",
    repoKey: "mock",
    task: "Windows path separators in textkit.cli",
    source: "ui",
    state: "failed",
    createdAt: Date.now() - 86_000_000,
    finishedAt: Date.now() - 85_500_000,
    error: "No proof after 2 attempts",
  },
];

export function mockTasks(): unknown {
  return { tasks: mockTaskList.map((t) => (t.__batchDemo ? mockTaskById(t.id as string) : { ...t })) };
}

export function mockEnqueue(input: Record<string, unknown>): unknown {
  const task = { id: `t_${Math.random().toString(16).slice(2, 6)}`, state: "queued", createdAt: Date.now(), ...input };
  mockTaskList.push(task);
  return task;
}

export function mockCancelTask(id: string): void {
  const task = mockTaskList.find((t) => t.id === id);
  if (task) Object.assign(task, { state: "cancelled", finishedAt: Date.now() });
}

/**
 * The live events of a running fix task: the fix replay. A combined "fix
 * every issue in one PR" task works through a per-issue todo list first, so
 * stopping it mid-way can be checked (no todo may keep spinning).
 */
export function mockTaskScript(task?: { task: string }): ScriptStep[] {
  const steps = fixScript();
  if (!task || !/one pull request|in one PR/i.test(task.task)) return steps;
  const start = steps.findIndex((s) => s.event.type === "agent_start");
  const agentId = start >= 0 && steps[start].event.type === "agent_start" ? steps[start].event.agentId : "solver";
  const todos = (active: number): ScriptStep => ({
    delay: 40,
    event: {
      type: "todos",
      agentId,
      items: MOCK_BATCH.map((item, i) => ({
        id: String(i + 1),
        content: item,
        status: i < active ? "completed" : i === active ? "in_progress" : "pending",
      })),
    },
  });
  const out = [...steps];
  out.splice(start + 1, 0, todos(0));
  // Halfway through, the first issue is done and the second in progress.
  out.splice(Math.floor(out.length / 2), 0, todos(1));
  return out;
}

const MOCK_BATCH = [
  "#2499 slugify() drops accented letters",
  "#2503 Config loader fails on CRLF line endings",
  "#2511 wrap() splits surrogate pairs",
  "#2517 CLI ignores --encoding on stdin",
];

/**
 * A 10-issue batch that exercises every batch-view state: queued, running
 * (with a live phase and a fast-path attempt in progress), verified via the
 * fast path (1 call), verified via the full agent, unproven ("gave up"
 * without proof), failed, and cancelled. `combined` shares one PR url
 * across every verified row; per-issue mode gives each its own.
 */
interface MockBatchIssueSpec {
  number: number;
  title: string;
  /** Ms after the batch starts that this issue starts / finishes. */
  startAt: number;
  finishAt: number | null;
  status: BatchIssueStatus;
  fastPath?: { used: boolean; calls: number; accepted: boolean };
  detail?: string;
  timing: { modelMs: number; toolsMs: number; proofMs: number };
  usage: { input: number; output: number; cached: number; calls: number };
}

type BatchIssueStatus = "queued" | "running" | "verified" | "unproven" | "failed" | "cancelled";

const MOCK_BATCH_10: MockBatchIssueSpec[] = [
  { number: 201, title: "slugify() drops accented letters", startAt: 0, finishAt: 7_500, status: "verified", fastPath: { used: true, calls: 1, accepted: true }, timing: { modelMs: 4_200, toolsMs: 2_600, proofMs: 700 }, usage: { input: 5_400, output: 380, cached: 2_100, calls: 1 } },
  { number: 202, title: "Config loader fails on CRLF line endings", startAt: 500, finishAt: 9_800, status: "verified", fastPath: { used: true, calls: 1, accepted: true }, timing: { modelMs: 5_100, toolsMs: 3_200, proofMs: 800 }, usage: { input: 6_100, output: 410, cached: 2_400, calls: 1 } },
  { number: 203, title: "wrap() splits surrogate pairs at the width boundary", startAt: 1_000, finishAt: 12_400, status: "verified", fastPath: { used: true, calls: 1, accepted: true }, timing: { modelMs: 6_300, toolsMs: 4_100, proofMs: 900 }, usage: { input: 7_200, output: 520, cached: 3_000, calls: 1 } },
  { number: 204, title: "CLI ignores --encoding when reading from stdin", startAt: 0, finishAt: 43_000, status: "verified", fastPath: { used: true, calls: 1, accepted: false }, timing: { modelMs: 21_400, toolsMs: 16_800, proofMs: 3_600 }, usage: { input: 28_000, output: 2_600, cached: 11_400, calls: 6 } },
  { number: 205, title: "Windows path separators in textkit.cli output", startAt: 2_000, finishAt: 56_000, status: "verified", fastPath: { used: false, calls: 0, accepted: false }, timing: { modelMs: 27_100, toolsMs: 20_300, proofMs: 5_200 }, usage: { input: 33_500, output: 3_100, cached: 14_200, calls: 7 } },
  { number: 206, title: "truncate() ellipsis argument ignored on empty strings", startAt: 0, finishAt: 31_000, status: "unproven", fastPath: { used: true, calls: 1, accepted: false }, detail: "gave up after 41,800 tokens without proof: the reproduction still passes on the base commit.", timing: { modelMs: 14_800, toolsMs: 12_600, proofMs: 2_200 }, usage: { input: 32_400, output: 3_600, cached: 5_800, calls: 5 } },
  { number: 207, title: "Support Python 3.13 in CI matrix", startAt: 3_000, finishAt: 21_000, status: "failed", detail: "worktree checkout failed: origin/main moved during the run.", timing: { modelMs: 8_200, toolsMs: 6_900, proofMs: 0 }, usage: { input: 11_000, output: 900, cached: 2_800, calls: 2 } },
  { number: 208, title: "Document the truncate() ellipsis argument", startAt: 5_000, finishAt: 15_000, status: "cancelled", detail: "stopped by the user.", timing: { modelMs: 3_100, toolsMs: 2_400, proofMs: 0 }, usage: { input: 4_800, output: 320, cached: 900, calls: 1 } },
  { number: 209, title: "Numeric locale separators break the CSV export", startAt: 4_000, finishAt: null, status: "running", timing: { modelMs: 0, toolsMs: 0, proofMs: 0 }, usage: { input: 0, output: 0, cached: 0, calls: 0 } },
  { number: 210, title: "Retry backoff never resets after a success", startAt: 62_000, finishAt: null, status: "queued", timing: { modelMs: 0, toolsMs: 0, proofMs: 0 }, usage: { input: 0, output: 0, cached: 0, calls: 0 } },
];

/** Live phases a running issue cycles through, for the batch view's phase text. */
const MOCK_RUN_PHASES = ["localize", "editing", "verifying"];

/**
 * `task.issueResults[]` for a batch, computed fresh from wall time so the
 * view shows a live clock and progress without any stored mutable state.
 */
export function mockBatchIssueResults(startedAt: number, combined: boolean): unknown[] {
  const now = Date.now();
  const elapsed = now - startedAt;
  return MOCK_BATCH_10.map((spec) => {
    const url = `https://github.com/acme/textkit/issues/${spec.number}`;
    if (elapsed < spec.startAt) {
      return { url, number: spec.number, title: spec.title, status: "queued" };
    }
    const running = spec.finishAt === null || elapsed < spec.finishAt;
    if (running) {
      const since = elapsed - spec.startAt;
      const phase = MOCK_RUN_PHASES[Math.floor(since / 5_000) % MOCK_RUN_PHASES.length];
      return {
        url,
        number: spec.number,
        title: spec.title,
        status: "running",
        phase,
        startedAt: startedAt + spec.startAt,
        timing: { modelMs: Math.round(since * 0.55), toolsMs: Math.round(since * 0.35), proofMs: Math.round(since * 0.1) },
        usage: { input: Math.round(since * 0.7), output: Math.round(since * 0.08), cached: Math.round(since * 0.3), calls: 1 + Math.floor(since / 8_000) },
        fastPath: since < 8_000 ? { used: true, calls: 1, accepted: false } : undefined,
      };
    }
    return {
      url,
      number: spec.number,
      title: spec.title,
      status: spec.status,
      startedAt: startedAt + spec.startAt,
      finishedAt: startedAt + (spec.finishAt ?? spec.startAt),
      timing: spec.timing,
      usage: spec.usage,
      fastPath: spec.fastPath,
      detail: spec.detail,
      prUrl: spec.status === "verified" ? (combined ? "https://github.com/acme/textkit/pull/70" : `https://github.com/acme/textkit/pull/${300 + spec.number}`) : undefined,
    };
  });
}

/** A batch task's live totals from its rows, for the header while `usage` has not settled yet. */
function mockBatchTotals(rows: unknown[]): { inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number; calls: number } {
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, calls = 0;
  for (const row of rows) {
    const r = row as { usage?: { input?: number; output?: number; cached?: number; calls?: number } };
    inputTokens += r.usage?.input ?? 0;
    outputTokens += r.usage?.output ?? 0;
    cacheReadTokens += r.usage?.cached ?? 0;
    calls += r.usage?.calls ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, costUsd: Math.round((inputTokens * 3 + outputTokens * 15) / 1e6 * 1e4) / 1e4, calls };
}

/** A combined task for "fix every open issue in one pull request" (10 issues, all batch states). */
function mockCombinedTask(combined = true): Record<string, unknown> {
  const startedAt = Date.now();
  const task = {
    id: `t_${Math.random().toString(16).slice(2, 6)}`,
    kind: "fix",
    repoKey: "mock",
    task: `Fix ${MOCK_BATCH_10.length} open issues ${combined ? "in one pull request" : "(one pull request per issue)"}\n\n${MOCK_BATCH.join("\n")}`,
    source: "issue",
    state: "running",
    createdAt: startedAt,
    startedAt,
    model: "claude-sonnet-5",
    issueUrls: MOCK_BATCH_10.map((s) => `https://github.com/acme/textkit/issues/${s.number}`),
    __batchDemo: true,
    __combined: combined,
  };
  mockTaskList.unshift(task);
  return task;
}

/** `GET /api/tasks/:id` under `?mock=1`: recomputes a batch's `issueResults` live. */
export function mockTaskById(id: string): unknown {
  const task = mockTaskList.find((t) => t.id === id);
  if (!task) return null;
  if (!task.__batchDemo) return { ...task };
  const rows = mockBatchIssueResults(Number(task.startedAt), Boolean(task.__combined));
  const allDone = rows.every((r) => (r as { status: string }).status !== "queued" && (r as { status: string }).status !== "running");
  return {
    ...task,
    state: allDone ? "done" : "running",
    finishedAt: allDone ? Date.now() : undefined,
    issueResults: rows,
    usage: mockBatchTotals(rows),
  };
}

/* ------------------------------ issues → PR ------------------------------- */

interface MockIssue {
  number: number;
  title: string;
  labels: string[];
  author: string;
  comments: number;
  updatedAt: string;
  task: Record<string, unknown> | null;
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const mockIssueList: MockIssue[] = [
  { number: 52, title: "slugify() drops accented letters instead of transliterating them", labels: ["bug", "viberon"], author: "mkdir-p", comments: 3, updatedAt: ago(1_800_000), task: { id: "t_8f2a", state: "running" } },
  { number: 51, title: "Config loader fails on CRLF line endings", labels: ["bug"], author: "hanna-v", comments: 1, updatedAt: ago(5_400_000), task: { id: "t_40b9", state: "done", prUrl: "https://github.com/acme/textkit/pull/53" } },
  { number: 49, title: "wrap() splits surrogate pairs at the width boundary", labels: ["bug", "unicode"], author: "tkoenig", comments: 0, updatedAt: ago(14_000_000), task: null },
  { number: 47, title: "CLI ignores --encoding when reading from stdin", labels: ["cli"], author: "jdoe", comments: 5, updatedAt: ago(90_000_000), task: { id: "t_3a07", state: "failed", error: "No proof after 2 attempts: the reproduction passes on the base commit." } },
  { number: 44, title: "Windows path separators in textkit.cli output", labels: ["windows", "viberon"], author: "r-ito", comments: 2, updatedAt: ago(170_000_000), task: { id: "t_2c11", state: "done", note: "Fix is plausible but unproven (no failing check before the patch); kept local on viberon/windows-path-separators." } },
  { number: 41, title: "Document the truncate() ellipsis argument", labels: ["docs", "good first issue"], author: "mkdir-p", comments: 0, updatedAt: ago(260_000_000), task: null },
  { number: 38, title: "Support Python 3.13 in CI matrix", labels: [], author: "hanna-v", comments: 7, updatedAt: ago(600_000_000), task: null },
];

/** Mock-only: when each fix was queued, to walk it queued → running → done. */
const mockQueuedAt = new Map<number, number>();

let mockWatchConfig: Record<string, unknown> = {
  enabled: false,
  label: "viberon",
  intervalMinutes: 15,
  lastCheckedAt: Date.now() - 420_000,
  handled: 2,
};

function mockAdvance(issue: MockIssue): void {
  const at = mockQueuedAt.get(issue.number);
  if (!at || !issue.task) return;
  const age = Date.now() - at;
  if (age > 25_000) {
    Object.assign(issue.task, { state: "done", prUrl: `https://github.com/acme/textkit/pull/${60 + issue.number}` });
    mockQueuedAt.delete(issue.number);
  } else if (age > 6_000) {
    issue.task.state = "running";
  }
}

export function mockIssues(label: string): unknown {
  const wanted = label.trim().toLowerCase();
  mockIssueList.forEach(mockAdvance);
  return {
    repo: { owner: "acme", repo: "textkit" },
    issues: mockIssueList
      .filter((i) => !wanted || i.labels.some((l) => l.toLowerCase() === wanted))
      .map((i) => ({
        ...i,
        url: `https://github.com/acme/textkit/issues/${i.number}`,
        task: i.task ? { ...i.task } : null,
      })),
    watch: { ...mockWatchConfig },
  };
}

export function mockFixIssues(numbers: number[], combined = false, batch = false): unknown {
  // A batch (several issues, one task, `combined` picks one shared PR vs. one per issue).
  if (batch || (combined && numbers.length > 1)) return { tasks: [mockCombinedTask(combined)], skipped: [] };
  if (combined) return { tasks: [mockCombinedTask(true)], skipped: [] };
  const tasks: unknown[] = [];
  const skipped: { number: number; reason: string }[] = [];
  for (const n of numbers) {
    const issue = mockIssueList.find((i) => i.number === n);
    const state = issue?.task?.state;
    if (!issue) skipped.push({ number: n, reason: "not an open issue" });
    else if (state === "queued" || state === "running") skipped.push({ number: n, reason: "already has a task in progress" });
    else if (state === "done" && issue.task?.prUrl) skipped.push({ number: n, reason: "already has a pull request" });
    else {
      const task = { id: `t_${Math.random().toString(16).slice(2, 6)}`, state: "queued" };
      issue.task = task;
      mockQueuedAt.set(n, Date.now());
      tasks.push({
        ...task,
        kind: "fix",
        repoKey: "mock",
        task: `Fix #${n}: ${issue.title}`,
        source: "issue",
        issueUrl: `https://github.com/acme/textkit/issues/${n}`,
        createdAt: Date.now(),
      });
    }
  }
  return { tasks, skipped };
}

export function mockWatch(): unknown {
  return { ...mockWatchConfig };
}

export function mockSaveWatch(input: Record<string, unknown>): unknown {
  mockWatchConfig = {
    ...mockWatchConfig,
    enabled: input.enabled,
    label: input.label,
    intervalMinutes: input.intervalMinutes,
    lastCheckedAt: Date.now(),
  };
  return { ...mockWatchConfig };
}

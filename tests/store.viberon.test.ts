import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_SETTINGS,
  GRAPH_TAB_PATH,
  useViberon,
  WELCOME_TAB_PATH,
} from "@/store/viberon";
import { computeWaves, countLineDiff } from "@/lib/agents/events";
import type { OrchestrationEvent, PlanStep } from "@/lib/agents/events";
import { MAX_CONCURRENCY } from "@/lib/limits";

/**
 * The store is the contract both shells render from, so these cover the
 * reducer paths a live run actually exercises: streaming text into a lane,
 * closing tool calls, tracking file changes, and tab bookkeeping.
 */

function resetStore(): void {
  useViberon.setState({
    repoKey: "test-repo",
    repoLabel: "Test",
    rootPath: "/tmp/test",
    appMode: "chat",
    tabs: [{ path: WELCOME_TAB_PATH, label: "Welcome" }],
    activeTabPath: WELCOME_TAB_PATH,
    messages: [],
    run: null,
    runHistory: [],
    streaming: false,
    terminals: [],
    fileList: [],
    pulseIds: [],
    expandedFolders: new Set<string>(),
    settings: DEFAULT_SETTINGS,
  });
}

function startRun(): void {
  useViberon
    .getState()
    .startRun({ prompt: "build a thing", model: "claude-opus-5", mode: "orchestrated" });
}

function apply(event: OrchestrationEvent): void {
  useViberon.getState().applyEvent(event);
}

const STEPS: PlanStep[] = [
  {
    id: "scaffold",
    title: "Scaffold",
    role: "architect",
    detail: "",
    files: ["package.json"],
    dependsOn: [],
  },
  {
    id: "ui",
    title: "Build UI",
    role: "frontend",
    detail: "",
    files: ["app/page.tsx"],
    dependsOn: ["scaffold"],
  },
  {
    id: "api",
    title: "Build API",
    role: "backend",
    detail: "",
    files: ["app/api/route.ts"],
    dependsOn: ["scaffold"],
  },
];

describe("computeWaves", () => {
  it("puts independent steps in the same wave", () => {
    const waves = computeWaves(STEPS);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toEqual(["scaffold"]);
    expect([...waves[1]].sort()).toEqual(["api", "ui"]);
  });

  it("does not deadlock on a dependency cycle", () => {
    const cyclic: PlanStep[] = [
      { id: "a", title: "A", role: "frontend", detail: "", files: [], dependsOn: ["b"] },
      { id: "b", title: "B", role: "backend", detail: "", files: [], dependsOn: ["a"] },
    ];
    const waves = computeWaves(cyclic);
    // Degraded, but every step is still scheduled exactly once.
    expect(waves.flat().sort()).toEqual(["a", "b"]);
  });

  it("ignores dependencies on steps that do not exist", () => {
    const waves = computeWaves([
      { id: "only", title: "Only", role: "docs", detail: "", files: [], dependsOn: ["ghost"] },
    ]);
    expect(waves).toEqual([["only"]]);
  });
});

describe("countLineDiff", () => {
  it("counts added and removed lines", () => {
    expect(countLineDiff("a\nb", "a\nb\nc")).toEqual({ adds: 1, removes: 0 });
    expect(countLineDiff("a\nb\nc", "a")).toEqual({ adds: 0, removes: 2 });
  });

  it("treats a new file as all additions", () => {
    expect(countLineDiff(null, "x\ny")).toEqual({ adds: 2, removes: 0 });
  });
});

describe("run reducer", () => {
  beforeEach(resetStore);

  it("seeds a queued lane per plan step", () => {
    startRun();
    apply({
      type: "plan",
      plan: { summary: "s", steps: STEPS, waves: computeWaves(STEPS) },
    });

    const run = useViberon.getState().run!;
    expect(run.status).toBe("running");
    expect(run.agents).toHaveLength(3);
    expect(run.agents.every((a) => a.status === "queued")).toBe(true);
    // Wave index is derived from the plan so lanes group correctly.
    expect(run.agents.find((a) => a.id === "ui")!.wave).toBe(1);
  });

  it("streams text and thinking into the right lane only", () => {
    startRun();
    apply({
      type: "agent_start",
      agentId: "ui",
      stepId: "ui",
      role: "frontend",
      title: "Build UI",
      model: "claude-sonnet-5",
      wave: 0,
    });
    apply({
      type: "agent_start",
      agentId: "api",
      stepId: "api",
      role: "backend",
      title: "Build API",
      model: "claude-sonnet-5",
      wave: 0,
    });
    apply({ type: "agent_text", agentId: "ui", text: "hello " });
    apply({ type: "agent_text", agentId: "ui", text: "world" });
    apply({ type: "agent_thinking", agentId: "api", text: "considering" });

    const agents = useViberon.getState().run!.agents;
    expect(agents.find((a) => a.id === "ui")!.text).toBe("hello world");
    expect(agents.find((a) => a.id === "ui")!.thinking).toBe("");
    expect(agents.find((a) => a.id === "api")!.thinking).toBe("considering");
    expect(agents.find((a) => a.id === "api")!.text).toBe("");
  });

  it("closes the matching in-flight tool call on end", () => {
    startRun();
    apply({
      type: "agent_start",
      agentId: "ui",
      stepId: "ui",
      role: "frontend",
      title: "Build UI",
      model: "m",
      wave: 0,
    });
    apply({
      type: "agent_tool",
      agentId: "ui",
      tool: "read_file",
      args: "path: a.ts",
      phase: "start",
    });
    apply({
      type: "agent_tool",
      agentId: "ui",
      tool: "read_file",
      args: "path: a.ts",
      phase: "end",
      result: "ok",
      ok: true,
    });

    const tools = useViberon.getState().run!.agents[0].tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].running).toBe(false);
    expect(tools[0].ok).toBe(true);
  });

  it("records file changes and mirrors them into open tabs", () => {
    useViberon.getState().openTab("app/page.tsx", "old");
    startRun();
    apply({
      type: "file_change",
      agentId: "ui",
      kind: "update",
      path: "app/page.tsx",
      before: "old",
      after: "new",
      summary: "rewrote it",
      adds: 1,
      removes: 1,
    });

    const state = useViberon.getState();
    expect(state.run!.changes).toHaveLength(1);
    expect(state.run!.changes[0].path).toBe("app/page.tsx");
    // The editor must show the agent's write immediately.
    expect(state.tabs.find((t) => t.path === "app/page.tsx")!.source).toBe("new");
  });

  it("keeps the ledger from the most recent ledger event", () => {
    startRun();
    apply({
      type: "ledger",
      ledger: {
        sentTokens: 1200,
        dedupedTokens: 300,
        baselineTokens: 9000,
        savedTokens: 7800,
        savedPercent: 87,
        events: [],
      },
      tokensIn: 5000,
      tokensOut: 900,
      tokensCached: 4000,
      costUsd: 0.05,
      uncachedUsd: 0.2,
    });

    const run = useViberon.getState().run!;
    expect(run.ledger!.savedPercent).toBe(87);
    expect(run.tokensCached).toBe(4000);
    expect(run.uncachedUsd).toBeGreaterThan(run.costUsd);
  });

  it("moves a finished run into history exactly once", () => {
    startRun();
    apply({
      type: "run_done",
      summary: "done",
      filesChanged: 2,
      durationMs: 1000,
      costUsd: 0.01,
    });
    useViberon.getState().endRun("done");

    const state = useViberon.getState();
    expect(state.streaming).toBe(false);
    expect(state.runHistory).toHaveLength(1);
    expect(state.runHistory[0].summary).toBe("done");
  });

  it("queues an approval request and clears it once answered", () => {
    startRun();
    apply({
      type: "approval_request",
      approvalId: "ap-1",
      agentId: "ui",
      command: "rm -rf build",
      reason: "not auto-approved",
    });
    expect(useViberon.getState().run!.approvals).toHaveLength(1);

    useViberon.getState().dismissApproval("ap-1");
    expect(useViberon.getState().run!.approvals).toHaveLength(0);
  });
});

describe("tabs", () => {
  beforeEach(resetStore);

  it("activates an existing tab instead of duplicating it", () => {
    const store = useViberon.getState();
    store.openTab("a.ts", "x");
    store.openTab("b.ts", "y");
    store.openTab("a.ts");

    const state = useViberon.getState();
    expect(state.tabs.filter((t) => t.path === "a.ts")).toHaveLength(1);
    expect(state.activeTabPath).toBe("a.ts");
  });

  it("never leaves the editor with zero tabs", () => {
    useViberon.getState().openTab("a.ts", "x");
    useViberon.getState().closeTab("a.ts");
    useViberon.getState().closeTab(WELCOME_TAB_PATH);

    expect(useViberon.getState().tabs.length).toBeGreaterThan(0);
  });

  it("falls back to a neighbouring tab when the active one closes", () => {
    useViberon.getState().openTab("a.ts", "x");
    useViberon.getState().openTab("b.ts", "y");
    useViberon.getState().closeTab("b.ts");

    expect(useViberon.getState().activeTabPath).toBe("a.ts");
  });

  it("opens the graph tab once", () => {
    useViberon.getState().openGraphTab();
    useViberon.getState().openGraphTab();

    const tabs = useViberon.getState().tabs.filter((t) => t.path === GRAPH_TAB_PATH);
    expect(tabs).toHaveLength(1);
    expect(useViberon.getState().activeTabPath).toBe(GRAPH_TAB_PATH);
  });

  it("marks a tab dirty on a local edit and clean after save", () => {
    useViberon.getState().openTab("a.ts", "x");
    useViberon.getState().updateTabSource("a.ts", "xy", true);
    expect(useViberon.getState().tabs.find((t) => t.path === "a.ts")!.dirty).toBe(true);

    useViberon.getState().updateTabSource("a.ts", "xy", false);
    expect(useViberon.getState().tabs.find((t) => t.path === "a.ts")!.dirty).toBe(false);
  });
});

describe("settings", () => {
  beforeEach(resetStore);

  it("clamps out-of-range values to what the API accepts", () => {
    useViberon.getState().setSettings({
      concurrency: 99,
      retrievalDepth: 0,
      maxNodes: 1000,
      editorFontSize: 2,
    });

    const settings = useViberon.getState().settings;
    expect(settings.concurrency).toBe(MAX_CONCURRENCY);
    expect(settings.retrievalDepth).toBe(1);
    expect(settings.maxNodes).toBe(60);
    expect(settings.editorFontSize).toBe(10);
  });

  it("allows the new concurrency ceiling and still clamps above it", () => {
    useViberon.getState().setSettings({ concurrency: MAX_CONCURRENCY });
    expect(useViberon.getState().settings.concurrency).toBe(10);

    useViberon.getState().setSettings({ concurrency: 99 });
    expect(useViberon.getState().settings.concurrency).toBe(10);
  });

  it("restores defaults on reset", () => {
    useViberon.getState().setSettings({ agentMode: "single", model: "claude-haiku-4-5" });
    useViberon.getState().resetSettings();
    expect(useViberon.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});

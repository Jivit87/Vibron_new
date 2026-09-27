import { describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { normalizeEvalRow, readPhaseMs } from "@/lib/client/eval";
import { MOCK_PROVIDER_STATUS, mockScript } from "@/lib/client/mock-run";
import { anyProviderReady, normalizeProviderStatus } from "@/lib/client/providers";
import {
  createRun,
  impliedOutcomes,
  mergePhaseMs,
  normalizeCriteria,
  normalizeIndependentTest,
  normalizePhase,
  phaseStrip,
  reduceRun,
  tailWindow,
  type RunState,
} from "@/lib/client/run-reducer";

let n = 0;
const ctx = { now: 1000, nextId: (p: string) => `${p}_${++n}` };

function fresh(): RunState {
  return createRun({ id: "r", prompt: "p", model: "m", mode: "single", now: 0, interaction: "fix" });
}

/** Round 5 events are not in the union yet; the reducer must take them anyway. */
const ev = (e: Record<string, unknown>) => e as unknown as OrchestrationEvent;

function fold(events: OrchestrationEvent[], run = fresh()): RunState {
  return events.reduce((r, e) => reduceRun(r, e, ctx), run);
}

describe("criteria event", () => {
  it("stores trimmed, non-empty string items", () => {
    const run = fold([ev({ type: "criteria", items: [" a ", "", 3, null, "b"] })]);
    expect(run.criteria).toEqual(["a", "b"]);
  });

  it("ignores malformed or empty payloads and keeps the previous list", () => {
    const run = fold([
      ev({ type: "criteria", items: ["keep"] }),
      ev({ type: "criteria" }),
      ev({ type: "criteria", items: "nope" }),
      ev({ type: "criteria", items: [] }),
    ]);
    expect(run.criteria).toEqual(["keep"]);
    expect(normalizeCriteria(null)).toBeNull();
  });
});

describe("independent_test event", () => {
  it("moves written -> ran and keeps the command from written", () => {
    const run = fold([
      ev({ type: "independent_test", status: "written", command: "pytest -q t.py" }),
      ev({ type: "independent_test", status: "ran", verdict: "fixes", seconds: 6.4 }),
    ]);
    expect(run.independentTest).toMatchObject({ status: "ran", command: "pytest -q t.py", verdict: "fixes", seconds: 6.4 });
  });

  it("normalizes dashes, drops bad fields, and rejects unknown statuses", () => {
    expect(normalizeIndependentTest({ status: "gave-up", seconds: -1, command: 4 })).toEqual({
      status: "gave_up",
      command: undefined,
      verdict: undefined,
      seconds: undefined,
      before: undefined,
      after: undefined,
      reason: undefined,
    });
    expect(normalizeIndependentTest({ status: "ran", verdict: "still-failing" })?.verdict).toBe("still_failing");
    expect(normalizeIndependentTest({ status: "ran", verdict: "passes" })?.verdict).toBe("pass");
    expect(normalizeIndependentTest({ status: "exploded" })).toBeNull();
    const run = fold([ev({ type: "independent_test", status: "exploded" })]);
    expect(run.independentTest).toBeUndefined();
  });

  it("reads original/patched outcomes when sent, and implies them from the verdict otherwise", () => {
    const t = normalizeIndependentTest({ status: "ran", verdict: "fixes", original: { exitCode: 1 }, patched: true });
    expect(t).toMatchObject({ before: "exit 1", after: "pass" });
    expect(impliedOutcomes("fixes")).toEqual({ before: "fail", after: "pass" });
    expect(impliedOutcomes("still_failing")).toEqual({ before: "fail", after: "fail" });
    expect(impliedOutcomes("weird")).toEqual({});
  });
});

describe("phase event and phase strip", () => {
  it("accumulates repeated phases and ignores bad ones", () => {
    const run = fold([
      ev({ type: "phase", name: "gate", ms: 100 }),
      ev({ type: "phase", name: "gate", ms: 50.4 }),
      ev({ type: "phase", name: "", ms: 10 }),
      ev({ type: "phase", name: "loop", ms: -1 }),
      ev({ type: "phase", name: "loop", ms: "12" }),
    ]);
    expect(run.phaseTimings).toEqual([{ name: "gate", ms: 150 }]);
    expect(normalizePhase({ name: "x", ms: Number.NaN })).toBeNull();
  });

  it("orders segments by the pipeline, unknown phases last", () => {
    const run = fold([
      ev({ type: "phase", name: "review", ms: 30 }),
      ev({ type: "phase", name: "custom", ms: 5 }),
      ev({ type: "phase", name: "setup", ms: 10 }),
      ev({ type: "phase", name: "loop", ms: 100 }),
    ]);
    expect(phaseStrip(run, 1000).segments.map((s) => s.name)).toEqual(["setup", "loop", "review", "custom"]);
  });

  it("shows a live tail while running and the server wall time once done", () => {
    let run = fold([ev({ type: "phase", name: "setup", ms: 400 })]);
    run = { ...run, status: "running" };
    expect(phaseStrip(run, 1000)).toMatchObject({ sumMs: 400, wallMs: 1000, liveMs: 600 });
    run = reduceRun(
      run,
      { type: "run_done", status: "done", summary: "", filesChanged: 1, durationMs: 57_750, costUsd: 0 },
      ctx,
    );
    expect(phaseStrip(run, 99_999)).toMatchObject({ wallMs: 57_750, liveMs: 0 });
  });

  it("fills phases from run_done metrics.phaseMs without overriding streamed ones", () => {
    let run = fold([ev({ type: "phase", name: "setup", ms: 400 })]);
    run = reduceRun(
      run,
      ev({ type: "run_done", status: "done", summary: "", filesChanged: 0, durationMs: 1, costUsd: 0, metrics: { phaseMs: { setup: 9, loop: 20, bad: "x" } } }),
      ctx,
    );
    expect(run.phaseTimings).toEqual([
      { name: "setup", ms: 400 },
      { name: "loop", ms: 20 },
    ]);
    expect(mergePhaseMs([], [1, 2])).toEqual([]);
  });

  it("tolerates runs saved before phaseTimings existed", () => {
    const legacy = { ...fresh(), phaseTimings: undefined } as unknown as RunState;
    const run = reduceRun(legacy, ev({ type: "phase", name: "loop", ms: 5 }), ctx);
    expect(run.phaseTimings).toEqual([{ name: "loop", ms: 5 }]);
    expect(phaseStrip(legacy, 0).segments).toEqual([]);
  });
});

describe("mock fix replay", () => {
  const steps = mockScript({ prompt: "fix", interaction: "fix" });

  it("opens with run_start at zero delay, before any model work", () => {
    expect(steps[0].event.type).toBe("run_start");
    expect(steps[0].delay).toBe(0);
    const firstAgent = steps.findIndex((s) => s.event.type === "agent_start");
    const firstPhase = steps.findIndex((s) => (s.event as { type: string }).type === "phase");
    expect(firstPhase).toBeGreaterThan(0);
    expect(firstPhase).toBeLessThan(firstAgent);
  });

  it("folds into criteria, an independent test and all eight phases", () => {
    const run = fold(steps.map((s) => s.event));
    expect(run.criteria?.length).toBeGreaterThan(3);
    expect(run.independentTest).toMatchObject({ status: "ran", verdict: "fixes" });
    expect(run.independentTest?.command).toMatch(/pytest/);
    expect(phaseStrip(run, 0).segments.map((s) => s.name)).toEqual([
      "setup",
      "localize",
      "criteria",
      "loop",
      "gate",
      "testWriter",
      "review",
      "deliver",
    ]);
    expect(run.wallMs).toBe(57_750);
  });
});

describe("tailWindow", () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);

  it("mounts only the tail of a long list", () => {
    const w = tailWindow(items, 250, false);
    expect(w.shown).toHaveLength(250);
    expect(w.hidden).toBe(750);
    expect(w.shown[0]).toBe(750);
    expect(w.offset).toBe(750);
  });

  it("returns everything when short or expanded", () => {
    expect(tailWindow(items.slice(0, 10), 250, false)).toMatchObject({ hidden: 0, offset: 0 });
    expect(tailWindow(items, 250, true).shown).toHaveLength(1000);
  });
});

describe("provider status reader", () => {
  it("reads key rows, DeepSeek included, and the CLI row from the mock fixture", () => {
    const status = normalizeProviderStatus(MOCK_PROVIDER_STATUS);
    expect(status.keys.map((k) => k.provider)).toContain("deepseek");
    expect(status.keys.find((k) => k.provider === "deepseek")).toMatchObject({ configured: true, envVar: "DEEPSEEK_API_KEY" });
    expect(status.cli).toEqual({ configured: true, detail: "claude 2.1.14" });
    expect(anyProviderReady(status)).toBe(true);
  });

  it("drops unknown providers and malformed rows, and fills envVar", () => {
    const status = normalizeProviderStatus({
      providers: [null, "x", { provider: "mystery", configured: true }, { provider: "deepseek", configured: "yes" }],
    });
    expect(status.keys).toEqual([{ provider: "deepseek", configured: false, masked: null, fromEnv: false, envVar: "DEEPSEEK_API_KEY" }]);
    expect(status.cli).toBeNull();
    expect(anyProviderReady(status)).toBe(false);
  });

  it("finds the CLI under other spellings and top-level keys", () => {
    expect(normalizeProviderStatus({ providers: [{ provider: "claude_cli", loggedIn: false }] }).cli).toEqual({
      configured: false,
      detail: undefined,
    });
    expect(normalizeProviderStatus({ providers: [], claudeCli: { available: true, version: "2.0" } }).cli).toEqual({
      configured: true,
      detail: "2.0",
    });
    expect(normalizeProviderStatus({ providers: [], claudeCli: true }).cli).toEqual({ configured: true });
    // The CLI alone is enough to run.
    expect(anyProviderReady(normalizeProviderStatus({ providers: [{ provider: "claude-cli", configured: true }] }))).toBe(true);
  });

  it("survives garbage bodies", () => {
    expect(normalizeProviderStatus(undefined)).toEqual({ keys: [], cli: null });
    expect(normalizeProviderStatus({ providers: "nope" })).toEqual({ keys: [], cli: null });
  });
});

describe("eval phaseMs", () => {
  it("reads metrics.phaseMs and ignores bad entries", () => {
    const row = normalizeEvalRow({ task: "t", status: "resolved", metrics: { durationMs: 10, phaseMs: { loop: 7, bad: "x" } } });
    expect(row?.phaseMs).toEqual({ loop: 7 });
    expect(normalizeEvalRow({ task: "t" })).not.toHaveProperty("phaseMs");
    expect(readPhaseMs([1])).toBeNull();
  });
});

/**
 * Speed (W2, W3): setup phases and the two sides of the gate run
 * concurrently. Every phase gets a fake 100 ms delay; overlapping intervals
 * and a wall time under the serial sum prove they no longer queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Gate, type CheckRunner } from "@/lib/harness/gate";
import { solveTask } from "@/lib/harness/solve";
import { snapshot } from "@/lib/harness/snapshot";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import type { VerifyCommand } from "@/lib/verify/types";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
import { makeTmpRepo, shellRunner, type TmpRepo } from "./helpers/tmp-repo";

const DELAY = 100;
const spans: { name: string; start: number; end: number }[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Wrap `fn` so each call first waits DELAY ms, recording its interval under `name`. */
function slow<A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) {
  return async (...args: A): Promise<R> => {
    const start = Date.now();
    await sleep(DELAY);
    try {
      return await fn(...args);
    } finally {
      spans.push({ name, start, end: Date.now() });
    }
  };
}

vi.mock("@/lib/localize", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/localize")>();
  return { ...mod, localize: slow("localize", mod.localize) };
});
vi.mock("@/lib/workspace", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/workspace")>();
  return { ...mod, fullReindex: slow("engine", mod.fullReindex), refreshMemory: slow("engine", mod.refreshMemory) };
});
vi.mock("@/lib/harness/snapshot", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/harness/snapshot")>();
  return { ...mod, snapshot: slow("snapshot", mod.snapshot) };
});
vi.mock("@/lib/harness/criteria", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/harness/criteria")>();
  return { ...mod, predictCriteria: slow("criteria", async () => ["mean([]) -> 0"]) };
});

const ORIGINAL = "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;";
const FIXED = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);";
const REPRO_PATH = ".viberon/scratch/repro.js";
const REPRO = `node ${REPRO_PATH}`;
const SUITE: VerifyCommand[] = [{ command: "node test/lib.test.js", framework: "custom", kind: "test", source: "test" }];

let repo: TmpRepo;
beforeEach(() => {
  resetMemoryStoreForTests();
  spans.length = 0;
  repo = makeTmpRepo({
    "lib.js": `${ORIGINAL}\n`,
    "test/lib.test.js": "const { mean } = require('../lib');\nrequire('assert').strictEqual(mean([1, 2, 3]), 2);\n",
    "package.json": '{ "name": "m", "scripts": { "test": "node test/lib.test.js" } }\n',
  });
});
afterEach(() => {
  uninstallFakeProvider();
  repo.cleanup();
});

const overlap = (a: string, b: string) => {
  const x = spans.find((s) => s.name === a)!;
  const y = spans.find((s) => s.name === b)!;
  return x.start < y.end && y.start < x.end;
};

describe("parallel setup (W2)", () => {
  it("runs snapshot, index, detection and criteria at once; localize waits only for its inputs", async () => {
    installFakeProvider([
      { calls: [
        { name: "create_file", input: { path: REPRO_PATH, content: "require('assert').strictEqual(require('../../lib').mean([]), 0);\n" } },
        { name: "edit_file", input: { path: "lib.js", find: ORIGINAL, replace: FIXED, summary: "fix" } },
      ] },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
    ]);
    const log = eventLog();
    const at: { type: string; t: number }[] = [];
    const meta = await registerLocalWorkspace(repo.root);
    const result = await solveTask({
      handle: await openWorkspace(meta.repoKey),
      task: "mean([]) returns NaN instead of 0.",
      model: "claude-opus-5",
      emit: (event) => {
        at.push({ type: event.type, t: Date.now() });
        log.emit(event);
      },
      runId: "run-p",
      budget: { maxTurns: 12 },
      verify: { enabled: true, commands: [], timeoutMs: 30_000, baseline: true },
      independentTest: false,
      runCheck: shellRunner,
      verifyServices: {
        detectVerifyCommands: slow("detect", async () => SUITE),
        relatedTestFiles: async () => ["test/lib.test.js"],
      },
    });
    expect(result.status).toBe("resolved");

    const t = (type: string) => at.find((e) => e.type === type)!.t;
    const setupWall = t("agent_start") - t("run_start");
    // One delayed call per setup phase: snapshot, engine, detect, criteria, localize.
    const serial = new Set(spans.map((s) => s.name)).size * DELAY;
    console.info(`[W2] setup wall ${setupWall} ms (phaseMs.setup ${result.metrics.phaseMs?.setup} ms); injected delays in series: ${serial} ms`);

    expect(overlap("criteria", "engine")).toBe(true);
    expect(overlap("criteria", "detect")).toBe(true);
    expect(overlap("engine", "detect")).toBe(true);
    expect(overlap("snapshot", "engine")).toBe(true);
    expect(overlap("snapshot", "criteria")).toBe(true);
    // Localize needs the index: it starts after it, never before.
    const first = (name: string) => spans.find((s) => s.name === name)!;
    expect(first("localize").start).toBeGreaterThanOrEqual(first("engine").end);
    expect(first("localize").start).toBeGreaterThanOrEqual(first("snapshot").end);
    // Load-proof: overlapping phases finish in less wall time than their spans add up to.
    const spanSum = spans.reduce((n, sp) => n + (sp.end - sp.start), 0);
    expect(setupWall).toBeLessThan(spanSum);
    expect(result.metrics.phaseMs).toMatchObject({ setup: expect.any(Number), localize: expect.any(Number), criteria: expect.any(Number) });
  });
});

describe("parallel gate (W3)", () => {
  it("runs the original and the patched side of every check concurrently", async () => {
    repo.write(REPRO_PATH, "require('assert').strictEqual(require('../../lib').mean([]), 0);\n");
    const baseRef = await snapshot(repo.root);
    repo.write("lib.js", `${FIXED}\n`);
    const runs: { side: "original" | "patched"; start: number; end: number }[] = [];
    const runner: CheckRunner = async (command, options) => {
      const start = Date.now();
      await sleep(DELAY);
      const out = await shellRunner(command, options);
      runs.push({ side: options.cwd === repo.root ? "patched" : "original", start, end: Date.now() });
      return out;
    };
    const gate = new Gate({
      root: repo.root,
      baseRef,
      suite: SUITE,
      graph: null,
      timeoutMs: 30_000,
      emit: () => undefined,
      agentId: "solver",
      runner,
      services: { relatedTestFiles: async () => ["test/lib.test.js"] },
    });
    const result = await gate.verify({ summary: "fixed", reproduction: REPRO });
    // From the first check starting to the last one ending (the snapshot and checkout come before).
    const wall = Math.max(...runs.map((r) => r.end)) - Math.min(...runs.map((r) => r.start));
    console.info(`[W3] gate checks wall ${wall} ms for ${runs.length} runs of >= ${DELAY} ms (serial >= ${runs.length * DELAY} ms)`);

    expect(result.decision).toBe("accept");
    expect(runs.filter((r) => r.side === "original")).toHaveLength(2);
    expect(runs.filter((r) => r.side === "patched")).toHaveLength(2);
    const [o, p] = [runs.find((r) => r.side === "original")!, runs.find((r) => r.side === "patched")!];
    expect(o.start < p.end && p.start < o.end).toBe(true);
    expect(wall).toBeLessThan(runs.reduce((n, r) => n + (r.end - r.start), 0));

    // The blind-test comparison too.
    runs.length = 0;
    const compared = await gate.compareIndependent(REPRO);
    expect(compared).toMatchObject({ beforePassed: false, afterPassed: true });
    expect(runs[0].start < runs[1].end && runs[1].start < runs[0].end).toBe(true);
  });
});

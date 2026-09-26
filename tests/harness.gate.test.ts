import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Gate, guessReproduction, isTestPath, rootRelative, summarizeOutput, type GateOptions } from "@/lib/harness/gate";
import { snapshot } from "@/lib/harness/snapshot";
import type { VerifyCommand } from "@/lib/verify/types";
import { eventLog } from "./helpers/harness-workspace";
import { makeTmpRepo, shellRunner, type TmpRepo } from "./helpers/tmp-repo";

const ORIGINAL = "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;\n";
const WRONG = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / (xs.length + 1) : 0);\n";
const RIGHT = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);\n";
const REPRO = "node .viberon/scratch/repro.js";
const SUITE: VerifyCommand[] = [
  { command: "node test/lib.test.js", framework: "node-test", kind: "test", source: "test script" },
];
const RELATED = "node --test test/lib.test.js";

let repo: TmpRepo;
let log: ReturnType<typeof eventLog>;
let gate: Gate;

async function makeGate(overrides: Partial<GateOptions> = {}): Promise<Gate> {
  return new Gate({
    root: repo.root,
    baseRef: await snapshot(repo.root),
    suite: SUITE,
    graph: null,
    timeoutMs: 30_000,
    emit: log.emit,
    agentId: "solver",
    runner: shellRunner,
    services: { relatedTestFiles: async (_root, changed) => (changed.includes("lib.js") ? ["test/lib.test.js"] : []) },
    ...overrides,
  });
}

beforeEach(async () => {
  repo = makeTmpRepo({
    "lib.js": ORIGINAL,
    "test/lib.test.js":
      "const { mean } = require('../lib');\nrequire('assert').strictEqual(mean([1, 2, 3]), 2);\nconsole.log('ok');\n",
  });
  repo.write(
    ".viberon/scratch/repro.js",
    "const { mean } = require('../../lib');\nrequire('assert').strictEqual(mean([]), 0);\n",
  );
  log = eventLog();
  gate = await makeGate();
});
afterEach(() => repo.cleanup());

describe("Gate", () => {
  it("records the suite baseline on the original code, even after edits", async () => {
    repo.write("lib.js", WRONG);
    await gate.startBaseline();
    expect(log.of("verification")).toMatchObject([{ phase: "baseline", command: "node test/lib.test.js", exitCode: 0 }]);
    expect(repo.read("lib.js")).toBe(WRONG);
  });

  it("gives up when nothing changed on the final round", async () => {
    const res = await gate.verify({ summary: "done", reproduction: REPRO });
    expect(res).toMatchObject({ done: false, decision: "reject" });
    expect(res.feedback).toMatch(/no changes/);
    expect((await gate.verify({ summary: "done" }, { final: true })).decision).toBe("give_up");
  });

  it("rejects a regression in the related tests even when the reproduction passes", async () => {
    repo.write("lib.js", WRONG);
    const res = await gate.verify({ summary: "guard empty input", reproduction: REPRO });
    gate.emitResult(res);
    expect(res).toMatchObject({ done: false, decision: "reject" });
    expect(res.checks.map((c) => [c.origin, c.command, c.verdict])).toEqual([
      ["agent", REPRO, "fixes"],
      ["related-tests", RELATED, "regression"],
    ]);
    expect(res.newFailures).toEqual([RELATED]);
    expect(res.feedback).toMatch(/REGRESSION - `node --test test\/lib.test.js` passed on the original code/);
    const event = log.of("verification").at(-1)!;
    expect(event.phase).toBe("gate");
    expect(event.checks?.map((c) => c.verdict)).toEqual(["fixes", "regression"]);
    expect(log.of("gate").at(-1)).toMatchObject({ decision: "reject", attempt: 1 });
    expect(repo.read("lib.js")).toBe(WRONG);
  });

  it("accepts a fix with fail -> pass proof and no regressions", async () => {
    repo.write("lib.js", RIGHT);
    const res = await gate.verify({ summary: "guard empty input", reproduction: REPRO });
    expect(res).toMatchObject({ done: true, decision: "accept", strength: "strong" });
    expect(res.fixed).toEqual([REPRO]);
    expect(res.feedback).toMatch(/^VERIFIED/);
    expect(await gate.trackBest(res)).toBe(true);
    expect(log.of("checkpoint").at(-1)).toMatchObject({ kind: "best", ref: res.tree });
  });

  it("runs a reproduction that cds into the work tree against the original code too", async () => {
    repo.write("lib.js", RIGHT);
    // Without rewriting, this `cd` would run the "original" side in the patched tree.
    const res = await gate.verify({ summary: "guard empty input", reproduction: `cd ${repo.root} && ${REPRO}` });
    expect(res.checks[0]).toMatchObject({ origin: "agent", command: `cd . && ${REPRO}`, verdict: "fixes" });
    expect(res).toMatchObject({ decision: "accept", strength: "strong" });
    expect(rootRelative(`python ${repo.root}/x.py ${repo.root}2/y.py`, repo.root)).toBe(`python ./x.py ${repo.root}2/y.py`);
  });

  it("rejects a reproduction that still fails", async () => {
    repo.write("lib.js", `${ORIGINAL}// touched\n`);
    const res = await gate.verify({ summary: "noop", reproduction: REPRO });
    expect(res.checks[0].verdict).toBe("still_failing");
    expect(res.feedback).toMatch(/still fails after your change/);
  });

  it("asks once for proof, then gives up without it (checks exist, so never unverified)", async () => {
    repo.write("lib.js", RIGHT);
    const first = await gate.verify({ summary: "guard" });
    expect(first.feedback).toMatch(/^NOT YET/);
    const second = await gate.verify({ summary: "guard" });
    expect(second).toMatchObject({ done: true, decision: "give_up", strength: "weak" });
  });

  it("falls back to the suite when no related tests are found", async () => {
    gate = await makeGate({ services: { relatedTestFiles: async () => [] } });
    repo.write("lib.js", RIGHT);
    const res = await gate.verify({ summary: "fix", reproduction: REPRO });
    expect(res.checks.map((c) => c.origin)).toEqual(["agent", "suite"]);
    expect(res.decision).toBe("accept");
  });

  it("accepts unverified only when there is nothing runnable", async () => {
    gate = await makeGate({ suite: [], services: { relatedTestFiles: async () => [] } });
    repo.write("lib.js", RIGHT);
    const res = await gate.verify({ summary: "fix" });
    expect(res).toMatchObject({ done: true, decision: "accept_unverified", checks: [] });
  });

  it("rolls back after two regressions in a row", async () => {
    repo.write("lib.js", WRONG);
    await gate.verify({ summary: "try 1", reproduction: REPRO });
    repo.write("lib.js", `${WRONG}// again\n`);
    const second = await gate.verify({ summary: "try 2", reproduction: REPRO });
    expect(second.rolledBack).toBe(true);
    expect(repo.read("lib.js")).toBe(ORIGINAL);
    expect(log.of("recovery").at(-1)).toMatchObject({ action: "rollback", failureClass: "regression" });
  });

  it("compare runs a command on the original and the patched code", async () => {
    expect(await gate.compare(REPRO, 30_000)).toMatch(/not changed anything/);
    repo.write("lib.js", RIGHT);
    expect(await gate.compare(REPRO, 30_000)).toMatch(/Verdict: fixes/);
    expect(await gate.compare("node test/lib.test.js", 30_000)).toMatch(/Verdict: passes/);
    repo.write("lib.js", WRONG);
    expect(await gate.compare("node test/lib.test.js", 30_000)).toMatch(/Verdict: regression/);
    expect(await gate.compare("node -e 'process.exit(1)'", 30_000)).toMatch(/Verdict: pre_existing/);
    expect(repo.read("lib.js")).toBe(WRONG);
  });

  it("returns structured original and patched outcomes for a blind test", async () => {
    repo.write("lib.js", RIGHT);
    const result = await gate.compareIndependent(REPRO);
    expect(result).toMatchObject({ beforePassed: false, afterPassed: true });
    expect(result.beforeOutput).toMatch(/AssertionError|ERR_ASSERTION/);
  });
});

describe("Gate with the default terminal runner", () => {
  it("runs checks through the terminal service", async () => {
    const g = await makeGate({ suite: [], runner: undefined, repoKey: "gate-terminal" });
    repo.write("lib.js", RIGHT);
    const res = await g.verify({ summary: "fix", reproduction: REPRO });
    expect(res.checks[0]).toMatchObject({ verdict: "fixes" });
    expect(res.checks[0].after?.summary).not.toMatch(/exited with code/);
  });
});

describe("gate helpers", () => {
  it("recognizes test paths and guesses the reproduction", () => {
    expect(isTestPath("src/__tests__/x.ts")).toBe(true);
    expect(isTestPath("src/testing_utils.py")).toBe(false);
    expect(guessReproduction(["ls", "python .viberon/scratch/repro.py", "cat x"])).toBe("python .viberon/scratch/repro.py");
    expect(guessReproduction(["ls"])).toBeUndefined();
  });

  it("summarizes common runner output", () => {
    expect(summarizeOutput("===== 2 failed, 3 passed in 0.1s =====\n", 1, false)).toBe("2 failed, 3 passed in 0.1s");
    expect(summarizeOutput("Ran 4 tests in 0.01s\n\nOK\n", 0, false)).toBe("4 tests: OK");
    expect(summarizeOutput("", null, true)).toBe("timed out");
  });
});

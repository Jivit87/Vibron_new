import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiTurnRequest } from "@/lib/ai";
import { solveTask } from "@/lib/harness/solve";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider, type ScriptedTurn } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
import { routed } from "./helpers/routed";
import { makeTmpRepo, shellRunner, type TmpRepo } from "./helpers/tmp-repo";

const ORIGINAL = "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;";
const FIXED = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);";
const POLISHED = "exports.mean = (xs) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);";
const REPRO_PATH = ".viberon/scratch/repro.js";
const REPRO = `node ${REPRO_PATH}`;

let repo: TmpRepo;
let log: ReturnType<typeof eventLog>;

beforeEach(() => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({
    "lib.js": `${ORIGINAL}\n`,
    "test/lib.test.js": "const { mean } = require('../lib');\nrequire('assert').strictEqual(mean([1, 2, 3]), 2);\n",
    "package.json": '{ "name": "m", "scripts": { "test": "node test/lib.test.js" } }\n',
  });
  log = eventLog();
});
afterEach(() => {
  uninstallFakeProvider();
  repo.cleanup();
});

async function options(overrides: Partial<SolveOptions> = {}): Promise<SolveOptions> {
  const meta = await registerLocalWorkspace(repo.root);
  return {
    handle: await openWorkspace(meta.repoKey),
    task: "mean([]) returns NaN instead of 0.",
    model: "claude-opus-5",
    emit: log.emit,
    runId: "run-r",
    budget: { maxTurns: 12 },
    verify: {
      enabled: true,
      commands: [{ command: "node test/lib.test.js", framework: "custom", kind: "test", source: "test" }],
      timeoutMs: 30_000,
      baseline: true,
    },
    runCheck: shellRunner,
    verifyServices: { relatedTestFiles: async () => ["test/lib.test.js"] },
    criteria: false,
    independentTest: false,
    ...overrides,
  };
}

const BLIND = "node .viberon/scratch/test_independent.js";
const writer = (script: string): ScriptedTurn[] => [
  { calls: [{ name: "create_file", input: { path: ".viberon/scratch/test_independent.js", content: script } }] },
  { calls: [{ name: "done", input: { command: BLIND } }] },
];

const solve: ScriptedTurn[] = [
  {
    calls: [
      { name: "create_file", input: { path: REPRO_PATH, content: "require('assert').strictEqual(require('../../lib').mean([]), 0);\n" } },
      { name: "edit_file", input: { path: "lib.js", find: ORIGINAL, replace: FIXED, summary: "fix" } },
    ],
  },
  { calls: [{ name: "finish", input: { summary: "Empty input returns 0.", reproduction: REPRO } }] },
];

const review = (severity: string) => (req: AiTurnRequest): ScriptedTurn => {
  expect(req.model).toBe("claude-haiku-4-5");
  expect(req.tools ?? []).toEqual([]);
  expect(JSON.stringify(req.messages)).toContain("+exports.mean");
  return {
    text: JSON.stringify({
      summary: "Guards empty input.",
      effort: 1,
      findings: [{ file: "lib.js", line: 1, severity, title: "Ternary hides intent", detail: "Compare length to 0 explicitly." }],
      security: null,
      tests: "missing",
    }),
  };
};

describe("solve-loop reviewer", () => {
  it("keeps the earlier verified patch if review edits break the blind test", async () => {
    const broken = "exports.mean = (xs) => (xs.length ? (xs.length === 2 ? 999 : xs.reduce((a, b) => a + b, 0) / xs.length) : 0);";
    const blind = "const assert = require('node:assert/strict');\nconst { mean } = require('../../lib');\nassert.equal(mean([2, 4]), 3);\n";
    installFakeProvider(routed({
      solver: [
        ...solve,
        { calls: [{ name: "edit_file", input: { path: "lib.js", find: FIXED, replace: broken, summary: "review edit" } }] },
        { calls: [{ name: "finish", input: { summary: "reviewed", reproduction: REPRO } }] },
      ],
      writer: writer(blind),
      reviewer: [review("high")],
    }));
    const result = await solveTask(await options({ independentTest: true, review: true }));
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${FIXED}\n`);
    expect(result.independentTest?.status).toBe("passes");
  });

  it("runs the blind writer and the reviewer concurrently and merges them into one send-back", async () => {
    const partial = "exports.mean = (xs) => (xs.length ? (xs.length === 2 ? 999 : xs.reduce((a, b) => a + b, 0) / xs.length) : 0);";
    const blind = "const assert = require('node:assert/strict');\nconst { mean } = require('../../lib');\nassert.equal(mean([2, 4]), 3);\n";
    const filler = Array.from({ length: 14 }, (_, i) => `// line ${i + 2}`).join("\n");
    repo.write("lib.js", `${ORIGINAL}\n${filler}\nexports.median = (xs) => xs[Math.floor(xs.length / 2)];\n`);
    const at = new Map<string, number>();
    const emit = (event: Parameters<typeof log.emit>[0]) => {
      if (event.type === "phase") at.set(event.name, Date.now());
      log.emit(event);
    };
    const fake = installFakeProvider(routed({
      solver: [
        {
          calls: [
            { name: "create_file", input: { path: REPRO_PATH, content: "require('assert').strictEqual(require('../../lib').mean([]), 0);\n" } },
            { name: "edit_file", input: { path: "lib.js", find: ORIGINAL, replace: partial, summary: "fix" } },
          ],
        },
        solve[1],
        (req) => {
          const first = JSON.stringify(req.messages[0]);
          expect(first).toContain("<independent_test>");
          expect(first).toContain("<review>");
          expect(first).toContain("Ternary hides intent");
          return { calls: [{ name: "edit_file", input: { path: "lib.js", find: partial, replace: FIXED, summary: "sibling" } }] };
        },
        { calls: [{ name: "finish", input: { summary: "Both cases.", reproduction: REPRO } }] },
      ],
      writer: writer(blind),
      reviewer: [
        (req) => {
          const user = JSON.stringify(req.messages[0]);
          // Wide context (25 lines): unchanged sibling code 15 lines below the change is visible.
          expect(user).toContain("exports.median");
          expect(user).toContain("<evidence>");
          expect(user).toContain("PROVES FIX");
          expect(user).toContain("<predicted_acceptance_criteria>");
          expect(JSON.stringify(req.system)).toContain("Predict the regression test the maintainers would add");
          return review("high")(req);
        },
      ],
      criteria: [{ text: "1. mean([]) -> 0\n2. mean([2, 4]) -> 3" }],
    }));
    const result = await solveTask(await options({ independentTest: true, review: true, criteria: true, emit, maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toContain(FIXED);
    expect(result.independentTest?.status).toBe("passes");
    expect(fake.remaining).toBe(0);
    // One follow-up in total, carrying both.
    expect(log.of("agent_start").filter((a) => a.role === "solver").map((a) => a.title)).toEqual(["Solve task", "Address review finding"]);
    expect(log.of("recovery").map((r) => r.failureClass).filter((c) => c !== "no_progress")).toEqual(["test_failure", "review"]);
    const phase = (name: string) => {
      const ms = result.metrics.phaseMs?.[name] ?? 0;
      return { end: at.get(name)!, start: at.get(name)! - ms };
    };
    // The blind draft runs during the solve, before anything is accepted;
    // after the accept, running the drafted test overlaps the reviewer.
    const [w, ir, r] = [phase("testWriter"), phase("independentRun"), phase("review")];
    expect(w.start).toBeLessThan(r.start);
    expect(ir.start).toBeLessThanOrEqual(r.end);
    expect(r.start).toBeLessThanOrEqual(ir.end);
  });

  it("sends an accepted change back once on a high finding and keeps the revised change", async () => {
    const withNewFile: ScriptedTurn = {
      calls: [
        ...(solve[0] as { calls: { name: string; input: Record<string, unknown> }[] }).calls,
        { name: "create_file", input: { path: "empty.js", content: "module.exports = 0;\n" } },
      ],
    };
    const fake = installFakeProvider([
      withNewFile,
      solve[1],
      review("high"),
      (req) => {
        const first = JSON.stringify(req.messages[0]);
        expect(first).toContain("Ternary hides intent");
        expect(first).toContain("passed verification");
        return { calls: [{ name: "edit_file", input: { path: "lib.js", find: FIXED, replace: POLISHED, summary: "explicit" } }] };
      },
      { calls: [{ name: "finish", input: { summary: "Explicit empty check.", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options({ review: true }));
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${POLISHED}\n`);
    // Files the first attempt created stay in the revised patch.
    expect(result.filesChanged.sort()).toEqual(["empty.js", "lib.js"]);
    expect(log.of("agent_start").map((a) => a.title)).toEqual(["Solve task", "Address review finding"]);
    expect(log.of("recovery").filter((r) => r.failureClass === "review")).toEqual([
      expect.objectContaining({ action: "hint", detail: expect.stringMatching(/^Reviewer: Ternary hides intent \(lib.js:1\)/) }),
    ]);
    expect(fake.remaining).toBe(0);
    // The review call counts toward the run's model calls.
    expect(result.metrics.modelCalls).toBe(5);
  });

  it("keeps the verified change when the review pass loses its evidence", async () => {
    installFakeProvider([
      ...solve,
      review("high"),
      { calls: [{ name: "edit_file", input: { path: "lib.js", find: FIXED, replace: ORIGINAL, summary: "oops" } }] },
      { calls: [{ name: "finish", input: { summary: "Reverted.", reproduction: REPRO } }] },
      { text: "Done." },
      { text: "Done." },
    ]);
    const result = await solveTask(await options({ review: true, maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${FIXED}\n`);
    expect(log.of("agent_start")).toHaveLength(2);
  });

  it("does not send the agent back for lower severities, review errors, or when review is off", async () => {
    installFakeProvider([...solve, review("medium")]);
    expect((await solveTask(await options({ review: true }))).status).toBe("resolved");
    expect(log.of("agent_start")).toHaveLength(1);

    repo.git("checkout", "-q", "--", "lib.js");
    installFakeProvider([...solve, { error: new Error("review model exploded") }]);
    const errored = await solveTask(await options({ review: true }));
    expect(errored.status).toBe("resolved");
    expect(errored.error).toBeUndefined();

    repo.git("checkout", "-q", "--", "lib.js");
    const off = installFakeProvider([...solve]);
    expect((await solveTask(await options())).status).toBe("resolved");
    expect(off.requests.every((r) => r.model === "claude-opus-5")).toBe(true);
  });

  it("a slow criteria call never holds the loop; late criteria are appended to a later turn", async () => {
    const started: Record<string, number> = {};
    const fake = installFakeProvider(routed({
      solver: [
        (req) => {
          started.solver ??= Date.now();
          expect(JSON.stringify(req.messages)).not.toContain("predicted_acceptance_criteria");
          return { calls: [{ name: "create_file", input: { path: REPRO_PATH, content: "require('assert').strictEqual(require('../../lib').mean([]), 0);\n" } }] };
        },
        { calls: [{ name: "run_command", input: { command: "sleep 2" } }] },
        (req) => {
          // Appended to the end of an earlier turn, never inserted into the first message.
          expect(JSON.stringify(req.messages[0])).not.toContain("predicted_acceptance_criteria");
          expect(JSON.stringify(req.messages.slice(1))).toContain("predicted_acceptance_criteria");
          return { calls: [{ name: "edit_file", input: { path: "lib.js", find: ORIGINAL, replace: FIXED, summary: "fix" } }] };
        },
        { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
      ],
      criteria: [
        (() => {
          started.criteria = Date.now();
          return { text: "1. mean([]) -> 0", delayMs: 2_500 };
        }) as ScriptedTurn,
      ],
    }));
    const result = await solveTask(await options({ criteria: true, maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(result.criteria).toEqual(["mean([]) -> 0"]);
    // Ordering, not wall-clock thresholds: the solver asked before the 2.5 s
    // criteria answered, and setup ended before the criteria call did.
    expect(started.solver!).toBeLessThan(started.criteria! + 2_500);
    expect(result.metrics.phaseMs?.setup ?? Infinity).toBeLessThan(result.metrics.phaseMs?.criteria ?? 0);
    expect(fake.remaining).toBe(0);
  });
});

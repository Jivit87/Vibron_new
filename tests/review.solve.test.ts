import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AiTurnRequest } from "@/lib/ai";
import { solveTask } from "@/lib/harness/solve";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider, type ScriptedTurn } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
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
    ...overrides,
  };
}

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
    installFakeProvider([
      ...solve,
      { text: JSON.stringify({ language: "javascript", test: blind }) },
      review("high"),
      { calls: [{ name: "edit_file", input: { path: "lib.js", find: FIXED, replace: broken, summary: "review edit" } }] },
      { calls: [{ name: "finish", input: { summary: "reviewed", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options({ independentTest: true, review: true }));
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${FIXED}\n`);
    expect(result.independentTest?.status).toBe("passes");
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
});

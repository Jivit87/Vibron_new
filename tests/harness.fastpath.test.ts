import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { nearMissApply, parseReply } from "@/lib/harness/fastpath";
import { DEFAULT_ISSUE_TOKEN_BUDGET, issueTokenBudget } from "@/lib/harness/recovery";
import { solveTask } from "@/lib/harness/solve";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { triage } from "@/lib/harness/triage";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import type { AiTurnRequest } from "@/lib/ai/types";
import type { VerifyCommand } from "@/lib/verify/types";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider, type ScriptedTurn } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
import { routed, whoAsked } from "./helpers/routed";
import { makeTmpRepo, shellRunner, type TmpRepo } from "./helpers/tmp-repo";

const ORIGINAL = "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;";
const FIXED = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);";
const SUITE: VerifyCommand[] = [
  { command: "node test/lib.test.js", framework: "custom", kind: "test", source: "package.json test script" },
];
const TASK = "mean([]) returns NaN instead of 0.\n\nIt should return 0 for an empty list.";
const TEST_FILE = ".viberon/scratch/test_issue.js";

const EDIT = `lib.js\n<<<<<<< SEARCH\n${ORIGINAL}\n=======\n${FIXED}\n>>>>>>> REPLACE\n\n`;
const TEST_BLOCK = (body: string) =>
  `${TEST_FILE}\n<<<<<<< SEARCH\n=======\nconst { mean } = require('../../lib');\n${body}\n>>>>>>> REPLACE\n\nTEST_COMMAND: node ${TEST_FILE}\n`;
const PROVES = "require('assert').strictEqual(mean([]), 0);";
const REPLY = `DIAGNOSIS: mean() divides by xs.length with no empty-list case.\n\n${EDIT}${TEST_BLOCK(PROVES)}`;

let repo: TmpRepo;
let log: ReturnType<typeof eventLog>;

beforeEach(() => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({
    "lib.js": `${ORIGINAL}\n`,
    "test/lib.test.js":
      "const { mean } = require('../lib');\nrequire('assert').strictEqual(mean([1, 2, 3]), 2);\nconsole.log('ok');\n",
    "package.json": '{ "name": "mathx", "scripts": { "test": "node test/lib.test.js" } }\n',
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
    task: TASK,
    model: "claude-opus-5",
    emit: log.emit,
    runId: "run-fast",
    budget: { maxTurns: 12 },
    verify: { enabled: true, commands: SUITE, timeoutMs: 30_000, baseline: true },
    runCheck: shellRunner,
    verifyServices: { relatedTestFiles: async () => ["test/lib.test.js"] },
    criteria: false,
    independentTest: false,
    review: false,
    fastPath: true,
    ...overrides,
  };
}

const isFast = (req: AiTurnRequest) => JSON.stringify(req.system).includes("Answer in the exact format requested");

describe("fast path: parsing and near-miss edits (Pramana tests/test_fastpath.py)", () => {
  it("reads edits, the new test file and the command", () => {
    const { diagnosis, edits, testCommand } = parseReply(REPLY);
    expect(diagnosis).toContain("empty-list");
    expect(testCommand).toBe(`node ${TEST_FILE}`);
    expect(edits.map((e) => e.path)).toEqual(["lib.js", TEST_FILE]);
    expect(edits[1].search).toBe("");
  });

  const FUNC =
    'def mean(xs):\n    """Average of xs."""\n    # sum then divide\n    total = 0\n    for x in xs:\n        total += x\n    count = len(xs)\n    return total / count\n';

  it("a near-miss edit keeps the real context lines", () => {
    const search =
      '    """Average of xs."""\n    # add them up then divide\n    total = 0\n    for x in xs:\n        total += x\n    count = len(xs)\n    return total / count';
    const replace = search.replace("    return total / count", "    if not count:\n        return 0.0\n    return total / count");
    const out = nearMissApply(FUNC, search, replace);
    expect(out).not.toBeNull();
    const [text, line] = out!;
    expect(text).toContain("# sum then divide");
    expect(text).not.toContain("add them up");
    expect(text).toContain("    if not count:\n        return 0.0\n    return total / count\n");
    expect(line).toBe(2);
  });

  it("refuses when the changed line itself is misremembered", () => {
    const search =
      '    """Average of xs."""\n    # sum then divide\n    total = 0\n    for x in xs:\n        total += x\n    count = len(xs)\n    return total / len(xs)';
    const replace = search.replace("    return total / len(xs)", "    return total / count if count else 0.0");
    expect(nearMissApply(FUNC, search, replace)).toBeNull();
  });

  it("refuses an ambiguous region", () => {
    const search = FUNC.replace("# sum then divide", "# add up").replace(/\n$/, "");
    expect(nearMissApply(`${FUNC}\n\n${FUNC}`, search, search.replace("return total / count", "return 0"))).toBeNull();
  });

  it("triage sizes issues without tokens", () => {
    expect(triage({ text: TASK, files: [{ path: "lib.js", score: 1 }] }).size).toBe("small");
    const big = triage({
      text: `Feature request: add support for streaming. ${"x".repeat(7000)}`,
      files: [1, 2, 3, 4].map((i) => ({ path: `f${i}.js`, score: 1 })),
    });
    expect(big.size).toBe("large");
    expect(big.reasons).toContain("asks for new behaviour");
  });

  it("the per-issue token budget: option, then env, then default", () => {
    expect(issueTokenBudget(5000, {})).toBe(5000);
    expect(issueTokenBudget(undefined, { VIBERON_ISSUE_TOKEN_BUDGET: "999" })).toBe(999);
    expect(issueTokenBudget(undefined, {})).toBe(DEFAULT_ISSUE_TOKEN_BUDGET);
  });
});

describe("fast path through solveTask", () => {
  it("an easy issue is verified in ONE model call", async () => {
    const fake = installFakeProvider([{ text: REPLY }]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(result.metrics.modelCalls).toBe(1);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0].tools ?? []).toEqual([]);
    expect(result.metrics.fastPath).toEqual({ used: true, calls: 1, accepted: true });
    expect(repo.read("lib.js")).toBe(`${FIXED}\n`);
    expect(result.filesChanged).toEqual(["lib.js"]);
    expect(log.of("verification").some((v) => v.checks?.some((c) => c.verdict === "fixes"))).toBe(true);
    expect(log.of("gate").map((g) => g.decision)).toContain("accept");
    expect(log.of("phase").map((p) => p.name)).toContain("fastPath");
    expect(log.of("agent_text").map((t) => t.text).join("")).toMatch(/fast path accepted.*1 call/);
  });

  it("by default (mode fast) a small issue proven fail->pass in one call costs ONE call: no reviewer, criteria or writer", async () => {
    const fake = installFakeProvider(routed({
      solver: [{ text: REPLY }],
      reviewer: [{ text: JSON.stringify({ summary: "Guards empty input.", effort: 1, findings: [{ file: "lib.js", line: 1, severity: "low", title: "Style", detail: "Fine." }], security: null, tests: "missing" }) }],
    }));
    // The test setup turns the production default off through the env; restore it here.
    const saved = process.env.VIBERON_FAST_PATH;
    delete process.env.VIBERON_FAST_PATH;
    try {
      const result = await solveTask(
        await options({ criteria: undefined, independentTest: undefined, review: undefined, fastPath: undefined, reviewModel: "claude-haiku-4-5" }),
      );
      expect(result.status).toBe("resolved");
      expect(fake.requests.map((r) => (isFast(r) ? "fast" : whoAsked(r)))).toEqual(["fast"]);
      expect(result.metrics.modelCalls).toBe(1);
      expect(result.metrics.fastPath).toEqual({ used: true, calls: 1, accepted: true });
      // The whole prompt for a small repo: the localized file, the example test, the format. ~1.2k tokens.
      const promptChars = JSON.stringify(fake.requests[0].messages).length + JSON.stringify(fake.requests[0].system).length;
      expect(promptChars).toBeLessThan(6000);
      expect(fake.requests[0].tools ?? []).toEqual([]);
    } finally {
      process.env.VIBERON_FAST_PATH = saved;
    }
  });

  it("a new file that is the fix stays in the patch", async () => {
    const reply = REPLY.replace(
      EDIT,
      `lib/safe.js\n<<<<<<< SEARCH\n=======\nexports.safeDiv = (a, b) => (b ? a / b : 0);\n>>>>>>> REPLACE\n\n` +
        `lib.js\n<<<<<<< SEARCH\n${ORIGINAL}\n=======\nexports.mean = (xs) => require('./lib/safe').safeDiv(xs.reduce((a, b) => a + b, 0), xs.length);\n>>>>>>> REPLACE\n\n`,
    );
    installFakeProvider([{ text: reply }]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(result.filesChanged.sort()).toEqual(["lib.js", "lib/safe.js"]);
    expect(result.diff).toContain("safeDiv");
  });

  it("a change to config/CI files only is never called verified", async () => {
    const reply = `DIAGNOSIS: the workflow is missing.\n\n.github/workflows/review.yml\n<<<<<<< SEARCH\n=======\nname: review\non: pull_request\n>>>>>>> REPLACE\n\n${TEST_BLOCK("require('fs').accessSync('.github/workflows/review.yml');")}`;
    installFakeProvider(routed({ solver: [{ text: reply }, { text: "Done." }, { text: "Done." }] }));
    const result = await solveTask(await options({ task: "Add a CI review workflow that runs lib.js tests (mean) on every pull request.", maxAttempts: 1 }));
    expect(result.status).not.toBe("resolved");
    expect(result.metrics.fastPath).toEqual({ used: true, calls: 1, accepted: false });
  });

  it("an edit with a wrong path lands in the file that holds its text", async () => {
    installFakeProvider([{ text: REPLY.replace("lib.js\n<<<<<<<", "src/statistics.js\n<<<<<<<") }]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${FIXED}\n`);
  });

  it("a reply cut off while reasoning does not use up the second round", async () => {
    const thinking: ScriptedTurn = { text: "We are given an issue: mean([]) is NaN. ".repeat(40), stopReason: "max_tokens" };
    const badEdit: ScriptedTurn = { text: REPLY.replace(`${ORIGINAL}\n=======`, "exports.mean = (values) => values.length;\n=======") };
    installFakeProvider([thinking, badEdit, { text: REPLY }]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(result.metrics.modelCalls).toBe(3); // reasoning, finish-now answer, corrected answer
  });

  it("an edit repeated verbatim in the reply is applied once", async () => {
    installFakeProvider([{ text: REPLY.replace(EDIT, EDIT + EDIT) }]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(result.metrics.modelCalls).toBe(1);
  });

  it("escalates to the agent loop with lessons after 2 failed rounds", async () => {
    // Both rounds: a test that passes on the original code proves nothing.
    const noProof = REPLY.replace(PROVES, "require('assert').strictEqual(mean([1, 2, 3]), 2);");
    const fake = installFakeProvider([
      { text: noProof },
      (req) => {
        expect(JSON.stringify(req.messages)).toContain("PASSED on the original");
        return { text: noProof };
      },
      (req) => {
        expect(isFast(req)).toBe(false);
        expect(JSON.stringify(req.messages)).toContain("one-shot attempt (proof) was not accepted");
        return {
          calls: [
            { name: "create_file", input: { path: ".viberon/scratch/repro.js", content: `const { mean } = require('../../lib');\n${PROVES}\n` } },
            { name: "edit_file", input: { path: "lib.js", find: ORIGINAL, replace: FIXED, summary: "fix" } },
          ],
        };
      },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: "node .viberon/scratch/repro.js" } }] },
    ]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(result.metrics.fastPath).toEqual({ used: true, calls: 2, accepted: false });
    expect(fake.requests.filter(isFast)).toHaveLength(2);
    expect(result.metrics.modelCalls).toBe(4);
  });
});

describe("give-up rules", () => {
  const neverEdits = (n: number): ScriptedTurn[] =>
    Array.from({ length: n }, (_, i) => ({ calls: [{ name: "view", input: { path: "lib.js", start_line: 1, end_line: 1 + (i % 3) } }] }));

  it("ends an attempt with no source edit by turn 12 and skips attempt 2", async () => {
    const fake = installFakeProvider(neverEdits(80));
    const result = await solveTask(await options({ fastPath: false, budget: { maxTurns: 40 }, maxAttempts: 2 }));
    expect(result.status).toBe("failed");
    // Without the rules: 2 attempts x 40 turns = 80 calls.
    expect(fake.requests.length).toBe(12);
    expect(result.metrics.modelCalls).toBe(12);
    expect(result.metrics.gaveUp).toMatch(/no source edit/);
    expect(log.of("recovery").some((r) => /Ending the attempt/.test(r.detail))).toBe(true);
    expect(log.of("agent_start")).toHaveLength(1);
  });

  it("after a failed fast path the agent is capped: no edit by turn 6 ends the run (8 calls total)", async () => {
    const noProof = REPLY.replace(PROVES, "require('assert').strictEqual(mean([1, 2, 3]), 2);");
    const fake = installFakeProvider([{ text: noProof }, { text: noProof }, ...neverEdits(80)]);
    const result = await solveTask(await options({ budget: { maxTurns: 40 }, maxAttempts: 2 }));
    expect(result.status).toBe("failed");
    expect(fake.requests.length).toBe(8); // 2 fast-path rounds + 6 agent turns, no attempt 2
    expect(result.metrics.gaveUp).toMatch(/no source edit after 6 turns/);
  });

  it("the token budget stops the run with a clear reason", async () => {
    const fake = installFakeProvider(neverEdits(80));
    const result = await solveTask(await options({ fastPath: false, budget: { maxTurns: 40, maxTokens: 500 } }));
    // 120 tokens per fake turn: the 5th turn crosses 500.
    expect(fake.requests.length).toBe(5);
    expect(result.metrics.gaveUp).toBe("gave up after 600 tokens without proof");
    expect(result.gate.reason).toContain("gave up after 600 tokens without proof");
  });
});



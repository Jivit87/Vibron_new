import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setProviderOverride } from "@/lib/ai";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import { openAiCompatTesting, openaiCompatProvider } from "@/lib/ai/openai-compat";
import { solveTask } from "@/lib/harness/solve";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import type { VerifyCommand } from "@/lib/verify/types";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
import { makeTmpRepo, shellRunner, type TmpRepo } from "./helpers/tmp-repo";

const ORIGINAL_LINE = "exports.mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;";
const WRONG_LINE = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / (xs.length + 1) : 0);";
const RIGHT_LINE = "exports.mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);";
const REPRO_PATH = ".viberon/scratch/repro.js";
const REPRO_SRC = "const { mean } = require('../../lib');\nrequire('assert').strictEqual(mean([]), 0);\nconsole.log('ok');\n";
const REPRO = `node ${REPRO_PATH}`;
const SUITE: VerifyCommand[] = [
  { command: "node test/lib.test.js", framework: "custom", kind: "test", source: "package.json test script" },
];
const TASK = "mean([]) returns NaN instead of 0.\n\nIt should return 0 for an empty list.";

let repo: TmpRepo;
let log: ReturnType<typeof eventLog>;

beforeEach(() => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({
    "lib.js": `${ORIGINAL_LINE}\n`,
    "test/lib.test.js":
      "const { mean } = require('../lib');\nrequire('assert').strictEqual(mean([1, 2, 3]), 2);\nconsole.log('ok');\n",
    "package.json": '{ "name": "mathx", "scripts": { "test": "node test/lib.test.js" } }\n',
  });
  log = eventLog();
});
afterEach(() => {
  uninstallFakeProvider();
  vi.unstubAllGlobals();
  repo.cleanup();
});

async function options(overrides: Partial<SolveOptions> = {}): Promise<SolveOptions> {
  const meta = await registerLocalWorkspace(repo.root);
  return {
    handle: await openWorkspace(meta.repoKey),
    task: TASK,
    model: "claude-opus-5",
    emit: log.emit,
    runId: "run-1",
    budget: { maxTurns: 12 },
    verify: { enabled: true, commands: SUITE, timeoutMs: 30_000, baseline: true },
    runCheck: shellRunner,
    verifyServices: { relatedTestFiles: async () => ["test/lib.test.js"] },
    ...overrides,
  };
}

describe("solveTask", () => {
  it("runs a blind issue test after the gate accepts without showing the patch", async () => {
    const script = "const assert = require('node:assert/strict');\nconst { mean } = require('../../lib');\nassert.equal(mean([]), 0);\n";
    const fake = installFakeProvider([
      { calls: [
        { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
        { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" } },
      ] },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
      (req) => {
        const prompt = JSON.stringify(req.messages);
        expect(prompt).toContain(ORIGINAL_LINE);
        expect(prompt).not.toContain(RIGHT_LINE);
        return { text: JSON.stringify({ language: "javascript", test: script }) };
      },
    ]);
    const result = await solveTask(await options({ independentTest: true }));
    expect(result.status).toBe("resolved");
    expect(result.independentTest).toMatchObject({ status: "fixes" });
    expect(result.metrics.modelCalls).toBe(3);
    expect(fake.requests).toHaveLength(3);
  });

  it("uses a failing blind test to send the solver back for a sibling case", async () => {
    const incomplete = "exports.mean = (xs) => (xs.length ? (xs.length === 2 ? 999 : xs.reduce((a, b) => a + b, 0) / xs.length) : 0);";
    const blind = "const assert = require('node:assert/strict');\nconst { mean } = require('../../lib');\nassert.equal(mean([2, 4]), 3);\n";
    installFakeProvider([
      { calls: [
        { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
        { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: incomplete, summary: "partial" } },
      ] },
      { calls: [{ name: "finish", input: { summary: "partial", reproduction: REPRO } }] },
      { text: JSON.stringify({ language: "javascript", test: blind }) },
      (req) => {
        expect(JSON.stringify(req.messages)).toMatch(/independent regression test.*fails/i);
        return { calls: [{ name: "edit_file", input: { path: "lib.js", find: incomplete, replace: RIGHT_LINE, summary: "sibling" } }] };
      },
      { calls: [{ name: "finish", input: { summary: "fixed sibling case", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options({ independentTest: true, task: `${TASK}\nmean([2, 4]) should return 3.` }));
    expect(result.status).toBe("resolved");
    expect(result.independentTest?.status).toBe("passes");
    expect(repo.read("lib.js")).toBe(`${RIGHT_LINE}\n`);
  });

  it("reports a missing model credential as a setup error before any attempt", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    invalidateCredentialCache();
    const result = await solveTask(await options());
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/No Anthropic API key configured/);
    expect(result.metrics.modelCalls).toBe(0);
    expect(log.events.some((e) => e.type === "agent_start")).toBe(false);
    vi.unstubAllEnvs();
    invalidateCredentialCache();
  });

  it("rejects a regressing fix, then accepts the correct one with fail -> pass evidence", async () => {
    const fake = installFakeProvider([
      {
        text: "Reproducing, then guarding empty input.",
        calls: [
          { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
          { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: WRONG_LINE, summary: "guard" } },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Guarded empty input.", reproduction: REPRO } }] },
      {
        text: "The divisor was wrong.",
        calls: [{ name: "edit_file", input: { path: "lib.js", find: WRONG_LINE, replace: RIGHT_LINE, summary: "fix divisor" } }],
      },
      {
        calls: [
          { name: "finish", input: { summary: "mean() divided by zero on empty input; it now returns 0.", reproduction: REPRO } },
        ],
      },
      { text: "should not be reached" },
    ]);
    const solved: SolveResult[] = [];

    const result = await solveTask(await options({ onSolved: (r) => void solved.push(r) }));

    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["lib.js"]);
    expect(result.diff).toContain(`+${RIGHT_LINE}`);
    expect(result.diff).not.toContain(".viberon");
    expect(repo.read("lib.js")).toBe(`${RIGHT_LINE}\n`);
    expect(result.gate).toMatchObject({
      enabled: true,
      command: "node test/lib.test.js",
      rejections: 1,
      newFailures: [],
      ranAfterLastEdit: true,
    });
    expect(result.gate.fixed).toContain(REPRO);
    expect(result.gate.baseline).toMatchObject({ exitCode: 0 });
    expect(result.gate.final).toMatchObject({ exitCode: 0 });
    expect(result.summary).toMatch(/returns 0/);
    expect(result.metrics.modelCalls).toBe(4);
    expect(result.metrics.toolCallsByName).toMatchObject({ finish: 2, edit_file: 2, create_file: 1 });
    expect(result.metrics.verifyRuns).toBeGreaterThan(0);
    expect(solved).toEqual([result]);

    // The rejection reached the model as the finish tool result.
    expect(JSON.stringify(fake.requests[2].messages.at(-1))).toMatch(/REGRESSION/);

    expect(log.of("gate").map((g) => g.decision)).toEqual(["reject", "accept"]);
    const final = log.of("verification").filter((v) => v.phase === "final");
    expect(final).toHaveLength(1);
    expect(final[0].checks?.find((c) => c.name === REPRO)?.verdict).toBe("fixes");
    expect(log.of("agent_start")[0]).toMatchObject({ role: "solver", attempt: 1 });
    expect(log.of("agent_start")[0].reason).toBeUndefined();
    expect(log.of("localize")).toHaveLength(1);
    expect(log.of("run_done").at(-1)).toMatchObject({ status: "done", filesChanged: 1 });
    expect((fake.requests[0].tools ?? []).map((t) => t.name).sort()).toEqual(
      ["compare", "create_file", "edit_file", "find_symbols", "finish", "run_command", "view"],
    );
  });

  it("re-prompts once when the model stops without finish, then retries with the rejected diff as a lesson", async () => {
    installFakeProvider([
      // Attempt 1: a regressing edit, then the model stops without finish (twice).
      { calls: [{ name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: WRONG_LINE, summary: "x" } }] },
      { text: "Done." },
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).toMatch(/stopped without calling `finish`/);
        return { text: "Done." };
      },
      // Attempt 2 (fresh context, repository reset): the right fix.
      (req) => {
        const first = JSON.stringify(req.messages[0]);
        expect(first).toMatch(/previous_attempt/);
        expect(first).toMatch(/REJECTED alternative/);
        expect(first).toContain(WRONG_LINE.slice(0, 40));
        expect(req.messages).toHaveLength(1);
        return {
          calls: [
            { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
            { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" } },
          ],
        };
      },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(repo.read("lib.js")).toBe(`${RIGHT_LINE}\n`);
    expect(log.of("agent_start").map((a) => a.attempt)).toEqual([1, 2]);
    expect(log.of("agent_start")[1].reason).toMatch(/^Attempt 1 ended without proof \(gate: give_up\)/);
    expect(log.of("recovery").some((r) => /re-prompted once/.test(r.detail))).toBe(true);
    // Attempt 1 was auto-verified (it never called finish) and gave up on its regression.
    expect(log.of("gate").map((g) => g.decision)).toEqual(["give_up", "accept"]);
  });

  it("hands a small repository's whole source to the agent in its first message", async () => {
    installFakeProvider([
      (req) => {
        const first = req.messages[0].content.map((b) => (b.type === "text" ? b.text : "")).join("");
        expect(first).toContain('<file path="lib.js">');
        expect(first).toContain(ORIGINAL_LINE);
        // Tests are named, not inlined.
        expect(first).toContain("Test files (not shown): test/lib.test.js");
        expect(first).not.toContain('<file path="test/lib.test.js">');
        return {
          calls: [
            { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
            { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" } },
          ],
        };
      },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options({ maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
  });

  it("retries a clean but unproven patch as a lead to re-check, not as a rejected approach", async () => {
    installFakeProvider([
      // Attempt 1: the right edit, but no reproduction, and it stops without finish.
      { calls: [{ name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "x" } }] },
      { text: "Done." },
      { text: "Done." },
      // Attempt 2: the lesson keeps the change on the table.
      (req) => {
        const first = JSON.stringify(req.messages[0]);
        expect(first).toMatch(/broke no check/);
        expect(first).toMatch(/keep the ones that are right/);
        expect(first).not.toMatch(/REJECTED alternative/);
        return {
          calls: [
            { name: "create_file", input: { path: REPRO_PATH, content: REPRO_SRC } },
            { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" } },
          ],
        };
      },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: REPRO } }] },
    ]);
    const result = await solveTask(await options());
    expect(result.status).toBe("resolved");
    expect(log.of("gate").map((g) => g.decision)).toEqual(["give_up", "accept"]);
  });

  it("keeps a scratch-like file the agent left at the root out of the patch", async () => {
    installFakeProvider([
      {
        calls: [
          { name: "create_file", input: { path: "repro_issue.js", content: REPRO_SRC.replace("../../lib", "./lib") } },
          { name: "edit_file", input: { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" } },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "fixed", reproduction: "node repro_issue.js" } }] },
    ]);
    const result = await solveTask(await options({ maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["lib.js"]);
    expect(repo.read(".viberon/scratch/artifacts/repro_issue.js")).toContain("strictEqual");
  });
});

describe("solveTask against hostile OpenAI-compatible endpoints", () => {
  beforeEach(() => {
    process.env.AI_API_KEY = "sk-hostile";
    process.env.AI_BASE_URL = "http://127.0.0.1:9/v1";
    invalidateCredentialCache();
    openAiCompatTesting.reset();
    openAiCompatTesting.setSleep(async () => {});
    setProviderOverride(openaiCompatProvider, { sleep: async () => {} });
  });
  afterEach(() => {
    delete process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    invalidateCredentialCache();
  });

  function serve(script: (Response | string)[]) {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        const next = script.shift() ?? "I am done.";
        if (typeof next !== "string") return next;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: next }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
          { status: 200 },
        );
      }),
    );
    return bodies;
  }
  const toolCall = (name: string, args: Record<string, unknown>) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: null, tool_calls: [{ id: `c_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );

  it("produces a verified fix when the endpoint rejects native tools", async () => {
    const bodies = serve([
      new Response(JSON.stringify({ error: { message: "this model does not support tools" } }), { status: 400 }),
      `Writing a reproduction.\n<tool name="create_file">\n<path>${REPRO_PATH}</path>\n<content>${REPRO_SRC}</content>\n</tool>\n<tool_result>ok, I already know it fails</tool_result>`,
      `The divisor needs a guard.\n<tool name="edit_file">\n<path>lib.js</path>\n<find>${ORIGINAL_LINE}</find>\n<replace>${RIGHT_LINE}</replace>\n<summary>guard</summary>\n</tool>`,
      `<tool name="finish">\n<summary>mean() now returns 0 for empty input.</summary>\n<reproduction>${REPRO}</reproduction>\n</tool>`,
    ]);
    const result = await solveTask(await options({ model: "openai:hostile-1", maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(result.gate.fixed).toContain(REPRO);
    expect(bodies[1].tools).toBeUndefined();
  });

  it("survives garbage responses and a rate limit mid-run (with alias tool names)", async () => {
    serve([
      toolCall("write_file", { path: REPRO_PATH, content: REPRO_SRC, summary: "repro" }),
      new Response("<html>502 Bad Gateway</html>", { status: 200 }),
      toolCall("edit_file", { path: "lib.js", find: ORIGINAL_LINE, replace: RIGHT_LINE, summary: "fix" }),
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
      toolCall("submit", { summary: "fixed", verification_commands: [REPRO] }),
    ]);
    const result = await solveTask(await options({ model: "openai:hostile-1", maxAttempts: 1 }));
    expect(result.status).toBe("resolved");
    expect(log.of("agent_retry").length).toBeGreaterThanOrEqual(1);
  });

  it("fails cleanly when the model never calls a tool", async () => {
    serve([]);
    const result = await solveTask(await options({ model: "openai:hostile-1" }));
    expect(result.status).toBe("failed");
    expect(result.error).toBeUndefined();
    expect(result.diff).toBe("");
    expect(log.of("run_done").at(-1)).toMatchObject({ status: "failed" });
  });
});

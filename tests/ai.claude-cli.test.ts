/**
 * Claude CLI provider, offline: `VIBERON_CLAUDE_BIN` points at a fake
 * `claude` script that records what it was given and prints a canned JSON
 * result. The real CLI (and the model) is never called.
 */

import { chmod, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { availableModels, classifyProviderError, ensureModelReady, resolveModel, runTurn } from "@/lib/ai";
import { claudeCliProvider, claudeCliTesting, closeClaudeCliSessions } from "@/lib/ai/claude-cli";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import type { AiToolDef, AiTurnRequest, AiTurnResult } from "@/lib/ai/types";
import { countTokens } from "@/lib/tokens";

const ENV_KEYS = [
  "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "GROQ_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "VIBERON_MODEL",
  "VIBERON_STORE", "VIBERON_CLAUDE_BIN", "VIBERON_CLAUDE_CLI", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_OUT", "FAKE_CLAUDE_LOGGED_IN",
  "CLAUDE_CONFIG_DIR", "FAKE_CLAUDE_CALLS", "VIBERON_CLAUDE_CLI_SESSIONS",
];
const saved: Record<string, string | undefined> = {};

const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_LOGGED_IN !== "0" }) + "\\n");
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (c) => (stdin += c));
process.stdin.on("end", () => {
  const sysFile = args[args.indexOf("--system-prompt-file") + 1];
  const entry = {
    args, stdin, cwd: process.cwd(), sysFile, system: fs.readFileSync(sysFile, "utf8"),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
  };
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(entry));
  if (process.env.FAKE_CLAUDE_CALLS) fs.appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify(entry) + "\\n");
  // Session files, like the real CLI: <config>/projects/<cwd slug>/<id>.jsonl.
  const projects = require("node:path").join(process.env.CLAUDE_CONFIG_DIR, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
  const created = args.indexOf("--session-id");
  const resumed = args.indexOf("--resume");
  let sid = null;
  if (created >= 0) {
    sid = args[created + 1];
    fs.mkdirSync(projects, { recursive: true });
    fs.writeFileSync(projects + "/" + sid + ".jsonl", stdin);
  } else if (resumed >= 0) {
    sid = args[resumed + 1];
    const file = projects + "/" + sid + ".jsonl";
    if (!fs.existsSync(file)) {
      process.stdout.write(JSON.stringify({ is_error: true, result: "No conversation found with session ID: " + sid }) + "\\n");
      return;
    }
    fs.appendFileSync(file, stdin);
  }
  const out = JSON.parse(process.env.FAKE_CLAUDE_OUT);
  if (sid && out.session_id === undefined) out.session_id = sid;
  process.stdout.write("warning: something first\\n" + JSON.stringify(out) + "\\n");
});
`;

const TOOLS: AiToolDef[] = [
  {
    name: "read_file",
    description: "Read a file.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

function request(model = "claude-cli:sonnet"): AiTurnRequest {
  return {
    model,
    system: [{ text: "You fix bugs." }],
    tools: TOOLS,
    messages: [
      { role: "user", content: [{ type: "text", text: "Fix the parser." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.py" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "def parse(): pass" }] },
    ],
  };
}

let dir = "";
let logFile = "";

function answer(result: Record<string, unknown>) {
  process.env.FAKE_CLAUDE_OUT = JSON.stringify(result);
}

async function recorded() {
  return JSON.parse(await readFile(logFile, "utf8")) as {
    args: string[];
    stdin: string;
    cwd: string;
    sysFile: string;
    system: string;
    anthropicKey: string | null;
  };
}

beforeEach(async () => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VIBERON_STORE = "memory";
  dir = await mkdtemp(path.join(os.tmpdir(), "viberon-claude-cli-"));
  const bin = path.join(dir, "claude");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  logFile = path.join(dir, "log.json");
  process.env.VIBERON_CLAUDE_BIN = bin;
  process.env.FAKE_CLAUDE_LOG = logFile;
  process.env.CLAUDE_CONFIG_DIR = path.join(dir, "config");
  claudeCliTesting.reset();
  invalidateCredentialCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  claudeCliTesting.reset();
  invalidateCredentialCache();
});

describe("Claude CLI provider", () => {
  it("spawns claude -p with the isolation flags, a temp system prompt file, the transcript on stdin and no API key", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
    answer({ result: "Looks fine.", usage: { input_tokens: 5, output_tokens: 3 }, total_cost_usd: 0.01 });
    const result = await claudeCliProvider.runTurn(request());
    const seen = await recorded();
    expect(seen.args).toEqual([
      "-p", "--model", "sonnet", "--output-format", "json", "--tools", "", "--strict-mcp-config",
      "--setting-sources", "", "--session-id", claudeCliTesting.sessionIds()[0], "--system-prompt-file", seen.sysFile,
    ]);
    expect(seen.anthropicKey).toBeNull();
    expect(await import("node:fs/promises").then((fs) => fs.realpath(seen.cwd))).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(path.join(os.tmpdir(), "viberon-claude-cli"))),
    );
    // The tool contract rides in the system prompt; the file is removed afterwards.
    expect(seen.system).toContain("You fix bugs.");
    expect(seen.system).toContain('<tool name="TOOL_NAME">');
    expect(existsSync(seen.sysFile)).toBe(false);
    // The transcript is rendered as text: the earlier call and its result included.
    expect(seen.stdin).toContain("=== USER ===\nFix the parser.");
    expect(seen.stdin).toContain('<tool name="read_file">\n<path>a.py</path>\n</tool>');
    expect(seen.stdin).toContain('<tool_result name="read_file">\ndef parse(): pass');
    expect(seen.stdin.trimEnd().endsWith("=== ASSISTANT ===")).toBe(true);
    expect(result).toMatchObject({ text: "Looks fine.", toolCalls: [], stopReason: "end_turn" });
  });

  it("parses text-protocol tool calls, drops imagined results, and maps usage and cost", async () => {
    answer({
      result: 'Reading it.\n<tool name="read_file">\n<path>b.py</path>\n</tool>\n<tool_result>fake</tool_result>',
      usage: { input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 20 },
      total_cost_usd: 0.0421,
    });
    const result = await runTurn(request("claude-cli:haiku"));
    expect(result.toolCalls).toMatchObject([{ name: "read_file", input: { path: "b.py" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.text).toBe("Reading it.");
    expect(JSON.stringify(result.content)).not.toContain("fake");
    expect(result.usage).toEqual({ inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 20 });
    expect(result.cost).toBeCloseTo(0.0421);
    expect((await recorded()).args[2]).toBe("haiku");
  });

  it("maps a too-long prompt to the overflow error, login problems to fatal, and other failures to retryable", async () => {
    answer({ is_error: true, result: "Prompt is too long" });
    const overflow = await claudeCliProvider.runTurn(request()).catch((e: unknown) => e);
    expect(classifyProviderError(overflow).kind).toBe("too_large");

    answer({ is_error: true, result: "Not logged in · Please run /login" });
    const login = await claudeCliProvider.runTurn(request()).catch((e: unknown) => e);
    expect(classifyProviderError(login).kind).toBe("fatal");

    answer({ is_error: true, result: "API Error: 529 overloaded" });
    const transient = await claudeCliProvider.runTurn(request()).catch((e: unknown) => e);
    expect(classifyProviderError(transient).kind).toBe("retryable");
  });

  it("is ready only when the binary exists and auth status says logged in", async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = "0";
    await expect(ensureModelReady("claude-cli:sonnet")).rejects.toThrow(/claude auth login/);
    claudeCliTesting.reset();
    delete process.env.FAKE_CLAUDE_LOGGED_IN;
    await expect(ensureModelReady("claude-cli:sonnet")).resolves.toBeUndefined();
    process.env.VIBERON_CLAUDE_BIN = path.join(dir, "missing-claude");
    claudeCliTesting.reset();
    // A missing binary is caught at spawn time as a failed turn.
    await expect(claudeCliProvider.runTurn(request())).rejects.toThrow(/Claude CLI/);
  });

  it("auto never lands on the CLI (a subscription) unless the user opts in; naming it works", async () => {
    // No API keys: selectable in the picker, but auto refuses rather than spend the subscription.
    await expect(resolveModel("auto", { agenticOnly: true })).rejects.toThrow(/Claude subscription \(CLI\)/);
    process.env.VIBERON_CLAUDE_CLI_AUTO = "1";
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("claude-cli:opus");
    delete process.env.VIBERON_CLAUDE_CLI_AUTO;
    const cli = (await availableModels()).filter((m) => m.spec.provider === "claude-cli");
    expect(cli.map((m) => [m.spec.id, m.available])).toEqual([
      ["claude-cli:opus", true],
      ["claude-cli:sonnet", true],
      ["claude-cli:haiku", true],
    ]);
    process.env.GROQ_API_KEY = "gsk_test";
    invalidateCredentialCache();
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("openai/gpt-oss-120b");
    // Automatic picks elsewhere (e.g. the cheapest review model) cannot land on it either.
    expect((await availableModels()).some((m) => m.spec.provider === "claude-cli" && m.available)).toBe(false);
    // Named explicitly, it still wins.
    expect(await resolveModel("claude-cli:haiku")).toBe("claude-cli:haiku");
  });

  it("the settings keys route shows a read-only Claude subscription row", async () => {
    const { GET } = await import("@/app/api/settings/keys/route");
    const body = (await (await GET()).json()) as { providers: { provider: string; configured: boolean; readOnly?: boolean; label?: string }[] };
    expect(body.providers.find((p) => p.provider === "claude-cli")).toMatchObject({
      label: "Claude subscription (CLI)",
      readOnly: true,
      configured: true,
    });
    expect(body.providers.map((p) => p.provider)).toContain("deepseek");
  });
});

describe("Claude CLI session reuse", () => {
  type Call = { args: string[]; stdin: string };
  let callsFile = "";

  beforeEach(() => {
    callsFile = path.join(dir, "calls.jsonl");
    process.env.FAKE_CLAUDE_CALLS = callsFile;
  });

  afterEach(async () => {
    await closeClaudeCliSessions();
  });

  async function calls(): Promise<Call[]> {
    if (!existsSync(callsFile)) return [];
    return (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Call);
  }

  const flag = (c: Call, name: string) => (c.args.includes(name) ? c.args[c.args.indexOf(name) + 1] : undefined);
  const sessionFile = (id: string) => path.join(claudeCliTesting.projectDir(), `${id}.jsonl`);

  /** Append the model's reply and a tool result for each of its calls, like the agent loop does. */
  function extend(req: AiTurnRequest, result: AiTurnResult, output: string): AiTurnRequest {
    return {
      ...req,
      messages: [
        ...req.messages,
        { role: "assistant", content: result.content },
        { role: "user", content: result.toolCalls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: output })) },
      ],
    };
  }

  const READ_REPLY = { result: 'Reading.\n<tool name="read_file">\n<path>b.py</path>\n</tool>', usage: { input_tokens: 1, output_tokens: 1 } };

  it("turn 2 resumes the session and receives only the delta; files are deleted on close", async () => {
    answer(READ_REPLY);
    const r1 = request();
    const t1 = await claudeCliProvider.runTurn(r1);
    const r2 = extend(r1, t1, "def b(): return 2");
    await claudeCliProvider.runTurn(r2);
    const [c1, c2] = await calls();
    const id = flag(c1!, "--session-id")!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(c1!.args).not.toContain("--no-session-persistence");
    expect(c1!.stdin).toContain("Fix the parser.");
    // Turn 2: same session, only the new tool result.
    expect(flag(c2!, "--resume")).toBe(id);
    expect(c2!.args).not.toContain("--session-id");
    expect(c2!.stdin).toBe('=== USER ===\n<tool_result name="read_file">\ndef b(): return 2\n</tool_result>\n\n=== ASSISTANT ===\n');
    expect(c2!.stdin).not.toContain("Fix the parser.");
    // Isolation flags are kept on resumed turns.
    for (const f of ["--tools", "--strict-mcp-config", "--setting-sources", "--system-prompt-file"]) expect(c2!.args).toContain(f);
    expect(existsSync(sessionFile(id))).toBe(true);
    await closeClaudeCliSessions();
    expect(existsSync(sessionFile(id))).toBe(false);
    expect(claudeCliTesting.sessionIds()).toEqual([]);
  });

  it("any history edit starts a NEW session with the full transcript and deletes the old one", async () => {
    answer(READ_REPLY);
    const r1 = request();
    const t1 = await claudeCliProvider.runTurn(r1);
    const r2 = extend(r1, t1, "def b(): return 2");
    // Pruning: an earlier tool result is rewritten.
    const pruned: AiTurnRequest = {
      ...r2,
      messages: r2.messages.map((m, i) =>
        i === 2 ? { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[pruned]" }] } : m,
      ),
    };
    await claudeCliProvider.runTurn(pruned);
    const [c1, c2] = await calls();
    const first = flag(c1!, "--session-id")!;
    const second = flag(c2!, "--session-id");
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(c2!.args).not.toContain("--resume");
    expect(c2!.stdin).toContain("Fix the parser.");
    expect(c2!.stdin).toContain("[pruned]");
    await new Promise((r) => setTimeout(r, 20));
    expect(existsSync(sessionFile(first))).toBe(false);
    expect(claudeCliTesting.sessionIds()).toEqual([second]);
    // A different system prompt (e.g. escalation) never resumes either.
    const t2 = await claudeCliProvider.runTurn({ ...extend(r1, t1, "x"), system: [{ text: "Other." }] });
    expect(t2.text).toBe("Reading.");
    expect((await calls())[2]!.args).toContain("--session-id");
  });

  it("a lost session falls back to a full re-send in the same turn", async () => {
    answer(READ_REPLY);
    const r1 = request();
    const t1 = await claudeCliProvider.runTurn(r1);
    const id = claudeCliTesting.sessionIds()[0]!;
    await unlink(sessionFile(id));
    const t2 = await claudeCliProvider.runTurn(extend(r1, t1, "out"));
    expect(t2.toolCalls).toHaveLength(1);
    const [, resumed, fresh] = await calls();
    expect(flag(resumed!, "--resume")).toBe(id);
    expect(flag(fresh!, "--session-id")).not.toBe(id);
    expect(fresh!.stdin).toContain("Fix the parser.");
  });

  it("a failed or trimmed turn is never resumed; side calls (no tools) persist nothing", async () => {
    // Hallucinated tool result trimmed from the reply: the CLI's copy differs, so drop it.
    answer({ result: `${READ_REPLY.result}\n<tool_result>imagined</tool_result>` });
    const r1 = request();
    const t1 = await claudeCliProvider.runTurn(r1);
    const id = flag((await calls())[0]!, "--session-id")!;
    expect(claudeCliTesting.sessionIds()).toEqual([]);
    expect(existsSync(sessionFile(id))).toBe(false);
    answer(READ_REPLY);
    const t2 = await claudeCliProvider.runTurn(extend(r1, t1, "out"));
    expect((await calls())[1]!.args).toContain("--session-id");
    // A failed resumed turn drops (and deletes) its session.
    const live = claudeCliTesting.sessionIds()[0]!;
    answer({ is_error: true, result: "API Error: 529 overloaded" });
    await expect(claudeCliProvider.runTurn(extend(extend(r1, t1, "out"), t2, "more"))).rejects.toThrow(/Claude CLI/);
    expect(flag((await calls())[2]!, "--resume")).toBe(live);
    expect(claudeCliTesting.sessionIds()).toEqual([]);
    expect(existsSync(sessionFile(live))).toBe(false);
    // Side call without tools: no session at all.
    answer({ result: "Summary." });
    await claudeCliProvider.runTurn({ ...request("claude-cli:haiku"), tools: [] });
    const side = (await calls()).at(-1)!;
    expect(side.args).toContain("--no-session-persistence");
    expect(side.args).not.toContain("--session-id");
    expect(claudeCliTesting.sessionIds()).toEqual([]);
  });

  it("10-turn scripted run: bytes and tokens on stdin, full re-send vs session reuse", async () => {
    const FILE = Array.from({ length: 60 }, (_, i) => `def f${i}(x):\n    return x + ${i}`).join("\n");
    async function run(): Promise<string[]> {
      await writeFile(callsFile, "");
      let req = request();
      for (let turn = 0; turn < 10; turn += 1) {
        answer({ result: `Step ${turn}.\n<tool name="read_file">\n<path>f${turn}.py</path>\n</tool>` });
        const res = await claudeCliProvider.runTurn(req);
        req = extend(req, res, `${FILE}\n# file ${turn}`);
      }
      return (await calls()).map((c) => c.stdin);
    }
    process.env.VIBERON_CLAUDE_CLI_SESSIONS = "0";
    const beforeIn = await run();
    delete process.env.VIBERON_CLAUDE_CLI_SESSIONS;
    const afterIn = await run();
    const bytes = (xs: string[]) => xs.map((x) => Buffer.byteLength(x));
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
    const before = bytes(beforeIn);
    const after = bytes(afterIn);
    console.log(
      `[claude-cli 10-turn] bytes/turn before=${before.join(",")} total=${sum(before)} tokens=${sum(beforeIn.map(countTokens))}\n` +
        `[claude-cli 10-turn] bytes/turn after=${after.join(",")} total=${sum(after)} tokens=${sum(afterIn.map(countTokens))}`,
    );
    expect(after[0]).toBe(before[0]);
    for (let i = 1; i < 10; i += 1) expect(after[i]).toBeLessThan(before[1]!);
    expect(sum(after)).toBeLessThan(sum(before) / 3);
  });
});

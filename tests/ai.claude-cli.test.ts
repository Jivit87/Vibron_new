/**
 * Claude CLI provider, offline: `VIBERON_CLAUDE_BIN` points at a fake
 * `claude` script that records what it was given and prints a canned JSON
 * result. The real CLI (and the model) is never called.
 */

import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { availableModels, classifyProviderError, ensureModelReady, resolveModel, runTurn } from "@/lib/ai";
import { claudeCliProvider, claudeCliTesting } from "@/lib/ai/claude-cli";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import type { AiToolDef, AiTurnRequest } from "@/lib/ai/types";

const ENV_KEYS = [
  "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "GROQ_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "VIBERON_MODEL",
  "VIBERON_STORE", "VIBERON_CLAUDE_BIN", "VIBERON_CLAUDE_CLI", "FAKE_CLAUDE_LOG", "FAKE_CLAUDE_OUT", "FAKE_CLAUDE_LOGGED_IN",
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
  fs.writeFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({
    args, stdin, cwd: process.cwd(), sysFile, system: fs.readFileSync(sysFile, "utf8"),
    anthropicKey: process.env.ANTHROPIC_API_KEY ?? null,
  }));
  process.stdout.write("warning: something first\\n" + process.env.FAKE_CLAUDE_OUT + "\\n");
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
      "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", seen.sysFile,
    ]);
    expect(seen.anthropicKey).toBeNull();
    expect(await import("node:fs/promises").then((fs) => fs.realpath(seen.cwd))).toBe(
      await import("node:fs/promises").then((fs) => fs.realpath(os.tmpdir())),
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

  it("auto uses the CLI only when no API-key provider is configured", async () => {
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("claude-cli:opus");
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

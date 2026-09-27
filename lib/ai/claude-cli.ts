/**
 * Claude through a locally logged-in Claude Code CLI (ported from Pramana
 * `llm/claude_cli.py`): real runs on a Claude subscription, no API key.
 *
 * Each turn is one `claude -p` process, spawned without a shell:
 *
 *   claude -p --model <m> --output-format json --tools "" --strict-mcp-config
 *          --setting-sources "" --no-session-persistence --system-prompt-file <tmp>
 *
 * - The CLI's own tools, MCP servers, settings and session files are all off:
 *   it is a plain completion model. Tool calls go through the text protocol
 *   (`textproto.ts`), exactly like an endpoint without native tools.
 * - The transcript is rendered as `=== USER ===` / `=== ASSISTANT ===` text
 *   on stdin; the system prompt (plus the tool contract) goes in a temp file
 *   that is always removed. cwd is the OS temp dir, so no repo CLAUDE.md loads.
 * - `ANTHROPIC_API_KEY` is removed from the child env, so the subscription
 *   login is used rather than a key the user meant for the API adapter.
 * - Usage and cost come from the JSON result (`usage`, `total_cost_usd`).
 *
 * Failures are thrown with an HTTP-like status so `retry.ts` decides:
 * "too long"/context → 413 (the runner compacts), login problems → 401
 * (fatal), anything else → 503 (backoff and retry).
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_TEXT_CALLS_PER_TURN,
  parseTextToolCalls,
  toTextMessages,
  truncateHallucination,
} from "@/lib/ai/textproto";
import type { AiContent, AiProvider, AiTurnHandlers, AiTurnRequest, AiTurnResult } from "@/lib/ai/types";
import { which } from "@/lib/verify/env";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 16 * 1024 * 1024;

class ClaudeCliError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

/** The `claude` executable: `VIBERON_CLAUDE_BIN`, else `claude` on PATH. */
export function claudeBinary(): string | null {
  const explicit = process.env.VIBERON_CLAUDE_BIN?.trim();
  if (explicit) return explicit;
  return which("claude");
}

let loginProbe: { bin: string; ready: Promise<boolean> } | null = null;

/**
 * Whether the CLI can serve turns: the binary exists and `claude auth status`
 * does not say "logged out". Probed once per binary and cached; an
 * unreadable status counts as ready (the first turn then reports the truth).
 * Off under vitest unless a test points `VIBERON_CLAUDE_BIN` at a fake, and
 * off whenever `VIBERON_CLAUDE_CLI=0`.
 */
export function claudeCliReady(): Promise<boolean> {
  if (process.env.VIBERON_CLAUDE_CLI === "0") return Promise.resolve(false);
  if (process.env.VITEST && !process.env.VIBERON_CLAUDE_BIN) return Promise.resolve(false);
  const bin = claudeBinary();
  if (!bin) return Promise.resolve(false);
  if (loginProbe?.bin !== bin) {
    loginProbe = {
      bin,
      ready: new Promise((resolve) => {
        execFile(bin, ["auth", "status", "--json"], { timeout: 15_000, env: childEnv() }, (error, stdout) => {
          try {
            const status = JSON.parse(String(stdout).trim()) as { loggedIn?: unknown };
            resolve(status.loggedIn !== false);
          } catch {
            resolve(!error || (error as { code?: unknown }).code !== "ENOENT");
          }
        });
      }),
    };
  }
  return loginProbe.ready;
}

function childEnv(request?: Pick<AiTurnRequest, "effort" | "maxTokens">): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // A nested Claude Code session must not think it runs inside its parent.
  delete env.CLAUDECODE;
  if (request) {
    // Claude Code thinks by default and ignores the API's max_tokens. Measured
    // on Haiku: default 766 output tokens / 9.9 s vs 306 / 5.7 s without
    // thinking. Think only when the caller asks for high effort.
    const deep = request.effort === "high" || request.effort === "xhigh" || request.effort === "max";
    if (!deep && env.MAX_THINKING_TOKENS === undefined) env.MAX_THINKING_TOKENS = "0";
    if (request.maxTokens && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) {
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(request.maxTokens);
    }
  }
  return env;
}

/** System prompt (with the tool contract) and the transcript as one stdin prompt. */
export function renderClaudeCliPrompt(request: AiTurnRequest): { system: string; prompt: string } {
  const system = request.system.map((b) => b.text).filter(Boolean).join("\n\n");
  const plain = toTextMessages(system, request.messages, request.tools ?? []);
  const sys = plain[0]?.role === "system" ? plain.shift()!.content : "";
  const convo = plain
    .map((m) => `=== ${m.role === "user" ? "USER" : "ASSISTANT"} ===\n${m.content}`)
    .join("\n\n");
  return {
    system: sys || "You are a helpful assistant.",
    prompt:
      "Below is the conversation so far. Write ONLY the next ASSISTANT message " +
      "(no '=== ASSISTANT ===' header, do not write the USER's side).\n\n" +
      `${convo}\n\n=== ASSISTANT ===\n`,
  };
}

/** The CLI's alias for a model id: `claude-cli:sonnet` → `sonnet`. */
function cliModel(model: string): string {
  return model.replace(/^claude-cli:/, "") || "haiku";
}

interface CliOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  bin: string,
  args: string[],
  input: string,
  signal?: AbortSignal,
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<CliOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeoutMs = Number(process.env.VIBERON_CLAUDE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(new DOMException("The operation was aborted.", "AbortError"));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/** The last JSON line of stdout (the CLI may print warnings first). */
function parseCliJson(stdout: string): CliResult | null {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]!) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as CliResult;
    } catch {
      // Not JSON; keep looking upwards.
    }
  }
  return null;
}

function failure(detail: string): ClaudeCliError {
  const text = detail.slice(0, 500) || "unknown error";
  if (/too long|context (window|length|limit)/i.test(text)) {
    return new ClaudeCliError(`Claude CLI: prompt is too long: ${text}`, 413);
  }
  if (/not logged in|\/login|invalid api key|authentication|unauthori[sz]ed/i.test(text)) {
    return new ClaudeCliError(`Claude CLI is not logged in (run \`claude auth login\`): ${text}`, 401);
  }
  if (/usage limit|rate limit|limit reached/i.test(text)) {
    return new ClaudeCliError(`Claude CLI rate limit: ${text}`, 429);
  }
  return new ClaudeCliError(`Claude CLI failed: ${text}`, 503);
}

export const claudeCliProvider: AiProvider = {
  id: "claude-cli",

  isConfigured(): boolean {
    return claudeBinary() !== null;
  },

  async runTurn(request: AiTurnRequest, handlers: AiTurnHandlers = {}): Promise<AiTurnResult> {
    const bin = claudeBinary();
    if (!bin) throw new ClaudeCliError("Claude CLI: `claude` is not on PATH", 401);
    const { system, prompt } = renderClaudeCliPrompt(request);
    const sysPath = path.join(os.tmpdir(), `viberon-claude-sys-${randomUUID()}.txt`);
    await writeFile(sysPath, system, { mode: 0o600 });
    let outcome: CliOutcome;
    try {
      outcome = await runCli(
        bin,
        [
          "-p",
          "--model", cliModel(request.model),
          "--output-format", "json",
          "--tools", "",
          "--strict-mcp-config",
          "--setting-sources", "",
          "--no-session-persistence",
          "--system-prompt-file", sysPath,
        ],
        prompt,
        request.signal,
        childEnv(request),
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw failure(error instanceof Error ? error.message : String(error));
    } finally {
      await unlink(sysPath).catch(() => {});
    }

    const data = parseCliJson(outcome.stdout);
    if (!data || data.is_error) {
      throw failure(data?.result || outcome.stderr.trim() || outcome.stdout.trim() || `exit code ${outcome.code}`);
    }

    const tools = request.tools ?? [];
    let text = (data.result ?? "").trim();
    let calls: AiTurnResult["toolCalls"] = [];
    if (tools.length) {
      text = truncateHallucination(text);
      const parsed = parseTextToolCalls(text, tools);
      calls = parsed.calls.slice(0, MAX_TEXT_CALLS_PER_TURN);
    }
    const shown = calls.length ? parseTextToolCalls(text, tools).prose : text;
    if (shown) handlers.onText?.(shown);
    for (const call of calls) handlers.onToolCallStart?.(call.name);

    const content: AiContent[] = [];
    if (text) content.push({ type: "text", text });
    for (const call of calls) content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });

    const usage = data.usage ?? {};
    return {
      text: shown,
      thinking: "",
      toolCalls: calls,
      stopReason: data.stop_reason === "max_tokens" ? "max_tokens" : calls.length ? "tool_use" : "end_turn",
      content,
      usage: {
        inputTokens: Number(usage.input_tokens) || 0,
        outputTokens: Number(usage.output_tokens) || 0,
        cacheReadTokens: Number(usage.cache_read_input_tokens) || 0,
        cacheWriteTokens: Number(usage.cache_creation_input_tokens) || 0,
      },
      costUsd: Number(data.total_cost_usd) || 0,
    };
  },
};

export const claudeCliTesting = {
  reset(): void {
    loginProbe = null;
  },
};

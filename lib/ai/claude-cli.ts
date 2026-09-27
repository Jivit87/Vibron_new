/**
 * Claude through a locally logged-in Claude Code CLI (ported from Pramana
 * `llm/claude_cli.py`): real runs on a Claude subscription, no API key.
 *
 * Each turn is one `claude -p` process, spawned without a shell:
 *
 *   claude -p --model <m> --output-format json --tools "" --strict-mcp-config
 *          --setting-sources "" <session flag> --system-prompt-file <tmp>
 *
 * - The CLI's own tools, MCP servers and settings are all off: it is a plain
 *   completion model. Tool calls go through the text protocol
 *   (`textproto.ts`), exactly like an endpoint without native tools.
 * - The transcript is rendered as `=== USER ===` / `=== ASSISTANT ===` text
 *   on stdin; the system prompt (plus the tool contract) goes in a temp file
 *   that is always removed. cwd is a private empty temp dir
 *   (`<tmp>/viberon-claude-cli`), so no repo CLAUDE.md loads.
 * - `ANTHROPIC_API_KEY` is removed from the child env, so the subscription
 *   login is used rather than a key the user meant for the API adapter.
 * - Usage and cost come from the JSON result (`usage`, `total_cost_usd`).
 *
 * Session reuse (agent loops, i.e. requests with tools). Instead of re-sending
 * the whole transcript every turn, the first turn starts a CLI session
 * (`--session-id <uuid>`) and each later turn of the same conversation resumes
 * it (`--resume <uuid>`) with ONLY the new user message (the tool results) on
 * stdin. The CLI replays its stored history as real messages, so the API
 * prompt cache hits the whole earlier conversation too. Reuse is strictly
 * append-only: a turn resumes a session only when its rendered transcript
 * starts with exactly what that session already holds (everything sent plus
 * the CLI's own reply, verbatim) and the rest is new user text. Any history
 * edit (pruning, compaction, a transcript rewritten on escalation, a fresh
 * attempt, another system prompt or model, a reply we trimmed as a
 * hallucination) misses that prefix and starts a NEW session with the full
 * transcript. A lost session ("No conversation found") falls back to a full
 * re-send in the same turn.
 *
 * Privacy trade-off, chosen deliberately: an isolated `CLAUDE_CONFIG_DIR`
 * would log the user out, so session files are written by the user's real
 * CLI under `~/.claude/projects/<slug of the private cwd>/<uuid>.jsonl`. The
 * dedicated cwd keeps them in a folder that holds only Viberon sessions,
 * never mixed into the /resume history of a real project. They are DELETED
 * when a session is superseded (same task restarted with an edited history),
 * fails, is aborted, idles out (`SESSION_IDLE_MS`) or is evicted
 * (`MAX_SESSIONS`); on `closeClaudeCliSessions()`; synchronously on process
 * exit; and, for a crash that skipped all of that, by a sweep of stale files
 * in that folder the first time a session starts. Side calls (no tools) and
 * `VIBERON_CLAUDE_CLI_SESSIONS=0` keep `--no-session-persistence`: no file
 * at all.
 *
 * Failures are thrown with an HTTP-like status so `retry.ts` decides:
 * "too long"/context → 413 (the runner compacts), login problems → 401
 * (fatal), anything else → 503 (backoff and retry).
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  MAX_TEXT_CALLS_PER_TURN,
  parseTextToolCalls,
  type PlainMessage,
  toTextMessages,
  truncateHallucination,
} from "@/lib/ai/textproto";
import type { AiContent, AiProvider, AiTurnHandlers, AiTurnRequest, AiTurnResult } from "@/lib/ai/types";
import { which } from "@/lib/verify/env";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_CAP = 16 * 1024 * 1024;
/** An idle session's files are deleted after this long (the API cache lives 5 min anyway). */
const SESSION_IDLE_MS = 10 * 60_000;
/** At most this many live sessions; the least recently used beyond it is deleted. */
const MAX_SESSIONS = 8;
/** Session files older than this in our private project folder are crash leftovers. */
const STALE_SESSION_MS = 60 * 60_000;

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

const PROMPT_LEAD =
  "Below is the conversation so far. Write ONLY the next ASSISTANT message " +
  "(no '=== ASSISTANT ===' header, do not write the USER's side).\n\n";

function renderConvo(convo: PlainMessage[]): string {
  return convo.map((m) => `=== ${m.role === "user" ? "USER" : "ASSISTANT"} ===\n${m.content}`).join("\n\n");
}

/** The system prompt and the transcript as plain user/assistant messages. */
function renderPlain(request: AiTurnRequest): { system: string; convo: PlainMessage[] } {
  const system = request.system.map((b) => b.text).filter(Boolean).join("\n\n");
  const plain = toTextMessages(system, request.messages, request.tools ?? []);
  const sys = plain[0]?.role === "system" ? plain.shift()!.content : "";
  return { system: sys || "You are a helpful assistant.", convo: plain };
}

/** System prompt (with the tool contract) and the transcript as one stdin prompt. */
export function renderClaudeCliPrompt(request: AiTurnRequest): { system: string; prompt: string } {
  const { system, convo } = renderPlain(request);
  return { system, prompt: `${PROMPT_LEAD}${renderConvo(convo)}\n\n=== ASSISTANT ===\n` };
}

/** stdin of a resumed turn: only the new user message, in the same framing. */
function renderDelta(delta: PlainMessage[]): string {
  return `${renderConvo(delta)}\n\n=== ASSISTANT ===\n`;
}

/** The CLI's alias for a model id: `claude-cli:sonnet` → `sonnet`. */
function cliModel(model: string): string {
  return model.replace(/^claude-cli:/, "") || "haiku";
}

// ---------------------------------------------------------------------------
// Sessions: where the CLI keeps them, and how we find, advance and delete them.

interface CliSession {
  id: string;
  model: string;
  system: string;
  /** The conversation exactly as the CLI holds it: every message sent plus its replies. */
  sent: PlainMessage[];
  busy: boolean;
  lastUsed: number;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, CliSession>();
let exitHookInstalled = false;
let staleSweepDone = false;

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
}

/** The private, empty cwd every `claude -p` runs in (created on demand, resolved like the CLI does). */
function cliCwd(): string {
  const dir = path.join(os.tmpdir(), "viberon-claude-cli");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return realpathSync(dir);
  } catch {
    return os.tmpdir();
  }
}

/** `~/.claude/projects/<slug>`: the CLI names a project folder after its cwd with non-alphanumerics dashed. */
function projectDir(): string {
  return path.join(configDir(), "projects", cliCwd().replace(/[^a-zA-Z0-9]/g, "-"));
}

/** Everything the CLI may keep for one session id. */
function sessionPaths(id: string): string[] {
  const config = configDir();
  const project = projectDir();
  return [
    path.join(project, `${id}.jsonl`),
    path.join(project, id),
    path.join(config, "session-env", id),
    path.join(config, "file-history", id),
    path.join(config, "todos", `${id}-agent-${id}.json`),
  ];
}

async function deleteSessionFiles(id: string): Promise<void> {
  await Promise.all(sessionPaths(id).map((p) => rm(p, { recursive: true, force: true }).catch(() => {})));
}

function deleteSessionFilesSync(id: string): void {
  for (const p of sessionPaths(id)) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // Best effort at exit.
    }
  }
}

function dropSession(session: CliSession): Promise<void> {
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(session.id);
  return deleteSessionFiles(session.id);
}

function touch(session: CliSession): void {
  session.lastUsed = Date.now();
  if (session.timer) clearTimeout(session.timer);
  session.timer = setTimeout(() => void dropSession(session), SESSION_IDLE_MS);
  session.timer.unref?.();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const id of sessions.keys()) deleteSessionFilesSync(id);
    sessions.clear();
  });
}

/** Delete crash leftovers: files in our private project folder no live session owns and nobody touched lately. */
async function sweepStaleSessions(): Promise<void> {
  const dir = projectDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(
    names.map(async (name) => {
      const id = name.replace(/\.jsonl$/, "");
      if (sessions.has(id)) return;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info && Date.now() - info.mtimeMs > STALE_SESSION_MS) await rm(file, { recursive: true, force: true }).catch(() => {});
    }),
  );
}

function samePlain(a: PlainMessage, b: PlainMessage): boolean {
  return a.role === b.role && a.content === b.content;
}

/**
 * An idle session this transcript extends append-only: the session's whole
 * history is a verbatim prefix and everything after it is user text.
 */
function findSession(model: string, system: string, convo: PlainMessage[]): CliSession | null {
  for (const session of sessions.values()) {
    if (session.busy || session.model !== model || session.system !== system) continue;
    const n = session.sent.length;
    if (convo.length <= n) continue;
    if (!session.sent.every((m, i) => samePlain(m, convo[i]!))) continue;
    if (!convo.slice(n).every((m) => m.role === "user")) continue;
    return session;
  }
  return null;
}

function startSession(model: string, system: string, convo: PlainMessage[]): CliSession {
  installExitHook();
  if (!staleSweepDone) {
    staleSweepDone = true;
    void sweepStaleSessions();
  }
  // The same task (same opening message) restarted with an edited history:
  // its earlier session can never be resumed again, so delete it now.
  for (const old of [...sessions.values()]) {
    if (!old.busy && old.model === model && old.system === system && old.sent[0] && convo[0] && samePlain(old.sent[0], convo[0])) {
      void dropSession(old);
    }
  }
  const idle = [...sessions.values()].filter((s) => !s.busy).sort((a, b) => a.lastUsed - b.lastUsed);
  while (sessions.size >= MAX_SESSIONS && idle.length) void dropSession(idle.shift()!);
  const session: CliSession = { id: randomUUID(), model, system, sent: [], busy: true, lastUsed: Date.now() };
  sessions.set(session.id, session);
  return session;
}

/** Delete every live session's files now (end of a run, shutdown). */
export async function closeClaudeCliSessions(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => dropSession(s)));
}

// ---------------------------------------------------------------------------

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
    const child = spawn(bin, args, { cwd: cliCwd(), env, stdio: ["pipe", "pipe", "pipe"] });
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
  session_id?: string;
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

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** One `claude -p` call: the system prompt in a temp file, `input` on stdin, the parsed JSON result back. */
async function callCli(bin: string, request: AiTurnRequest, system: string, sessionArgs: string[], input: string): Promise<CliResult> {
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
        ...sessionArgs,
        "--system-prompt-file", sysPath,
      ],
      input,
      request.signal,
      childEnv(request),
    );
  } catch (error) {
    if (isAbort(error)) throw error;
    throw failure(error instanceof Error ? error.message : String(error));
  } finally {
    await unlink(sysPath).catch(() => {});
  }
  const data = parseCliJson(outcome.stdout);
  if (!data || data.is_error) {
    throw failure(data?.result || outcome.stderr.trim() || outcome.stdout.trim() || `exit code ${outcome.code}`);
  }
  return data;
}

export const claudeCliProvider: AiProvider = {
  id: "claude-cli",

  isConfigured(): boolean {
    return claudeBinary() !== null;
  },

  async runTurn(request: AiTurnRequest, handlers: AiTurnHandlers = {}): Promise<AiTurnResult> {
    const bin = claudeBinary();
    if (!bin) throw new ClaudeCliError("Claude CLI: `claude` is not on PATH", 401);
    const { system, convo } = renderPlain(request);
    const model = cliModel(request.model);
    const tools = request.tools ?? [];
    const reuse =
      process.env.VIBERON_CLAUDE_CLI_SESSIONS !== "0" && tools.length > 0 && convo[convo.length - 1]?.role === "user";

    let data: CliResult | null = null;
    let session = reuse ? findSession(model, system, convo) : null;
    if (session) {
      session.busy = true;
      try {
        data = await callCli(bin, request, system, ["--resume", session.id], renderDelta(convo.slice(session.sent.length)));
      } catch (error) {
        // Whatever the CLI stored for a failed turn is unknown: never resume it.
        await dropSession(session);
        session = null;
        const lost = error instanceof ClaudeCliError && /no conversation found|session .*not found/i.test(error.message);
        if (!lost) throw error;
      }
    }
    if (!data) {
      if (reuse) session = startSession(model, system, convo);
      try {
        data = await callCli(
          bin,
          request,
          system,
          session ? ["--session-id", session.id] : ["--no-session-persistence"],
          `${PROMPT_LEAD}${renderConvo(convo)}\n\n=== ASSISTANT ===\n`,
        );
      } catch (error) {
        if (session) await dropSession(session);
        throw error;
      }
    }

    const raw = (data.result ?? "").trim();
    let text = raw;
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

    if (session) {
      // Keep the session only if the CLI's copy of its reply is what the
      // transcript will carry back; a trimmed hallucination or an empty reply
      // would diverge, and so would a session id the CLI swapped.
      if (text && text === raw && (!data.session_id || data.session_id === session.id)) {
        session.sent = [...convo, { role: "assistant", content: text }];
        session.busy = false;
        touch(session);
      } else {
        await dropSession(session);
      }
    }

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
    for (const session of sessions.values()) if (session.timer) clearTimeout(session.timer);
    sessions.clear();
    staleSweepDone = false;
  },
  /** Ids of the live sessions (for tests). */
  sessionIds(): string[] {
    return [...sessions.keys()];
  },
  cwd: cliCwd,
  projectDir,
};

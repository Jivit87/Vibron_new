/**
 * Provider-agnostic AI types.
 *
 * Everything above `lib/ai/*` speaks these shapes; each provider adapter
 * translates them to its own wire format. The shape is modelled on
 * Anthropic's content-block protocol because it is the most expressive
 * (tool_use / tool_result blocks, cacheable system prefixes); the Groq
 * adapter degrades it to OpenAI-style messages.
 */

/**
 * "openai" = any OpenAI-compatible endpoint (OpenAI, Azure, Gemini, OpenRouter, vLLM, Ollama, …).
 * "claude-cli" = a locally logged-in Claude Code CLI (`claude -p`, subscription, no API key).
 */
export type ProviderId = "anthropic" | "groq" | "openai" | "nvidia" | "gemini" | "deepseek" | "claude-cli";

/** A single message in the running conversation. */
export interface AiMessage {
  role: "user" | "assistant";
  content: AiContent[];
}

export type AiContent =
  | { type: "text"; text: string }
  /**
   * A reasoning block from a thinking-enabled model. It must be echoed back
   * byte-for-byte (signature included) on the next request of a tool loop,
   * so it lives in the transcript even though the UI never renders it from
   * here. Providers without thinking simply drop these on the way out.
   */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string }
  /** A user-supplied image (base64, no `data:` prefix). Text-only providers drop it. */
  | {
      type: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      data: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Opaque provider data that must be sent back verbatim with this call,
       * e.g. Gemini's `extra_content.google.thought_signature`. Adapters that
       * do not understand it drop it.
       */
      extra?: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

/**
 * A block of the system prompt. Splitting the system prompt into blocks
 * lets us mark the *stable* prefix (project memory, repo skeleton, tool
 * conventions) as cacheable while leaving the volatile tail uncached.
 * On Anthropic that is a ~90% cost reduction on every follow-up turn.
 */
export interface AiSystemBlock {
  text: string;
  /** Mark this block as the end of the cacheable prefix. */
  cache?: boolean;
}

export interface AiToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Reasoning-depth hint. Maps to Anthropic `output_config.effort`. */
export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AiTurnRequest {
  model: string;
  system: AiSystemBlock[];
  messages: AiMessage[];
  tools?: AiToolDef[];
  maxTokens?: number;
  effort?: AiEffort;
  /** Ask the provider to stream a readable summary of its reasoning. */
  showThinking?: boolean;
  signal?: AbortSignal;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache (billed at ~0.1x). */
  cacheReadTokens: number;
  /** Tokens written to the prompt cache (billed at ~1.25x). */
  cacheWriteTokens: number;
}

export const EMPTY_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the provider returned arguments that could not be parsed into
   * an object. The call stays in the transcript (with `input: {}`) so the
   * loop can answer it with an error result the model can learn from,
   * instead of silently dropping it.
   */
  inputError?: string;
  /** Provider data to echo back with this call (see the `tool_use` block). */
  extra?: Record<string, unknown>;
  /**
   * The arguments that did arrive, for a call cut off by the output cap
   * (`inputError === TRUNCATED_CALL_ERROR`). Used only to name what was lost.
   */
  partialInput?: Record<string, unknown>;
}

/** `inputError` of a tool call the output cap cut off mid-arguments. */
export const TRUNCATED_CALL_ERROR = "The output limit was reached mid tool call; the call was cut off and not run.";

export type AiStopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "refusal"
  | "pause_turn"
  | "stop_sequence"
  | "aborted";

export interface AiTurnResult {
  /** Concatenated assistant text for this turn. */
  text: string;
  /** Summarized reasoning, when the provider returns any. */
  thinking: string;
  toolCalls: AiToolCall[];
  stopReason: AiStopReason;
  usage: AiUsage;
  /** Populated when `stopReason === "refusal"`. */
  refusal?: { category: string | null; explanation?: string };
  /** Full assistant content, ready to append to `messages` for the next turn. */
  content: AiContent[];
  /** USD the provider itself reported for this turn (the Claude CLI does); wins over the price table. */
  costUsd?: number;
}

/** Streaming callbacks fired while a turn is in flight. */
export interface AiTurnHandlers {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  /** Fired once per tool call as soon as its name is known. */
  onToolCallStart?: (name: string) => void;
  /** Fired before a transient provider failure is retried. */
  onRetry?: (info: AiRetryInfo) => void;
}

export interface AiRetryInfo {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
}

export interface AiProvider {
  readonly id: ProviderId;
  /** Whether a usable credential is configured right now. */
  isConfigured(): boolean;
  runTurn(
    request: AiTurnRequest,
    handlers?: AiTurnHandlers,
  ): Promise<AiTurnResult>;
}

const MISSING_CREDENTIAL: Record<ProviderId, string> = {
  anthropic: "No Anthropic API key configured. Add one in Settings → Providers, or set ANTHROPIC_API_KEY.",
  groq: "No Groq API key configured. Add one in Settings → Providers, or set GROQ_API_KEY.",
  nvidia: "No NVIDIA API key configured. Add one in Settings → Providers, or set NVIDIA_API_KEY.",
  gemini: "No Gemini API key configured. Add one in Settings → Providers, or set GEMINI_API_KEY.",
  deepseek: "No DeepSeek API key configured. Add one in Settings → Providers, or set DEEPSEEK_API_KEY.",
  "claude-cli":
    "The Claude CLI is not available: install Claude Code so `claude` is on PATH, then run `claude auth login` (a Claude subscription, no API key).",
  openai: "No OpenAI-compatible API key configured. Set AI_API_KEY (and AI_BASE_URL / AI_MODEL for other endpoints).",
};

/** Raised when a provider has no credential configured. */
export class MissingCredentialError extends Error {
  constructor(readonly provider: ProviderId) {
    super(MISSING_CREDENTIAL[provider]);
    this.name = "MissingCredentialError";
  }
}

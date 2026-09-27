/**
 * OpenAI-compatible chat-completions adapter over plain `fetch` (ported from
 * Pramana `llm/openai_compat.py` + `llm/__init__.py`).
 *
 * One adapter covers OpenAI, Azure OpenAI, Gemini's OpenAI endpoint,
 * OpenRouter, Groq, xAI, DeepSeek, Mistral, Together, Fireworks, Cerebras,
 * NVIDIA, Hugging Face, vLLM and Ollama. The evaluation model is unknown, so
 * the adapter is built to survive hostile endpoints:
 *
 * - **Tool protocol fallback.** An endpoint that rejects `tools` is switched
 *   (for the session) to the text protocol in `textproto.ts`. In native mode,
 *   tool calls a model writes as prose are recovered too.
 * - **Parameter negotiation.** A 400 naming a parameter (temperature on
 *   reasoning models, max_tokens vs max_completion_tokens, parallel_tool_calls,
 *   reasoning_effort, stop) drops or renames it, remembered per model.
 * - **Perturbing retries.** Some endpoints fail deterministically on one
 *   transcript (5xx, garbage bodies, empty choices). Identical retries cannot
 *   help there, so each retry perturbs the request a little more: shorten the
 *   newest tool output, add a "continue" nudge, raise the temperature.
 * - 429s and exhausted 5xx are thrown with their status so the shared retry
 *   layer (`retry.ts`) applies backoff and Retry-After.
 */

import { getApiKey } from "@/lib/ai/credentials";
import { getModel, outputCap } from "@/lib/ai/models";
import { geminiOpenAiBase, markGeminiUnavailable } from "@/lib/ai/gemini-catalog";
import { markNvidiaUnavailable, ModelUnavailableError, nvidiaBaseUrl } from "@/lib/ai/nvidia-catalog";
import { toOpenAiMessages } from "@/lib/ai/openai-messages";
import { resolveOpenAiCompatEnv } from "@/lib/ai/provider-config";
import {
  MAX_TEXT_CALLS_PER_TURN,
  TEXT_STOP_SEQUENCES,
  parseJsonArgs,
  parseTextToolCalls,
  toTextMessages,
  truncateHallucination,
} from "@/lib/ai/textproto";
import {
  MissingCredentialError,
  TRUNCATED_CALL_ERROR,
  type AiContent,
  type AiMessage,
  type AiProvider,
  type AiStopReason,
  type AiToolCall,
  type AiTurnHandlers,
  type AiTurnRequest,
  type AiTurnResult,
} from "@/lib/ai/types";

const OVERFLOW_HINTS = [
  "context length",
  "context_length",
  "maximum context",
  "too many tokens",
  "prompt is too long",
  "reduce the length",
  "input is too long",
  "context window",
  "exceeds the limit",
  "request too large",
];
const TOOLS_UNSUPPORTED_HINTS = [
  "does not support tools",
  "tools is not supported",
  "tool use is not supported",
  "function calling is not",
  "does not support function",
  "tools are not supported",
  "not support tool",
];
const NEGOTIABLE = ["temperature", "parallel_tool_calls", "reasoning_effort", "seed", "top_p", "stop"];
const PERTURB_ATTEMPTS = 4;

interface ModelState {
  dropped: Set<string>;
  toolMode: "auto" | "native" | "text";
  reasoningWindow: number;
}

const states = new Map<string, ModelState>();

function stateFor(model: string, provider = "openai"): ModelState {
  const key = `${provider}:${model}`;
  let state = states.get(key);
  if (!state) {
    const mode = (process.env.VIBERON_TOOL_MODE || process.env.AI_TOOL_MODE || "auto").toLowerCase();
    state = {
      dropped: new Set(),
      toolMode: mode === "text" || mode === "native" ? mode : "auto",
      reasoningWindow: provider === "deepseek" || /deepseek/i.test(model) ? Infinity : /gpt-oss/i.test(model) ? 6 : 0,
    };
    states.set(key, state);
  }
  return state;
}

let sleepImpl = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Test seams: skip waits, and forget per-model negotiation state. */
export const openAiCompatTesting = {
  setSleep(fn: (ms: number) => Promise<void>) {
    sleepImpl = fn;
  },
  reset() {
    states.clear();
  },
  state(model: string) {
    return stateFor(model);
  },
};

class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

function hasAny(text: string, hints: string[]): boolean {
  return hints.some((h) => text.includes(h));
}

/** Drop or rename a parameter the endpoint complained about. True if anything changed. */
export function negotiateParams(
  state: ModelState,
  errorText: string,
  payload: Record<string, unknown>,
): boolean {
  const low = errorText.toLowerCase();
  let changed = false;
  if (low.includes("reasoning") && state.reasoningWindow && !low.includes("reasoning_effort")) {
    state.reasoningWindow = 0; // The endpoint rejects passed-back reasoning.
    changed = true;
  }
  for (const param of NEGOTIABLE) {
    if (low.includes(param) && param in payload && !state.dropped.has(param)) {
      state.dropped.add(param);
      changed = true;
    }
  }
  if (low.includes("max_tokens") && low.includes("max_completion_tokens") && "max_tokens" in payload) {
    state.dropped.add("max_tokens");
    changed = true;
  } else if (low.includes("max_completion_tokens") && "max_completion_tokens" in payload) {
    state.dropped.add("max_completion_tokens");
    changed = true;
  } else if (
    low.includes("max_tokens") &&
    "max_tokens" in payload &&
    (low.includes("unsupported") || low.includes("not supported"))
  ) {
    state.dropped.add("max_tokens");
    changed = true;
  }
  return changed;
}

/** Make the transcript a little different on each retry after a deterministic failure. */
function perturb(messages: AiMessage[], attempt: number): AiMessage[] {
  if (attempt === 0) return messages;
  const out: AiMessage[] = structuredClone(messages);
  // The newest tool output is the most common trigger: shorten it.
  const results = out.flatMap((m) => m.content).filter((b) => b.type === "tool_result");
  const newest = results[results.length - 1];
  if (newest && newest.type === "tool_result" && newest.content.length > 600) {
    newest.content = `${newest.content.slice(0, 300)}\n[... output shortened after a provider error ...]\n${newest.content.slice(-200)}`;
  }
  if (attempt >= 2) {
    const last = out[out.length - 1];
    const nudge = { type: "text" as const, text: "Continue with the task." };
    if (last?.role === "user") last.content.push(nudge);
    else out.push({ role: "user", content: [nudge] });
  }
  return out;
}

interface Endpoint {
  url: string;
  headers: Record<string, string>;
  provider: string;
  wireModel: string;
}

export { NVIDIA_BASE_URL } from "@/lib/ai/nvidia-catalog";

async function endpoint(model: string): Promise<Endpoint> {
  // NVIDIA models carry their own endpoint and key, independent of the
  // environment's generic OpenAI-compatible configuration.
  if (getModel(model)?.provider === "nvidia") {
    const key = await getApiKey("nvidia");
    if (!key) throw new MissingCredentialError("nvidia");
    return {
      url: `${nvidiaBaseUrl()}/chat/completions`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      provider: "nvidia",
      wireModel: model.replace(/^nvidia:/, ""),
    };
  }
  if (getModel(model)?.provider === "gemini") {
    const key = await getApiKey("gemini");
    if (!key) throw new MissingCredentialError("gemini");
    return {
      url: `${geminiOpenAiBase()}/chat/completions`,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      provider: "gemini",
      wireModel: model.replace(/^gemini:/, ""),
    };
  }
  const cfg = resolveOpenAiCompatEnv();
  const key = (await getApiKey("openai")) ?? cfg.apiKey;
  const local = /localhost|127\.0\.0\.1/.test(cfg.baseUrl);
  if (!key && !local && cfg.provider !== "ollama") throw new MissingCredentialError("openai");
  const wireModel = model.startsWith("openai:") ? model.slice("openai:".length) : model;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) {
    if (cfg.azure) headers["api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  if (cfg.provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/viberon";
    headers["X-Title"] = "Viberon";
  }
  let url = `${cfg.baseUrl}/chat/completions`;
  if (cfg.azure && !cfg.baseUrl.includes("/deployments/")) {
    url = `${cfg.baseUrl}/openai/deployments/${wireModel}/chat/completions`;
  }
  if (cfg.apiVersion) url += `${url.includes("?") ? "&" : "?"}api-version=${cfg.apiVersion}`;
  return { url, headers, provider: cfg.provider, wireModel };
}

function buildPayload(
  request: AiTurnRequest,
  messages: AiMessage[],
  state: ModelState,
  ep: Endpoint,
  textMode: boolean,
  temperature: number | undefined,
): Record<string, unknown> {
  const tools = request.tools ?? [];
  const spec = getModel(request.model);
  const wire: unknown[] = textMode
    ? toTextMessages(request.system.map((b) => b.text).filter(Boolean).join("\n\n"), messages, tools)
    : toOpenAiMessages(
        { system: request.system, messages },
        {
          toolNames: ep.provider !== "openai",
          reasoningWindow: state.reasoningWindow,
          reasoningField: ep.provider === "deepseek" || /deepseek/i.test(ep.wireModel) ? "reasoning_content" : "reasoning",
          thoughtSignatures: ep.provider === "gemini",
        },
      );
  const payload: Record<string, unknown> = { model: ep.wireModel, messages: wire };
  if (!textMode && tools.length) {
    payload.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    if (
      !state.dropped.has("parallel_tool_calls") &&
      ["openai", "openrouter", "groq", "together", "fireworks"].includes(ep.provider)
    ) {
      payload.parallel_tool_calls = true;
    }
  }
  const envTemp = Number(process.env.AI_TEMPERATURE);
  const temp = temperature ?? (Number.isFinite(envTemp) && process.env.AI_TEMPERATURE ? envTemp : 0);
  if (!state.dropped.has("temperature")) payload.temperature = temp;
  const maxTokens = outputCap(spec, request.maxTokens);
  const useCompletion =
    (ep.provider === "openai" && /^(o1|o3|o4|gpt-5)/.test(ep.wireModel)) || state.dropped.has("max_tokens");
  if (useCompletion) {
    if (!state.dropped.has("max_completion_tokens")) payload.max_completion_tokens = maxTokens;
  } else {
    payload.max_tokens = maxTokens;
  }
  const effort = (process.env.AI_REASONING_EFFORT ?? "").trim();
  if (effort && !state.dropped.has("reasoning_effort")) payload.reasoning_effort = effort;
  if (ep.provider === "openrouter") payload.usage = { include: true };
  if (textMode && tools.length && !state.dropped.has("stop")) payload.stop = TEXT_STOP_SEQUENCES;
  return payload;
}

interface ChoiceMessage {
  content?: string | { text?: string }[] | null;
  reasoning_content?: unknown;
  reasoning?: unknown;
  tool_calls?: {
    id?: string;
    function?: { name?: string; arguments?: unknown };
    /** Gemini: `{ google: { thought_signature } }`, required back on the next turn. */
    extra_content?: unknown;
  }[];
}

function parseResponse(
  data: Record<string, unknown>,
  request: AiTurnRequest,
  textMode: boolean,
  handlers: AiTurnHandlers,
): AiTurnResult {
  const choice = (data.choices as { message?: ChoiceMessage; finish_reason?: string }[])[0];
  const message = choice.message ?? {};
  let text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((p) => p?.text ?? "").join("")
        : "";
  let reasoning = message.reasoning_content ?? message.reasoning ?? "";
  if (typeof reasoning !== "string") reasoning = JSON.stringify(reasoning).slice(0, 4000);
  const tools = request.tools ?? [];
  const finish = choice.finish_reason ?? "";

  const toolCalls: AiToolCall[] = [];
  for (const [index, raw] of (message.tool_calls ?? []).entries()) {
    const name = raw.function?.name ?? "";
    if (!name) continue;
    const id = raw.id || `call_${Date.now().toString(36)}_${index}`;
    const extra =
      raw.extra_content && typeof raw.extra_content === "object"
        ? { extra_content: raw.extra_content as Record<string, unknown> }
        : undefined;
    try {
      toolCalls.push({ id, name, input: parseJsonArgs(raw.function?.arguments), ...(extra ? { extra } : {}) });
    } catch (error) {
      toolCalls.push({
        id,
        name,
        ...(extra ? { extra } : {}),
        input: {},
        inputError: `Tool arguments were not valid JSON (${error instanceof Error ? error.message : String(error)}): ${String(raw.function?.arguments).slice(0, 200)}`,
      });
    }
  }
  // Cut off by the output cap: the last native call is incomplete even when
  // its arguments happen to parse. Flag it so it is never run.
  const cut = finish === "length" ? toolCalls[toolCalls.length - 1] : undefined;
  if (cut) {
    if (!cut.inputError) cut.partialInput = cut.input;
    cut.input = {};
    cut.inputError = TRUNCATED_CALL_ERROR;
  }

  if (textMode && tools.length) {
    // Drop anything the model "imagined" after its calls (fake results).
    text = truncateHallucination(text);
    const parsed = parseTextToolCalls(text, tools);
    toolCalls.push(...parsed.calls.slice(0, MAX_TEXT_CALLS_PER_TURN));
  } else if (!toolCalls.length && text && tools.length) {
    // The model wrote its tool call as text despite native tools: recover it.
    const parsed = parseTextToolCalls(text, tools);
    if (parsed.calls.length) {
      toolCalls.push(...parsed.calls.slice(0, MAX_TEXT_CALLS_PER_TURN));
      text = parsed.prose;
    }
  }

  if (reasoning) handlers.onThinking?.(reasoning as string);
  const shown = textMode && toolCalls.length ? parseTextToolCalls(text, tools).prose : text;
  if (shown) handlers.onText?.(shown);
  for (const call of toolCalls) handlers.onToolCallStart?.(call.name);

  const content: AiContent[] = [];
  if (reasoning) content.push({ type: "thinking", thinking: reasoning as string, signature: "" });
  if (text) content.push({ type: "text", text });
  for (const call of toolCalls) {
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.name,
      input: call.input,
      ...(call.extra ? { extra: call.extra } : {}),
    });
  }

  const usage = (data.usage ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cached = Number(details.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0) || 0;
  const prompt = Number(usage.prompt_tokens ?? 0) || 0;
  // "length" wins over "tool_use": the runner must know the turn was cut off.
  const stopReason: AiStopReason =
    finish === "length" ? "max_tokens" : toolCalls.length ? "tool_use" : "end_turn";

  return {
    text: shown,
    thinking: (reasoning as string) || "",
    toolCalls,
    stopReason,
    content,
    usage: {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: Number(usage.completion_tokens ?? 0) || 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
  };
}

export const openaiCompatProvider: AiProvider = {
  id: "openai",

  isConfigured(): boolean {
    return Boolean(process.env.AI_API_KEY || process.env.OPENAI_API_KEY || process.env.AI_BASE_URL);
  },

  async runTurn(request: AiTurnRequest, handlers: AiTurnHandlers = {}): Promise<AiTurnResult> {
    const ep = await endpoint(request.model);
    const state = stateFor(request.model, ep.provider);
    const tools = request.tools ?? [];
    let negotiations = 0;
    let lastError = "";

    for (let attempt = 0; attempt < PERTURB_ATTEMPTS; ) {
      const textMode = tools.length > 0 && state.toolMode === "text";
      const temperature = attempt >= 3 ? 0.7 : undefined;
      const payload = buildPayload(request, perturb(request.messages, attempt), state, ep, textMode, temperature);

      let response: Response;
      try {
        response = await fetch(ep.url, {
          method: "POST",
          headers: ep.headers,
          body: JSON.stringify(payload),
          signal: request.signal,
        });
      } catch (error) {
        if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        // Network failure: surface as retryable to the shared backoff layer.
        throw new Error(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }

      const body = await response.text().catch(() => "");
      const low = body.toLowerCase();

      if (response.status === 200) {
        let data: Record<string, unknown> | null = null;
        try {
          data = JSON.parse(body) as Record<string, unknown>;
        } catch {
          data = null;
        }
        if (data && Array.isArray(data.choices) && data.choices.length > 0) {
          return parseResponse(data, request, textMode, handlers);
        }
        const detail = data ? JSON.stringify(data.error ?? data).slice(0, 500) : body.slice(0, 300);
        if (hasAny(detail.toLowerCase(), OVERFLOW_HINTS)) {
          throw new HttpStatusError(`context length exceeded: ${detail}`, 413);
        }
        lastError = data ? `empty choices from model: ${detail}` : `non-JSON response: ${detail}`;
        attempt += 1;
        await sleepImpl(1000 * attempt);
        continue;
      }

      // NVIDIA: 410 = model retired, 404 = not enabled for this account.
      // Neither will change on retry; remember it so runTurn can move on.
      if (ep.provider === "nvidia" && (response.status === 404 || response.status === 410)) {
        markNvidiaUnavailable(ep.wireModel);
        throw new ModelUnavailableError(request.model, response.status, body);
      }
      // Gemini: 404 = model shut down or unknown; a 429 that names a *daily*
      // quota will not clear within the run, unlike a per-minute limit.
      if (
        ep.provider === "gemini" &&
        // "limit: 0" = the key's plan has no access to this model at all
        // (Gemini Pro on the free tier); waiting will not help either.
        (response.status === 404 || (response.status === 429 && /per.?day|daily|limit: ?0\b/i.test(body)))
      ) {
        markGeminiUnavailable(ep.wireModel);
        throw new ModelUnavailableError(request.model, response.status, body, "Gemini");
      }
      if (response.status === 400 || response.status === 404 || response.status === 422) {
        if (hasAny(low, OVERFLOW_HINTS)) {
          throw new HttpStatusError(`maximum context length exceeded: ${body.slice(0, 500)}`, 413);
        }
        if (tools.length && !textMode && state.toolMode !== "native" && hasAny(low, TOOLS_UNSUPPORTED_HINTS)) {
          state.toolMode = "text";
          continue;
        }
        if (negotiations < 6 && negotiateParams(state, body, payload)) {
          negotiations += 1;
          continue;
        }
        throw new HttpStatusError(`HTTP ${response.status} from ${ep.url}: ${body.slice(0, 1000)}`, response.status);
      }
      if (response.status === 401 || response.status === 403) {
        throw new HttpStatusError(
          `authentication failed (HTTP ${response.status}, invalid api_key?): ${body.slice(0, 300)}`,
          response.status,
        );
      }
      if (response.status === 413) {
        throw new HttpStatusError(`request too large: ${body.slice(0, 300)}`, 413);
      }
      if (response.status === 429) {
        throw new HttpStatusError(`HTTP 429 rate limit: ${body.slice(0, 300)}`, 429, response.headers);
      }
      // 408/409/425/5xx: perturb and retry here; the shared layer backs off after that.
      lastError = `HTTP ${response.status}: ${body.slice(0, 300)}`;
      attempt += 1;
      if (attempt >= PERTURB_ATTEMPTS) {
        throw new HttpStatusError(lastError, response.status >= 500 ? response.status : 503, response.headers);
      }
      await sleepImpl(1500 * attempt);
    }
    // Garbage bodies all the way down: let the shared layer back off and retry.
    throw new HttpStatusError(`service unavailable: ${lastError}`, 503);
  },
};


/**
 * The same adapter bound to NVIDIA's catalog: `endpoint()` routes any model
 * whose spec says `provider: "nvidia"` to NVIDIA with the NVIDIA key.
 */
export const nvidiaProvider: AiProvider = {
  ...openaiCompatProvider,
  id: "nvidia",
  isConfigured(): boolean {
    return Boolean(process.env.NVIDIA_API_KEY || process.env.AI_API_KEY?.startsWith("nvapi-"));
  },
};

/** The same adapter bound to Gemini's OpenAI-compatible endpoint. */
export const geminiProvider: AiProvider = {
  ...openaiCompatProvider,
  id: "gemini",
  isConfigured(): boolean {
    return Boolean(process.env.GEMINI_API_KEY || process.env.AI_API_KEY?.startsWith("AIza"));
  },
};

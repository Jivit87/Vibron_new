import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureModelReady, resolveModel, runTurn } from "@/lib/ai";
import { getApiKey, invalidateCredentialCache } from "@/lib/ai/credentials";
import { DEEPSEEK_BASE_URL, deepseekTesting, isAmbiguousSkKey } from "@/lib/ai/deepseek";
import { deepseekProvider, openAiCompatTesting } from "@/lib/ai/openai-compat";
import type { AiMessage, AiToolDef, AiTurnRequest } from "@/lib/ai/types";

const ENV_KEYS = [
  "AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY",
  "GROQ_API_KEY", "NVIDIA_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL",
  "VIBERON_MODEL", "VIBERON_STORE",
];
const saved: Record<string, string | undefined> = {};
const HEX_KEY = `sk-${"0123456789abcdef".repeat(2)}`;

const TOOLS: AiToolDef[] = [
  { name: "run", description: "Run.", input_schema: { type: "object", properties: { cmd: { type: "string" } } } },
];

/** A tool loop three assistant turns deep, each with its own reasoning. */
function toolLoop(): AiMessage[] {
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: "fix it" }] }];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `think ${i}`, signature: "" },
        { type: "tool_use", id: `c${i}`, name: "run", input: { cmd: `step ${i}` } },
      ],
    });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `c${i}`, content: `out ${i}` }] });
  }
  return messages;
}

function request(model: string, messages: AiMessage[] = toolLoop()): AiTurnRequest {
  return { model, system: [{ text: "SYS" }], messages, tools: TOOLS };
}

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function stubFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      });
      return respond(url);
    }),
  );
  return calls;
}

const OK = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: "done", reasoning_content: "final thought" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 80 },
    }),
    { status: 200 },
  );

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.VIBERON_STORE = "memory";
  invalidateCredentialCache();
  openAiCompatTesting.reset();
  openAiCompatTesting.setSleep(async () => {});
  deepseekTesting.reset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidateCredentialCache();
  vi.unstubAllGlobals();
});

describe("DeepSeek provider", () => {
  it("calls api.deepseek.com with DEEPSEEK_API_KEY and the bare model id, and reads cache hits", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    const calls = stubFetch(OK);
    const result = await runTurn(request("deepseek:deepseek-v4-flash"));
    expect(calls[0]!.url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect(calls[0]!.headers.Authorization).toBe("Bearer sk-deepseek");
    expect(calls[0]!.body!.model).toBe("deepseek-v4-flash");
    expect(result.usage).toMatchObject({ inputTokens: 20, cacheReadTokens: 80, outputTokens: 5 });
    expect(result.thinking).toBe("final thought");
  });

  it("sends reasoning_content back on EVERY earlier assistant turn with tool calls", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    const calls = stubFetch(OK);
    await deepseekProvider.runTurn(request("deepseek:deepseek-v4-pro"));
    const assistants = (calls[0]!.body!.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[] }[])
      .filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(3);
    expect(assistants.map((m) => m.reasoning_content)).toEqual(["think 1", "think 2", "think 3"]);
    expect(assistants.every((m) => m.tool_calls?.length === 1)).toBe(true);
  });

  it("a 400 about reasoning_content never switches the pass-back off", async () => {
    process.env.DEEPSEEK_API_KEY = "sk-deepseek";
    const calls = stubFetch(
      () => new Response('{"error":{"message":"Missing `reasoning_content` field in the assistant message"}}', { status: 400 }),
    );
    await expect(deepseekProvider.runTurn(request("deepseek:deepseek-v4-flash"))).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
    expect(openAiCompatTesting.state("deepseek:deepseek-v4-flash", "deepseek").reasoningWindow).toBe(Infinity);
  });

  it("an ambiguous sk-+32hex AI_API_KEY is routed by probing /models once", async () => {
    expect(isAmbiguousSkKey(HEX_KEY)).toBe(true);
    expect(isAmbiguousSkKey("sk-proj-abc")).toBe(false);
    process.env.AI_API_KEY = HEX_KEY;
    const calls = stubFetch((url) =>
      url.startsWith(DEEPSEEK_BASE_URL) ? new Response('{"data":[]}', { status: 200 }) : new Response("{}", { status: 401 }),
    );
    expect(await getApiKey("deepseek")).toBe(HEX_KEY);
    expect(await getApiKey("openai")).toBeNull();
    invalidateCredentialCache();
    await getApiKey("deepseek");
    // One probe per vendor, however often credentials are re-read.
    expect(calls.map((c) => c.url).sort()).toEqual([`${DEEPSEEK_BASE_URL}/models`, "https://api.openai.com/v1/models"]);
    await expect(ensureModelReady("deepseek:deepseek-v4-flash")).resolves.toBeUndefined();

    // AI_MODEL may name the bare DeepSeek id.
    process.env.AI_MODEL = "deepseek-v4-flash";
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("deepseek:deepseek-v4-flash");
  });

  it("an ambiguous key that OpenAI accepts stays with the OpenAI adapter", async () => {
    process.env.AI_API_KEY = HEX_KEY;
    stubFetch((url) =>
      url.startsWith(DEEPSEEK_BASE_URL) ? new Response("{}", { status: 401 }) : new Response('{"data":[]}', { status: 200 }),
    );
    expect(await getApiKey("openai")).toBe(HEX_KEY);
    expect(await getApiKey("deepseek")).toBeNull();
    await expect(ensureModelReady("deepseek:deepseek-v4-flash")).rejects.toThrow(/No DeepSeek API key/);
  });

  it("settings verification lists DeepSeek models with the key", async () => {
    const calls = stubFetch(() => new Response('{"data":[]}', { status: 200 }));
    const { PUT } = await import("@/app/api/settings/keys/route");
    const response = await PUT(
      new Request("http://x/api/settings/keys", { method: "PUT", body: JSON.stringify({ provider: "deepseek", key: "sk-ds" }) }),
    );
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ url: `${DEEPSEEK_BASE_URL}/models`, headers: { authorization: "Bearer sk-ds" } });
    const body = (await response.json()) as { providers: { provider: string; configured: boolean }[] };
    expect(body.providers.find((p) => p.provider === "deepseek")?.configured).toBe(true);
    const { setApiKey } = await import("@/lib/ai/credentials");
    await setApiKey("deepseek", null);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyProviderError, resolveModel } from "@/lib/ai";
import { getApiKey, invalidateCredentialCache } from "@/lib/ai/credentials";
import { getModel } from "@/lib/ai/models";
import { openAiCompatTesting, openaiCompatProvider } from "@/lib/ai/openai-compat";
import { detectProvider, resolveOpenAiCompatEnv } from "@/lib/ai/provider-config";
import { runTurnWithRetry } from "@/lib/ai/retry";
import type { AiToolDef, AiTurnRequest } from "@/lib/ai/types";

const ENV_KEYS = ["AI_API_KEY", "AI_BASE_URL", "AI_MODEL", "AI_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "AI_API_VERSION"];
const saved: Record<string, string | undefined> = {};

const TOOLS: AiToolDef[] = [
  {
    name: "read_file",
    description: "Read a file.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function stubFetch(responses: (Response | ((body: Record<string, unknown>) => Response))[]) {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, headers: init.headers as Record<string, string>, body });
      const next = responses.shift() ?? ok({ content: "done" });
      return typeof next === "function" ? next(body) : next;
    }),
  );
  return calls;
}

function ok(message: Record<string, unknown>, usage = { prompt_tokens: 50, completion_tokens: 5 }): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage }), { status: 200 });
}
function status(code: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), { status: code });
}

function request(overrides: Partial<AiTurnRequest> = {}): AiTurnRequest {
  return {
    model: "openai:test-model",
    system: [{ text: "SYS" }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: TOOLS,
    ...overrides,
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AI_API_KEY = "sk-test";
  process.env.AI_BASE_URL = "https://llm.example/v1";
  invalidateCredentialCache();
  openAiCompatTesting.reset();
  openAiCompatTesting.setSleep(async () => {});
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  invalidateCredentialCache();
  vi.unstubAllGlobals();
});

describe("OpenAI-compatible adapter", () => {
  it("sends native tools and parses tool calls", async () => {
    const calls = stubFetch([
      ok({
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path": "a.py",}' } }],
      }),
    ]);
    const res = await openaiCompatProvider.runTurn(request());
    expect(calls[0].url).toBe("https://llm.example/v1/chat/completions");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
    expect(calls[0].body.model).toBe("test-model");
    expect((calls[0].body.tools as unknown[]).length).toBe(1);
    expect(res.toolCalls).toEqual([{ id: "c1", name: "read_file", input: { path: "a.py" } }]);
    expect(res.stopReason).toBe("tool_use");
  });

  it("passes every DeepSeek reasoning turn back as reasoning_content", async () => {
    process.env.AI_PROVIDER = "deepseek";
    process.env.AI_BASE_URL = "https://api.deepseek.com/v1";
    const calls = stubFetch([ok({ content: "done" })]);
    await openaiCompatProvider.runTurn(request({
      model: "openai:deepseek-v4-pro",
      messages: [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "first thought", signature: "" },
          { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.py" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "a" }] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "second thought", signature: "" },
          { type: "tool_use", id: "c2", name: "read_file", input: { path: "b.py" } },
        ] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c2", content: "b" }] },
        { role: "assistant", content: [{ type: "text", text: "I found the bug." }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    }));
    const assistant = (calls[0].body.messages as Record<string, unknown>[]).filter((m) => m.role === "assistant");
    expect(assistant.map((m) => m.reasoning_content)).toEqual(["first thought", "second thought", ""]);
    expect(assistant.every((m) => !("reasoning" in m))).toBe(true);
  });

  it("falls back to the text protocol when the endpoint rejects tools, and stays there", async () => {
    const calls = stubFetch([
      status(400, "this model does not support tools"),
      ok({ content: 'Reading.\n<tool name="read_file">\n<path>a.py</path>\n</tool>\n<result>made up</result>' }),
      ok({ content: "All done." }),
    ]);
    const res = await openaiCompatProvider.runTurn(request());
    expect(calls[1].body.tools).toBeUndefined();
    expect(JSON.stringify(calls[1].body.messages)).toContain("# How to call tools");
    expect(calls[1].body.stop).toEqual(expect.arrayContaining(["<tool_result"]));
    expect(res.toolCalls).toMatchObject([{ name: "read_file", input: { path: "a.py" } }]);
    expect(res.text).toBe("Reading.");
    expect(JSON.stringify(res.content)).not.toContain("made up");

    await openaiCompatProvider.runTurn(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: res.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: res.toolCalls[0].id, content: "x = 1" }] },
        ],
      }),
    );
    expect(calls[2].body.tools).toBeUndefined();
    expect(JSON.stringify(calls[2].body.messages)).toContain("<tool_result name=\\\"read_file\\\">");
  });

  it("recovers a tool call written as text in native mode", async () => {
    stubFetch([ok({ content: 'Let me look.\n<tool_call>{"name": "read_file", "arguments": {"path": "b.py"}}</tool_call>' })]);
    const res = await openaiCompatProvider.runTurn(request());
    expect(res.toolCalls).toMatchObject([{ name: "read_file", input: { path: "b.py" } }]);
    expect(res.text).toBe("Let me look.");
  });

  it("drops a parameter the endpoint rejects, and remembers it", async () => {
    const calls = stubFetch([
      status(400, "Unsupported value: 'temperature' does not support 0 with this model."),
      ok({ content: "hi" }),
      ok({ content: "again" }),
    ]);
    await openaiCompatProvider.runTurn(request());
    await openaiCompatProvider.runTurn(request());
    expect(calls[0].body.temperature).toBe(0);
    expect(calls[1].body.temperature).toBeUndefined();
    expect(calls[2].body.temperature).toBeUndefined();
  });

  it("perturbs the request after garbage and 5xx responses", async () => {
    const big = "x".repeat(2000);
    const calls = stubFetch([
      new Response("<html>502 Bad Gateway</html>", { status: 200 }),
      status(500, "internal error"),
      ok({ content: "recovered" }),
    ]);
    const res = await openaiCompatProvider.runTurn(
      request({
        messages: [
          { role: "user", content: [{ type: "text", text: "go" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
        ],
      }),
    );
    expect(res.text).toBe("recovered");
    const toolMsg = (b: Record<string, unknown>) =>
      (b.messages as { role: string; content: string }[]).find((m) => m.role === "tool")!.content;
    expect(toolMsg(calls[0].body).length).toBe(2000);
    expect(toolMsg(calls[1].body)).toMatch(/output shortened after a provider error/);
    expect(JSON.stringify(calls[2].body.messages)).toContain("Continue with the task.");
  });

  it("surfaces 429 to the shared retry layer, which backs off and succeeds", async () => {
    stubFetch([status(429, "rate limited"), ok({ content: "fine" })]);
    const retries: number[] = [];
    const res = await runTurnWithRetry(
      openaiCompatProvider,
      request(),
      { onRetry: (i) => retries.push(i.attempt) },
      { sleep: async () => {} },
    );
    expect(res.text).toBe("fine");
    expect(retries).toEqual([1]);
  });

  it("classifies context overflow as too large and auth failures as fatal", async () => {
    stubFetch([status(400, "This model's maximum context length is 2048 tokens.")]);
    const overflow = await openaiCompatProvider.runTurn(request()).catch((e) => e);
    expect(classifyProviderError(overflow).kind).toBe("too_large");
    stubFetch([status(401, "invalid key")]);
    const auth = await openaiCompatProvider.runTurn(request()).catch((e) => e);
    expect(classifyProviderError(auth).kind).toBe("fatal");
  });

  it("never retries a model that is unavailable to the key, even on a 429", async () => {
    const { ModelUnavailableError } = await import("@/lib/ai/nvidia-catalog");
    const quota = new ModelUnavailableError("gemini:x", 429, "Quota exceeded per day", "Gemini");
    expect(classifyProviderError(quota).kind).toBe("fatal");
  });

  it("uses Azure deployments, api-version and the api-key header", async () => {
    process.env.AI_BASE_URL = "https://acme.openai.azure.com";
    process.env.AI_API_KEY = "azkey123";
    invalidateCredentialCache();
    const calls = stubFetch([ok({ content: "hi" })]);
    await openaiCompatProvider.runTurn(request({ model: "openai:gpt-4o" }));
    expect(calls[0].url).toBe("https://acme.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21");
    expect(calls[0].headers["api-key"]).toBe("azkey123");
    expect(calls[0].headers.Authorization).toBeUndefined();
  });
});

describe("provider detection", () => {
  it("detects providers from key prefixes", () => {
    expect(detectProvider("sk-ant-abc")).toBe("anthropic");
    expect(detectProvider("sk-or-v1-abc")).toBe("openrouter");
    expect(detectProvider("AIzaXYZ")).toBe("gemini");
    expect(detectProvider("gsk_abc")).toBe("groq");
    expect(detectProvider("sk-proj-abc")).toBe("openai");
    expect(detectProvider("weird")).toBeNull();
  });

  it("routes AI_API_KEY to the right adapter", async () => {
    delete process.env.AI_BASE_URL;
    process.env.AI_API_KEY = "sk-ant-xyz";
    invalidateCredentialCache();
    expect(await getApiKey("anthropic")).toBe("sk-ant-xyz");
    expect(await getApiKey("openai")).toBeNull();

    process.env.AI_API_KEY = "sk-or-v1-xyz";
    invalidateCredentialCache();
    expect(await getApiKey("openai")).toBe("sk-or-v1-xyz");
    expect(resolveOpenAiCompatEnv()).toMatchObject({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" });
  });

  it("routes a generic sk key to DeepSeek when AI_MODEL names DeepSeek", () => {
    delete process.env.AI_BASE_URL;
    process.env.AI_API_KEY = `sk-${"a".repeat(32)}`;
    process.env.AI_MODEL = "deepseek-v4-pro";
    expect(resolveOpenAiCompatEnv()).toMatchObject({
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-pro",
    });
  });

  it("registers the AI_MODEL model and prefers it for auto", async () => {
    process.env.AI_MODEL = "acme-coder-1";
    invalidateCredentialCache();
    expect(getModel("acme-coder-1")).toMatchObject({ provider: "openai", agentic: true });
    expect(await resolveModel("auto", { agenticOnly: true })).toBe("acme-coder-1");
  });
});

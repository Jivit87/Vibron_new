/**
 * Block-structured messages → OpenAI chat-completions messages. Shared by the
 * Groq SDK adapter and the fetch-based OpenAI-compatible adapter.
 *
 * - System blocks collapse into one `system` message (cache flags dropped).
 * - An assistant turn with text and tool_use blocks becomes one assistant
 *   message with `tool_calls`; each tool_result becomes its own `role:"tool"`
 *   message, which is what the wire format requires.
 */

import type { AiContent, AiTurnRequest } from "@/lib/ai/types";

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    /** Provider extension echoed back verbatim (Gemini thought signatures). */
    extra_content?: Record<string, unknown>;
  }[];
  tool_call_id?: string;
  name?: string;
  /** Passed-back reasoning for gpt-oss and other compatible endpoints. */
  reasoning?: string;
  /** DeepSeek thinking mode requires this field on prior assistant turns. */
  reasoning_content?: string;
}

/** Google's documented value for a function call that has no signature of its own. */
const SKIP_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };

export function toOpenAiMessages(
  request: Pick<AiTurnRequest, "system" | "messages">,
  options: {
    toolNames?: boolean;
    reasoningWindow?: number;
    reasoningField?: "reasoning" | "reasoning_content";
    /**
     * Gemini: every function call must carry the `thought_signature` the
     * model returned with it. Calls without one (made by another model before
     * a fallback, or recovered from text) get Google's documented bypass
     * value, since omitting it is a hard 400 on Gemini 3.
     */
    thoughtSignatures?: boolean;
  } = {},
): OpenAiMessage[] {
  const assistantIndexes = request.messages
    .map((m, i) => (m.role === "assistant" ? i : -1))
    .filter((i) => i >= 0);
  const keepReasoning = new Set(
    options.reasoningWindow ? assistantIndexes.slice(-options.reasoningWindow) : [],
  );
  const system = request.system
    .map((b) => b.text)
    .filter(Boolean)
    .join("\n\n");

  const out: OpenAiMessage[] = [];
  if (system) out.push({ role: "system", content: system });
  const names = new Map<string, string>();

  for (const [index, message] of request.messages.entries()) {
    if (message.role === "assistant") {
      const reasoning = keepReasoning.has(index)
        ? message.content
            .map((b) => (b.type === "thinking" ? b.thinking : ""))
            .join("")
        : "";
      const text = message.content
        .filter((b): b is Extract<AiContent, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = message.content
        .filter(
          (b): b is Extract<AiContent, { type: "tool_use" }> => b.type === "tool_use",
        )
        .map((b) => {
          names.set(b.id, b.name);
          const extraContent = options.thoughtSignatures
            ? ((b.extra?.extra_content as Record<string, unknown> | undefined) ?? SKIP_SIGNATURE)
            : undefined;
          return {
            id: b.id,
            type: "function" as const,
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            ...(extraContent ? { extra_content: extraContent } : {}),
          };
        });
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        ...(options.reasoningField === "reasoning_content"
          ? { reasoning_content: reasoning }
          : reasoning ? { reasoning } : {}),
      });
      continue;
    }

    // User turns can carry tool results, plain text, or both.
    const results = message.content.filter(
      (b): b is Extract<AiContent, { type: "tool_result" }> => b.type === "tool_result",
    );
    for (const result of results) {
      const name = names.get(result.tool_use_id);
      out.push({
        role: "tool",
        tool_call_id: result.tool_use_id,
        content: result.content || "(no output)",
        // Gemini/Groq-style endpoints map results by function name.
        ...(options.toolNames && name ? { name } : {}),
      });
    }
    const text = message.content
      .filter((b): b is Extract<AiContent, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) out.push({ role: "user", content: text });
  }

  return out;
}

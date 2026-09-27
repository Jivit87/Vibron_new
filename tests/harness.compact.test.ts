import { afterEach, describe, expect, it } from "vitest";

import type { AiMessage } from "@/lib/ai/types";
import { elideOldToolResults, pruneTranscript, summarizeHistory, summaryModel, withoutStaleThinking } from "@/lib/harness/compact";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";

afterEach(() => uninstallFakeProvider());

/** task, then `turns` × (assistant tool_use, user tool_result). */
function transcript(turns: number): AiMessage[] {
  const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: "the task" }] }];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "grep", input: { i } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: `result ${i} `.repeat(100) }] });
  }
  return messages;
}

function pairsIntact(messages: AiMessage[]): boolean {
  const uses = messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id));
  const results = messages.flatMap((m) =>
    m.content.filter((b) => b.type === "tool_result").map((b) => (b as { tool_use_id: string }).tool_use_id),
  );
  return uses.length === results.length && uses.every((id) => results.includes(id));
}

describe("elideOldToolResults", () => {
  it("elides only results older than the last six turns and keeps pairing valid", () => {
    const { messages, removed } = elideOldToolResults(transcript(9));
    expect(removed).toBeGreaterThan(0);
    const results = messages.filter((m) => m.content[0].type === "tool_result");
    const elided = results.map((m) => (m.content[0] as { content: string }).content.startsWith("[elided:"));
    expect(elided).toEqual([true, true, true, false, false, false, false, false, false]);
    expect(pairsIntact(messages)).toBe(true);
    // Idempotent: a second pass finds nothing new.
    expect(elideOldToolResults(messages).removed).toBe(0);
  });

  it("does nothing on a short transcript", () => {
    expect(elideOldToolResults(transcript(3)).removed).toBe(0);
  });
});

describe("summarizeHistory", () => {
  it("summarizes the middle with the fast model and keeps roles alternating", async () => {
    const fake = installFakeProvider([{ text: "Learned X; edited Y." }]);
    const result = await summarizeHistory(transcript(9), { model: "claude-opus-5" });
    expect(fake.requests[0].model).toBe(summaryModel("claude-opus-5"));
    expect(summaryModel("claude-opus-5")).toBe("claude-haiku-4-5");
    const messages = result!.messages;
    expect(messages[0].role).toBe("user");
    expect(JSON.stringify(messages[0].content)).toContain("Learned X; edited Y.");
    expect(JSON.stringify(messages[0].content)).toContain("the task");
    expect(messages[1].role).toBe("assistant");
    for (let i = 1; i < messages.length; i += 1) {
      expect(messages[i].role).not.toBe(messages[i - 1].role);
    }
    expect(pairsIntact(messages)).toBe(true);
    expect(messages).toHaveLength(1 + 6 * 2);
  });
});

describe("preserved thinking", () => {
  const hasThinking = (m: AiMessage) => m.content.some((b) => b.type === "thinking" || b.type === "redacted_thinking");

  it("drops thinking at or before the last pruned message but keeps the latest assistant turn's", () => {
    const payload = "x".repeat(5_000);
    const messages: AiMessage[] = [{ role: "user", content: [{ type: "text", text: "the task" }] }];
    for (let i = 0; i < 4; i += 1) {
      messages.push({
        role: "assistant",
        content: [
          { type: "thinking", thinking: `plan ${i}`, signature: `sig${i}` },
          { type: "tool_use", id: `w${i}`, name: "write_file", input: { path: `f${i}.ts`, content: payload } },
        ],
      });
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `w${i}`, content: "ok" }] });
    }
    const pruned = pruneTranscript(messages);
    // Turns 0 and 1 (indices 1 and 3) are older than the last two: their payloads become stubs.
    expect(pruned.stubbed).toBe(2);
    const lastEdited = pruned.messages.map((m, i) => m !== messages[i]).lastIndexOf(true);
    expect(lastEdited).toBe(3);
    pruned.messages.forEach((m, i) => {
      if (m.role === "assistant" && i <= lastEdited) expect(hasThinking(m)).toBe(false);
    });
    expect(hasThinking(pruned.messages[5])).toBe(true);
    expect(hasThinking(pruned.messages[7])).toBe(true);
    expect(pairsIntact(pruned.messages)).toBe(true);
  });

  it("keeps the latest assistant turn's thinking even inside the edited region", () => {
    const edited: AiMessage[] = [
      { role: "user", content: [{ type: "text", text: "rewritten task" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "a" }] },
    ];
    const before: AiMessage[] = [{ role: "user", content: [{ type: "text", text: "the task" }] }, edited[1]];
    expect(withoutStaleThinking(before, edited)[1]).toBe(edited[1]);
  });

  it("leaves thinking alone when nothing was edited", () => {
    const messages: AiMessage[] = [
      { role: "user", content: [{ type: "text", text: "the task" }] },
      { role: "assistant", content: [{ type: "redacted_thinking", data: "opaque" }, { type: "text", text: "hi" }] },
      { role: "user", content: [{ type: "text", text: "more" }] },
    ];
    expect(pruneTranscript(messages).messages).toEqual(messages);
    expect(hasThinking(elideOldToolResults(messages).messages[1])).toBe(true);
  });
});

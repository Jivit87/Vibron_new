/**
 * Transcript compaction.
 *
 * A long tool loop grows its transcript every turn, mostly with tool output
 * the model read once and no longer needs verbatim. Past 60% of the model's
 * context window the runner compacts, cheapest stage first:
 *
 *  1. **Elide.** Tool results older than the last few turns are replaced by
 *     a one-line marker. The model can re-run a tool if it needs the detail
 *     again; the tool_use/tool_result pairing stays intact, so the wire
 *     format stays valid.
 *  2. **Summarize.** If eliding was not enough, everything between the task
 *     and the recent turns is summarized by the fastest model on the same
 *     provider and replaced with that summary.
 *
 * Before either, and also on its own once the transcript passes
 * PRUNE_TRIGGER_TOKENS, a **prune** pass drops what is dead weight rather
 * than old: the payloads of files the agent already wrote (they are on disk)
 * and views of files edited since (their line numbers are wrong). Pruning
 * rewrites the cached prefix, so on its own it only runs when it frees
 * enough to pay for that.
 *
 * Cache rule: the prefix sent to the provider (system blocks, tools, every
 * earlier message) changes ONLY at these boundaries: a compaction past the
 * threshold, or a prune that frees at least PRUNE_MIN_SAVINGS once the
 * transcript passes PRUNE_TRIGGER_TOKENS. Between them the transcript only
 * grows; harness notes are appended to the newest tool result, and the
 * runner freezes its system blocks for the run. `tests/harness.cache.test.ts`
 * holds this. An edit also drops the thinking blocks in front of it
 * (`withoutStaleThinking`), which models with preserved thinking require.
 *
 * Never elided: the latest `finish` result (the gate's verdict and
 * feedback), the latest harness checkpoint, and `finish` inputs.
 */

import { createHash } from "node:crypto";

import { runTurn } from "@/lib/ai";
import { MODELS, getModel } from "@/lib/ai/models";
import type { AiMessage, AiUsage } from "@/lib/ai/types";

/** Compact once the estimate crosses this share of the context window. */
export const COMPACT_THRESHOLD = 0.6;
/** Assistant turns whose tool results are always kept verbatim. */
export const KEEP_RECENT_TURNS = 6;

const ELIDED_PREFIX = "[elided:";
const STUB_PREFIX = "[wrote ";

/** Assistant turns whose write payloads and views pruning always keeps. */
export const PRUNE_KEEP_TURNS = 2;
/** Prune on its own once the transcript estimate passes this. */
export const PRUNE_TRIGGER_TOKENS = 24_000;
/** A prune outside compaction must free this much to be worth a cache rewrite. */
export const PRUNE_MIN_SAVINGS = 4_000;
/** Payload strings shorter than this stay verbatim; a stub would save little. */
const STUB_MIN_CHARS = 1_200;

const PAYLOAD_TOOLS = new Set(["write_file", "create_file", "append_file", "edit_file", "multi_edit"]);
const PAYLOAD_FIELDS = ["content", "replace", "new_str"];
const MUTATING = new Set([...PAYLOAD_TOOLS, "delete_file", "rename_file"]);
const VIEW_TOOLS = new Set(["read_file", "view"]);

/** Cheap token estimate; the provider's reported usage corrects it each turn. */
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 4);
}

/** An image is billed by pixels, not base64 length; this is a typical size. */
const IMAGE_TOKENS = 1_600;

export function messageTokens(messages: AiMessage[]): number {
  return messages.reduce(
    (sum, m) =>
      sum +
      m.content.reduce(
        (inner, block) =>
          inner + (block.type === "image" ? IMAGE_TOKENS : estimateTokens(block)),
        0,
      ),
    0,
  );
}

/** Index of the assistant message that starts the last `keep` turns. */
function recentBoundary(messages: AiMessage[], keep: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "assistant") {
      seen += 1;
      if (seen === keep) return i;
    }
  }
  return 0;
}

type ToolCallInfo = { name: string; input: Record<string, unknown> };

/** tool_use id → its call, across the transcript. */
function callsById(messages: AiMessage[]): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "tool_use") calls.set(block.id, { name: block.name, input: block.input });
    }
  }
  return calls;
}

/** Results that survive every compaction: the gate's latest word. */
function protectedResults(messages: AiMessage[]): Set<string> {
  const calls = callsById(messages);
  let finish: string | undefined;
  let checkpoint: string | undefined;
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (calls.get(block.tool_use_id)?.name === "finish") finish = block.tool_use_id;
      if (block.content.includes("HARNESS CHECKPOINT")) checkpoint = block.tool_use_id;
    }
  }
  return new Set([finish, checkpoint].filter((id): id is string => Boolean(id)));
}

const THINKING = new Set(["thinking", "redacted_thinking"]);

/**
 * Preserved thinking: models that validate replayed reasoning (Claude Opus
 * 5.5, Fable 5.1) reject a request whose thinking blocks sit in front of an
 * edited history. So once any earlier message is rewritten, thinking blocks
 * are dropped from every assistant message at or before the last edited
 * one, except the latest assistant turn, whose tool_use is still being
 * answered. Returns `next` unchanged when nothing was edited.
 */
export function withoutStaleThinking(before: AiMessage[], next: AiMessage[]): AiMessage[] {
  let lastEdited = -1;
  next.forEach((m, i) => {
    if (m !== before[i]) lastEdited = i;
  });
  if (lastEdited < 0) return next;
  const latestAssistant = next.findLastIndex((m) => m.role === "assistant");
  return next.map((message, index) => {
    if (index > lastEdited || index === latestAssistant || message.role !== "assistant") return message;
    const content = message.content.filter((block) => !THINKING.has(block.type));
    if (content.length === message.content.length) return message;
    return { ...message, content: content.length ? content : [{ type: "text", text: "(reasoning omitted)" }] };
  });
}

/**
 * Stage 1. Returns a new transcript with old tool results replaced, and
 * how many tokens that removed (0 when there was nothing to elide).
 */
export function elideOldToolResults(
  messages: AiMessage[],
  keepTurns = KEEP_RECENT_TURNS,
): { messages: AiMessage[]; removed: number } {
  const boundary = recentBoundary(messages, keepTurns);
  const keep = protectedResults(messages);
  let removed = 0;
  const next = messages.map((message, index) => {
    if (index >= boundary || message.role !== "user") return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (
        block.type !== "tool_result" ||
        block.content.startsWith(ELIDED_PREFIX) ||
        keep.has(block.tool_use_id)
      ) {
        return block;
      }
      const tokens = estimateTokens(block.content);
      if (tokens < 50) return block;
      changed = true;
      removed += tokens;
      return {
        ...block,
        content: `${ELIDED_PREFIX} ~${tokens} tokens of earlier tool output. Re-run the tool if you need it again.]`,
      };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: withoutStaleThinking(messages, next), removed };
}

function stubFor(name: string, path: string, text: string): string {
  const verb = name === "append_file" ? " (appended part)" : name === "edit_file" || name === "multi_edit" ? " (edit)" : "";
  const lines = text.replace(/\n$/, "").split("\n").length;
  const sha = createHash("sha1").update(text).digest("hex").slice(0, 10);
  return `${STUB_PREFIX}${path}${verb}: ${lines} lines, sha ${sha}; view it with read_file if needed]`;
}

/** Replace one large payload string with its stub; returns the tokens saved. */
function stubField(holder: Record<string, unknown>, field: string, name: string, path: string): number {
  const value = holder[field];
  if (typeof value !== "string" || value.length < STUB_MIN_CHARS || value.startsWith(STUB_PREFIX)) return 0;
  const stub = stubFor(name, path, value);
  holder[field] = stub;
  return estimateTokens(value) - estimateTokens(stub);
}

const pathOf = (input: Record<string, unknown>) => String(input.path ?? input.to ?? "").replace(/^\.\//, "");

/**
 * Drop dead weight older than the last `keepTurns` assistant turns:
 *  - large write/edit payloads become `[wrote <path>: N lines, sha …]` stubs
 *    (the content is on disk; the model re-reads it if it needs to);
 *  - views of a file mutated after the view become a one-line marker
 *    (their line numbers no longer match the file).
 * Returns a new transcript; the input is not mutated.
 */
export function pruneTranscript(
  messages: AiMessage[],
  keepTurns = PRUNE_KEEP_TURNS,
): { messages: AiMessage[]; removed: number; stubbed: number; staleViews: number } {
  const boundary = recentBoundary(messages, keepTurns);
  const calls = callsById(messages);
  const keep = protectedResults(messages);

  // Transcript position of each path's last mutation, and of each view call.
  const lastMutation = new Map<string, number>();
  const viewAt = new Map<string, number>();
  messages.forEach((message, m) =>
    message.content.forEach((block, b) => {
      if (block.type !== "tool_use") return;
      const at = m * 10_000 + b;
      if (MUTATING.has(block.name)) {
        lastMutation.set(pathOf(block.input), at);
        if (typeof block.input.from === "string") lastMutation.set(pathOf({ path: block.input.from }), at);
      } else if (VIEW_TOOLS.has(block.name)) viewAt.set(block.id, at);
    }),
  );

  let removed = 0;
  let stubbed = 0;
  let staleViews = 0;
  const next = messages.map((message, index): AiMessage => {
    if (index >= boundary) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (message.role === "assistant" && block.type === "tool_use" && PAYLOAD_TOOLS.has(block.name)) {
        const input = structuredClone(block.input);
        const path = pathOf(input);
        let saved = 0;
        for (const field of PAYLOAD_FIELDS) saved += stubField(input, field, block.name, path);
        if (Array.isArray(input.edits)) {
          for (const edit of input.edits) {
            if (edit && typeof edit === "object") saved += stubField(edit as Record<string, unknown>, "new_str", block.name, path);
          }
        }
        if (saved <= 0) return block;
        changed = true;
        stubbed += 1;
        removed += saved;
        return { ...block, input };
      }
      if (message.role === "user" && block.type === "tool_result" && !keep.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id);
        const at = viewAt.get(block.tool_use_id);
        if (!call || at === undefined || block.content.startsWith(ELIDED_PREFIX)) return block;
        const path = pathOf(call.input);
        if ((lastMutation.get(path) ?? -1) < at) return block;
        const marker = `${ELIDED_PREFIX} stale view of ${path}; the file changed after this view, so its line numbers are out of date. View it again if needed.]`;
        const saved = estimateTokens(block.content) - estimateTokens(marker);
        if (saved < 50) return block;
        changed = true;
        staleViews += 1;
        removed += saved;
        return { ...block, content: marker };
      }
      return block;
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: withoutStaleThinking(messages, next), removed, stubbed, staleViews };
}

/** The fastest model on the same provider, for summarizing. */
export function summaryModel(model: string): string {
  const spec = getModel(model);
  if (!spec) return model;
  return (
    MODELS.find((m) => m.provider === spec.provider && m.tier === "fast")?.id ?? model
  );
}

function renderForSummary(messages: AiMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === "text") lines.push(`${message.role}: ${block.text}`);
      else if (block.type === "tool_use") {
        lines.push(`tool call ${block.name}(${JSON.stringify(block.input).slice(0, 400)})`);
      } else if (block.type === "tool_result") {
        lines.push(`tool result: ${block.content.slice(0, 1500)}`);
      }
    }
  }
  return lines.join("\n").slice(0, 120_000);
}

/**
 * Stage 2. Replace the middle of the transcript with a model-written
 * summary. The first message (the task) and the last turns survive; the
 * kept tail starts at an assistant message, so roles still alternate and
 * every kept tool_use keeps its tool_result.
 */
export async function summarizeHistory(
  messages: AiMessage[],
  options: { model: string; signal?: AbortSignal; keepTurns?: number },
): Promise<{ messages: AiMessage[]; usage: AiUsage; cost: number; uncachedCost: number } | null> {
  const boundary = recentBoundary(messages, options.keepTurns ?? KEEP_RECENT_TURNS);
  if (boundary <= 1) return null;
  const middle = messages.slice(1, boundary);

  const turn = await runTurn({
    model: summaryModel(options.model),
    system: [
      {
        text: "You compress an AI coding agent's working history. Write a dense summary the agent can continue from: what it has learned about the code (files, symbols, line numbers), every file it changed and how, commands it ran and their outcomes, decisions made, and what remains. No preamble.",
      },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: renderForSummary(middle) }] },
    ],
    maxTokens: 2048,
    signal: options.signal,
  });

  const summary = turn.text.trim();
  if (!summary) return null;

  // The gate's latest verdict is never summarized away: carry it verbatim.
  const keep = protectedResults(messages);
  const verdicts = middle
    .flatMap((m) => m.content)
    .map((b) => (b.type === "tool_result" && keep.has(b.tool_use_id) ? `\n\n## Latest harness verdict (verbatim)\n\n${b.content}` : ""))
    .join("");

  const task = messages[0];
  const head: AiMessage = {
    role: "user",
    content: [
      ...task.content,
      {
        type: "text",
        text: `## Summary of your earlier work on this task\n\n${summary}${verdicts}`,
      },
    ],
  };
  return {
    messages: [head, ...messages.slice(boundary)],
    usage: turn.usage,
    cost: turn.cost,
    uncachedCost: turn.uncachedCost,
  };
}

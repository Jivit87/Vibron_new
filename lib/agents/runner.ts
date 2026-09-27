/**
 * The single-agent tool loop.
 *
 * One specialist, one task, run until it stops calling tools or hits its
 * iteration ceiling. Shared by both execution modes: "single" runs exactly
 * one of these, "orchestrated" runs many in waves.
 *
 * The loop is deliberately forgiving about model mistakes. A malformed tool
 * call, an unknown tool name, a bad path — all come back as tool *results*
 * describing the problem, so the model corrects itself on the next turn
 * instead of the run collapsing.
 */

import { classifyProviderError, runTurn, type EnrichedTurnResult } from "@/lib/ai";
import { getModel, maxOutputCap, outputCap } from "@/lib/ai/models";
import {
  addUsage,
  EMPTY_USAGE,
  TRUNCATED_CALL_ERROR,
  type AiMessage,
  type AiSystemBlock,
  type AiToolCall,
  type AiUsage,
} from "@/lib/ai/types";
import { buildSkeleton, type EngineInput } from "@/lib/context/engine";
import { renderMemoryPrompt } from "@/lib/memory";
import type { ProjectMemory } from "@/lib/memory/types";
import {
  COMPACT_THRESHOLD,
  elideOldToolResults,
  estimateTokens,
  messageTokens,
  PRUNE_MIN_SAVINGS,
  PRUNE_TRIGGER_TOKENS,
  pruneTranscript,
  summarizeHistory,
} from "@/lib/harness/compact";
import type { ApprovalAsk } from "@/lib/harness/runs";
import type { ImageAttachment } from "@/lib/composer/types";
import {
  ESSENTIAL_TOOLS,
  canonicalizeCall,
  isToolFailure,
  knownTools,
  runTool,
  SOLVER_TOOLS,
  toolDefs,
  type ToolContext,
} from "@/lib/tools/registry";
import type { EditSession } from "@/lib/tools/editor";
import { getFileInfo, getGraph } from "@/lib/store";
import type { WorkspaceHandle } from "@/lib/workspace";
import { compactSystemPrompt, getRole, type RoleId } from "@/lib/agents/roles";
import { countLineDiff, type EventSink } from "@/lib/agents/events";
import { EMPTY_TOOLSET, loadMcpToolset } from "@/lib/mcp/tools";

export type ApprovalRequester = (
  agentId: string,
  ask: ApprovalAsk,
) => Promise<boolean>;

/**
 * The harness's seam into the loop. The model proposes; the controller
 * decides. Everything is optional, so interactive runs pass nothing.
 */
export interface RunController {
  /** Before a mutating tool runs. A returned string refuses it (becomes the tool result). */
  beforeMutation?(call: { name: string; input: Record<string, unknown> }): Promise<string | null | void>;
  /** After each tool result. Returned text is appended to the result (keeps the cached prefix intact). */
  onToolResult?(info: {
    name: string;
    input: Record<string, unknown>;
    output: string;
    failed: boolean;
    iteration: number;
  }): Promise<string | null | void>;
  /** After a turn's tool batch. Returned text is appended to the batch's last tool result. */
  onTurnEnd?(info: { iteration: number; filesChanged: string[] }): Promise<string | null | void>;
  /**
   * The model stopped calling tools. Return feedback to send it back to
   * work (e.g. the gate rejected, or a "call a tool" nudge), or null to let
   * the attempt end.
   */
  onFinishAttempt?(info: { text: string; iteration: number }): Promise<{ feedback: string } | null>;
  /** Checked before every model call; a string ends the attempt with that reason. */
  budgetExceeded?(info: { iteration: number; usage: AiUsage }): string | null | false | undefined;
  /** True once the controller has accepted the work (e.g. the gate ruled on a finish). */
  isDone?(): boolean;
}

export interface AgentRunMetrics {
  modelCalls: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  compactions: number;
  iterations: number;
  /** Transcript tokens removed by pruning and eliding (estimate). */
  tokensElided?: number;
  /** Turns cut off by the output cap that the loop recovered from. */
  truncationRecoveries?: number;
}

export interface AgentRunInput {
  agentId: string;
  stepId: string;
  role: RoleId;
  model: string;
  /** The concrete instruction for this agent. */
  task: string;
  /** Short label for the lane. Falls back to a preview of `task`. */
  title?: string;
  /** Extra situational context: sibling steps, prior results, user request. */
  briefing?: string;
  files: string[];
  handle: WorkspaceHandle;
  engine: EngineInput;
  memory: ProjectMemory;
  commandPolicy: "auto" | "ask" | "never";
  emit: EventSink;
  signal?: AbortSignal;
  wave?: number;
  /** Overrides the role's default iteration ceiling. */
  maxIterations?: number;
  /** Ask the user; bound to this run by the caller. */
  requestApproval?: ApprovalRequester;
  /** The run this agent belongs to; attributes its terminal sessions. */
  runId?: string;
  /** Rendered project rules, folded into the cached system prefix. */
  rules?: string;
  /** False hides the model's reasoning summary. */
  showThinking?: boolean;
  editPolicy?: "auto" | "ask";
  /** User defaults for graph_search depth and size. */
  retrieval?: { depth?: number; maxNodes?: number };
  /** Pasted images, sent ahead of the task text. */
  images?: ImageAttachment[];
  /**
   * Mirror this agent's prose into the chat bubble as it streams.
   *
   * Set for solo runs, where this agent's output *is* the reply. In a
   * multi-agent run it stays off — six lanes streaming into one bubble
   * would be unreadable, so there the orchestrator composes the summary.
   */
  streamAnswer?: boolean;
  /** Harness controller (gate, guards, budget). */
  controller?: RunController;
  /** Replaces the role's tool list. */
  tools?: string[];
  /** False skips the repository's MCP servers (headless runs never load `.mcp.json`). */
  mcp?: boolean;
  /** Editor state shared with the caller (created/touched files, undo). */
  editSession?: EditSession;
  /** Harness services for the `compare` and `finish` tools. */
  harness?: ToolContext["harness"];
  /** 1-based solveTask attempt, echoed on `agent_start`. */
  attempt?: number;
  /** Why this attempt started, echoed on `agent_start`. */
  attemptReason?: string;
}

export interface AgentRunResult {
  agentId: string;
  stepId: string;
  role: RoleId;
  summary: string;
  usage: AiUsage;
  cost: number;
  uncachedCost: number;
  filesTouched: string[];
  durationMs: number;
  error?: string;
  metrics?: AgentRunMetrics;
  /** Why the loop ended: "finished", "controller", "max_iterations", "budget", "cancelled", "error", "refusal". */
  stopReason?: string;
}

const MUTATING_TOOLS = new Set([
  "write_file",
  "create_file",
  "append_file",
  "edit_file",
  "multi_edit",
  "delete_file",
  "rename_file",
  "create_directory",
]);

/** Plain-text replies cut off by the output cap are continued at most this often. */
const MAX_TEXT_CONTINUATIONS = 3;

const CONTINUE_NOTE =
  "(System) Your reply was cut off at the output limit. Continue exactly where you stopped: do not repeat anything already written, and do not restart.";

/**
 * The note that replaces a tool call the output cap cut off. It steers the
 * model to write large content in parts with the tools it actually has,
 * instead of resending the same oversized call into the same wall.
 */
export function truncationHint(call: AiToolCall, cap: number, tools: string[]): string {
  const path = typeof call.partialInput?.path === "string" ? ` ${call.partialInput.path}` : "";
  const parts = tools.includes("append_file")
    ? "`write_file` with the first part (~300 lines), then `append_file` for each following part, in order"
    : tools.includes("create_file") && tools.includes("edit_file")
      ? "`create_file` with the first part (~300 lines), then extend it with `edit_file` (find = the file's last few lines, replace = those lines plus the next part)"
      : "several smaller calls";
  const edit = tools.includes("multi_edit") ? "`edit_file` / `multi_edit`" : "`edit_file`";
  return `(System) Your output was cut off at the ${cap}-token output limit in the middle of a tool call (${call.name}${path}). That call was dropped and NOT run. Do not resend it whole. Write large content in parts: ${parts}; or split it into several smaller files. For an existing file, change only what needs changing with ${edit}. Never resend content that is already written.`;
}


/** Render tool arguments as one readable line for the trace. */
function formatArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) continue;
    let rendered: string;
    if (typeof value === "string") {
      rendered = value.length > 60 ? `${value.slice(0, 57)}…` : value;
      rendered = rendered.replace(/\n/g, "⏎");
    } else if (Array.isArray(value)) {
      rendered = `[${value.length}]`;
    } else {
      rendered = String(value);
    }
    parts.push(`${key}: ${rendered}`);
  }
  return parts.join(", ");
}

function preview(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Providers return failures as raw JSON blobs. Translate the ones a user can
 * actually act on into a sentence that names the fix.
 */
export function friendlyProviderError(raw: string, model: string): string {
  const lower = raw.toLowerCase();

  if (lower.includes("rate_limit_exceeded") || lower.includes("too large")) {
    const limit = raw.match(/Limit (\d+)[^\d]+Requested (\d+)/i);
    const detail = limit
      ? ` The request needed ${limit[2]} tokens against a ${limit[1]} limit.`
      : "";
    return `\`${model}\` rejected the request as too large for your plan's rate limit.${detail} Pick a model with more headroom (Claude models have a 200k+ context), lower the retrieval depth in Settings, or upgrade your provider tier.`;
  }

  if (lower.includes("api_key") || lower.includes("401") || lower.includes("invalid x-api-key")) {
    return "The provider rejected the API key. Check it in Settings → Providers.";
  }

  if (lower.includes("credit") || lower.includes("billing") || lower.includes("quota")) {
    return "The provider reports insufficient credit or quota for this account.";
  }

  if (lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
    return "The provider is overloaded right now. Retry in a moment, or switch models.";
  }

  if (lower.includes("fetch failed") || lower.includes("enotfound") || lower.includes("network")) {
    return "Could not reach the provider. Check your network connection.";
  }

  return raw;
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunResult> {
  const role = getRole(input.role);
  const toolNames = input.tools ?? role.tools;
  const controller = input.controller;
  const startedAt = Date.now();
  const filesTouched = new Set<string>();
  let usage: AiUsage = EMPTY_USAGE;
  let cost = 0;
  let uncachedCost = 0;
  const metrics: AgentRunMetrics = {
    modelCalls: 0,
    toolCalls: 0,
    toolCallsByName: {},
    compactions: 0,
    iterations: 0,
    tokensElided: 0,
    truncationRecoveries: 0,
  };
  let stopReason = "finished";
  /** Files changed during the current turn's tool batch. */
  let batchChanges: string[] = [];

  input.emit({
    type: "agent_start",
    agentId: input.agentId,
    stepId: input.stepId,
    role: input.role,
    title: input.title ?? preview(input.task, 90),
    model: input.model,
    wave: input.wave ?? 0,
    ...(input.attempt ? { attempt: input.attempt } : {}),
    ...(input.attemptReason ? { reason: input.attemptReason } : {}),
  });

  // Dedupe is per agent: "already in context" must only point at content
  // this agent's own transcript contains. Accounting still rolls up.
  const engine: EngineInput = {
    ...input.engine,
    ledger: input.engine.ledger.fork(input.agentId),
  };

  const ctx: ToolContext = {
    handle: input.handle,
    engine,
    memory: input.memory,
    agent: role.label,
    // An empty file list means "no restriction" — used for single-agent mode
    // and for roles like reviewer that never write anyway.
    writeScope: input.files.length > 0 ? input.files : undefined,
    allowedTools: toolNames,
    commandPolicy: input.commandPolicy,
    editPolicy: input.editPolicy,
    signal: input.signal,
    runId: input.runId,
    retrieval: input.retrieval,
    editSession: input.editSession,
    harness: input.harness,
    recentTerms: [],
    events: {
      onFileChange: (change) => {
        filesTouched.add(change.path);
        batchChanges.push(change.path);
        const { adds, removes } = countLineDiff(change.before, change.after);
        input.emit({
          type: "file_change",
          agentId: input.agentId,
          kind: change.kind,
          path: change.path,
          previousPath: change.previousPath,
          before: change.before,
          after: change.after,
          summary: change.summary,
          adds,
          removes,
        });
      },
      onCommand: (info) => {
        input.emit({ type: "command", agentId: input.agentId, ...info });
      },
      onMemory: (info) => {
        input.emit({ type: "memory", ...info });
      },
      onTodos: (items) => {
        input.emit({ type: "todos", agentId: input.agentId, items });
      },
      requestApproval: input.requestApproval
        ? (ask) => input.requestApproval!(input.agentId, ask)
        : undefined,
    },
  };

  /*
   * System prompt layering, ordered most-stable-first so the prompt cache
   * breakpoint lands after content that does not change between turns:
   *
   *   [role prompt] [project rules] [project memory] [repo map]  ← cached
   *   [task briefing]                                            ← volatile
   */
  /**
   * `compact` trades prompt quality for size. It is entered automatically
   * when a provider rejects a request as too large — typically a small
   * context window or a tokens-per-minute cap on a free tier — so a modest
   * model degrades gracefully instead of failing the run outright.
   */
  let compact = false;

  function buildSystem(): AiSystemBlock[] {
    const blocks: AiSystemBlock[] = compact
      ? [
          { text: compactSystemPrompt(role) },
          { text: (input.rules ?? "").slice(0, 3000) },
          {
            text: renderMemoryPrompt(input.memory, {
              includeTasks: false,
              includeFileIndex: false,
            }).slice(0, 1500),
            cache: true,
          },
        ]
      : [
          { text: role.systemPrompt },
          { text: input.rules ?? "" },
          { text: renderMemoryPrompt(input.memory) },
          { text: buildSkeleton(engine), cache: true },
        ];
    if (input.briefing) {
      blocks.push({
        text: compact
          ? `## THIS RUN\n\n${input.briefing.slice(0, 900)}`
          : `## THIS RUN\n\n${input.briefing}`,
      });
    }
    return blocks.filter((b) => b.text.trim().length > 0);
  }

  // MCP servers connect lazily, on the first run that needs them. A server
  // that fails to connect only loses its own tools.
  const mcp =
    input.mcp === false
      ? EMPTY_TOOLSET
      : await loadMcpToolset(input.handle.repoKey, input.handle.rootPath ?? null, toolNames).catch(
          () => EMPTY_TOOLSET,
        );
  ctx.extraTools = mcp.tools;
  for (const failure of mcp.failures) {
    input.emit({
      type: "agent_tool",
      agentId: input.agentId,
      tool: "mcp_connect",
      args: failure.name,
      phase: "end",
      result: `MCP server unavailable: ${failure.error}`,
      ok: false,
    });
  }

  function buildTools() {
    // Compact mode is the too-large fallback; MCP tools are the first to go.
    return compact
      ? toolDefs(
          toolNames.filter((name) => ESSENTIAL_TOOLS.includes(name) || SOLVER_TOOLS.includes(name)),
          { compact: true },
        )
      : [...toolDefs(toolNames), ...mcp.defs];
  }

  let messages: AiMessage[] = [
    {
      role: "user",
      content: [
        ...(input.images ?? []).map((image) => ({
          type: "image" as const,
          mediaType: image.mediaType,
          data: image.data,
        })),
        { type: "text", text: input.task },
      ],
    },
  ];

  const maxIterations = input.maxIterations ?? role.maxIterations;
  const spec = getModel(input.model);
  const contextWindow = spec?.contextWindow ?? 128_000;
  /** The model's output ceiling: what a cut-off turn is retried with. */
  const maxCap = maxOutputCap(spec);
  /** Plain-text continuations of the current reply, and its text so far. */
  let continuations = 0;
  let stitched = "";

  function callModel(maxTokens: number | undefined): Promise<EnrichedTurnResult> {
    metrics.modelCalls += 1;
    return runTurn(
      {
        model: input.model,
        system: buildSystem(),
        messages,
        tools: buildTools(),
        effort: role.effort,
        showThinking: input.showThinking,
        ...(maxTokens ? { maxTokens } : {}),
        signal: input.signal,
      },
      {
        onText: (delta) => {
          input.emit({ type: "agent_text", agentId: input.agentId, text: delta });
          if (input.streamAnswer) {
            input.emit({ type: "answer", text: delta });
          }
        },
        onThinking: (delta) => {
          if (input.showThinking === false) return;
          input.emit({
            type: "agent_thinking",
            agentId: input.agentId,
            text: delta,
          });
        },
        onRetry: (info) =>
          input.emit({ type: "agent_retry", agentId: input.agentId, ...info }),
      },
    );
  }

  function account(turn: EnrichedTurnResult): void {
    usage = addUsage(usage, turn.usage);
    cost += turn.cost;
    uncachedCost += turn.uncachedCost;
    contextTokens =
      turn.usage.inputTokens +
      turn.usage.cacheReadTokens +
      turn.usage.cacheWriteTokens +
      turn.usage.outputTokens;
    input.emit({
      type: "turn_usage",
      agentId: input.agentId,
      model: input.model,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      cacheReadTokens: turn.usage.cacheReadTokens,
      cacheWriteTokens: turn.usage.cacheWriteTokens,
      costUsd: turn.cost,
      uncachedUsd: turn.uncachedCost,
      contextTokens,
      at: Date.now(),
    });
  }

  function truncationRecovery(detail: string): void {
    metrics.truncationRecoveries = (metrics.truncationRecoveries ?? 0) + 1;
    input.emit({ type: "recovery", agentId: input.agentId, failureClass: "truncated", action: "hint", detail });
  }
  /** Running estimate of the next request's size, corrected every turn. */
  let contextTokens = 0;
  let finalText = "";
  let error: string | undefined;

  /**
   * Keep the transcript under COMPACT_THRESHOLD of the window: elide old
   * tool output first, and summarize only if that was not enough.
   */
  async function compactIfNeeded(): Promise<void> {
    const limit = contextWindow * COMPACT_THRESHOLD;
    const over = contextTokens > limit;

    // Prune dead weight (written payloads, stale views). It rewrites the
    // cached prefix, so outside a real compaction it waits until it frees
    // enough to pay for the cache write.
    if (over || messageTokens(messages) > PRUNE_TRIGGER_TOKENS) {
      const pruned = pruneTranscript(messages);
      if (pruned.removed > 0 && (over || pruned.removed >= PRUNE_MIN_SAVINGS)) {
        const beforeTokens = contextTokens;
        messages = pruned.messages;
        contextTokens = Math.max(0, contextTokens - pruned.removed);
        metrics.compactions += 1;
        metrics.tokensElided = (metrics.tokensElided ?? 0) + pruned.removed;
        input.emit({
          type: "compaction",
          agentId: input.agentId,
          strategy: "elide",
          beforeTokens,
          afterTokens: contextTokens,
        });
      }
    }
    if (contextTokens <= limit) return;

    const beforeTokens = contextTokens;
    const elided = elideOldToolResults(messages);
    if (elided.removed > 0) {
      messages = elided.messages;
      contextTokens = Math.max(0, contextTokens - elided.removed);
      metrics.compactions += 1;
      metrics.tokensElided = (metrics.tokensElided ?? 0) + elided.removed;
      input.emit({
        type: "compaction",
        agentId: input.agentId,
        strategy: "elide",
        beforeTokens,
        afterTokens: contextTokens,
      });
    }
    if (contextTokens <= limit) return;

    const summarized = await summarizeHistory(messages, {
      model: input.model,
      signal: input.signal,
    });
    if (!summarized) return;
    usage = addUsage(usage, summarized.usage);
    cost += summarized.cost;
    uncachedCost += summarized.uncachedCost;
    const before = contextTokens;
    messages = summarized.messages;
    contextTokens =
      estimateTokens(buildSystem()) + estimateTokens(buildTools()) + messageTokens(messages);
    metrics.compactions += 1;
    input.emit({
      type: "compaction",
      agentId: input.agentId,
      strategy: "summarize",
      beforeTokens: before,
      afterTokens: contextTokens,
    });
  }

  try {
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (input.signal?.aborted) {
        error = "cancelled";
        break;
      }
      const overBudget = controller?.budgetExceeded?.({ iteration, usage });
      if (overBudget) {
        stopReason = "budget";
        break;
      }
      metrics.iterations = iteration + 1;

      await compactIfNeeded();

      /*
       * On the last permitted iteration we want a text summary rather than
       * more half-finished work. Withdrawing the tools outright looks like
       * the obvious way to force that, but it breaks mid-conversation: once
       * the transcript already contains tool calls, providers reject the
       * next turn with "tool choice is none, but model called a tool".
       *
       * So keep the tools on the wire and ask for the wrap-up in a message
       * instead. Any tool call the model still makes is ignored below.
       */
      const lastIteration = iteration === maxIterations - 1;
      if (lastIteration) {
        messages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "(System) You have reached the step limit for this task. Do not call any more tools. Reply now, in plain text, with what you completed and anything still outstanding.",
            },
          ],
        });
      }
      // Providers that meter reserved output against a rate limit need this
      // to come down too, not just the prompt.
      const requestedCap = compact ? 2048 : undefined;
      let turn: EnrichedTurnResult;
      try {
        turn = await callModel(requestedCap);
      } catch (turnError) {
        const message =
          turnError instanceof Error ? turnError.message : String(turnError);
        const kind = classifyProviderError(turnError, input.signal).kind;
        if (input.signal?.aborted || kind === "aborted") {
          error = "cancelled";
          break;
        }

        // Retries are exhausted by now, so a rate limit that is still
        // failing is treated like an oversized prompt: shrink and go again.
        const tooLarge =
          kind === "too_large" || /rate.?limit|429|413/i.test(message);

        // First overflow: shrink the prompt and retry the same iteration.
        // This is what lets a small or TPM-capped model still complete a
        // run instead of dying on the opening request.
        if (tooLarge && !compact) {
          compact = true;
          input.emit({
            type: "agent_tool",
            agentId: input.agentId,
            tool: "compact_context",
            args: "prompt exceeded the model's budget",
            phase: "end",
            result: "Retrying with a smaller prompt and a reduced tool set.",
            ok: true,
          });
          iteration -= 1; // Retry this turn, do not consume an iteration.
          continue;
        }

        // Already compact and still overflowing: salvage a summary from
        // whatever work has landed rather than losing the whole run.
        if (tooLarge && iteration > 0) {
          messages.push({
            role: "user",
            content: [
              {
                type: "text",
                text: "(System) The context limit was reached. Stop calling tools and summarize what you completed and what remains.",
              },
            ],
          });
          continue;
        }

        throw new Error(friendlyProviderError(message, input.model));
      }

      account(turn);

      if (turn.stopReason === "refusal") {
        error = "The model declined to continue with this request.";
        finalText = error;
        stopReason = "refusal";
        break;
      }

      /*
       * Output-cap recovery. A tool call cut off mid-arguments must never
       * run (its content is incomplete), and resending it unchanged hits the
       * same wall. So: (a) retry the same turn once at the model's ceiling —
       * the transcript is unchanged, so the prompt cache still holds; (b) if
       * that is still cut off, drop the partial call and tell the model to
       * write in parts. A plain-text reply that was cut off is (c) continued
       * instead, which reuses the output already paid for.
       */
      let truncationNote: string | null = null;
      let usedCap = outputCap(spec, requestedCap);
      const cutCall = (t: EnrichedTurnResult) =>
        t.stopReason === "max_tokens" ? t.toolCalls.find((c) => c.inputError === TRUNCATED_CALL_ERROR) : undefined;
      if (cutCall(turn) && usedCap < maxCap && !lastIteration) {
        truncationRecovery(`Output cut off at ${usedCap} tokens mid tool call; retrying the turn with ${maxCap}.`);
        try {
          const retried = await callModel(maxCap);
          account(retried);
          turn = retried;
          usedCap = maxCap;
        } catch (retryError) {
          // A ceiling the endpoint rejects is not fatal: fall through to the hint.
          if (input.signal?.aborted || classifyProviderError(retryError, input.signal).kind === "aborted") {
            error = "cancelled";
            break;
          }
        }
      }
      const cut = cutCall(turn);
      if (cut) {
        truncationNote = truncationHint(cut, usedCap, toolNames);
        truncationRecovery(`Output cut off at ${usedCap} tokens mid ${cut.name}; dropped the partial call and asked for the content in parts.`);
        turn = {
          ...turn,
          toolCalls: turn.toolCalls.filter((c) => c !== cut),
          content: turn.content.filter((b) => !(b.type === "tool_use" && b.id === cut.id)),
        };
      } else if (
        turn.stopReason === "max_tokens" &&
        turn.toolCalls.length === 0 &&
        continuations < MAX_TEXT_CONTINUATIONS &&
        !lastIteration
      ) {
        continuations += 1;
        stitched += turn.text;
        truncationRecovery(`Reply cut off at the output limit; continuing (${continuations}/${MAX_TEXT_CONTINUATIONS}).`);
        messages.push({ role: "assistant", content: turn.content.length ? turn.content : [{ type: "text", text: "(no reply)" }] });
        messages.push({ role: "user", content: [{ type: "text", text: CONTINUE_NOTE }] });
        iteration -= 1; // A continuation is the same step, not a new one.
        continue;
      }
      const text = stitched + turn.text;
      stitched = "";
      continuations = 0;

      if (text.trim()) finalText = text;

      if (turn.toolCalls.length === 0 && truncationNote) {
        // The only call was the cut-off one: answer with the hint and go again.
        messages.push({
          role: "assistant",
          content: turn.content.some((b) => b.type === "text" && b.text.trim())
            ? turn.content
            : [...turn.content, { type: "text", text: "(output cut off)" }],
        });
        messages.push({ role: "user", content: [{ type: "text", text: truncationNote }] });
        if (lastIteration) stopReason = "max_iterations";
        continue;
      }

      if (turn.toolCalls.length === 0) {
        // The model wants to stop. With a controller, that is a request the
        // harness rules on, not a decision the model makes.
        const verdict =
          controller?.onFinishAttempt && !lastIteration
            ? await controller.onFinishAttempt({ text, iteration })
            : null;
        if (!verdict) {
          stopReason = lastIteration ? "max_iterations" : "finished";
          break;
        }
        messages.push({
          role: "assistant",
          content: turn.content.length ? turn.content : [{ type: "text", text: "(no reply)" }],
        });
        messages.push({ role: "user", content: [{ type: "text", text: verdict.feedback }] });
        if (controller?.isDone?.()) {
          stopReason = "controller";
          break;
        }
        continue;
      }

      // Past the step limit the tools are still on the wire (removing them
      // mid-conversation is a provider error), so ignore anything it tried
      // to call and keep whatever text it produced.
      if (lastIteration) {
        stopReason = "max_iterations";
        break;
      }

      // Alias tool names and argument spellings are mapped onto the declared
      // schema before they enter the transcript: some providers reject a
      // history that names tools they were never offered.
      const known = knownTools(ctx.allowedTools, mcp.tools);
      const calls = turn.toolCalls.map((call) => {
        if (call.inputError) return call;
        const canon = canonicalizeCall(call.name, call.input, known);
        return canon ? { ...call, name: canon.name, input: canon.input } : call;
      });
      const byId = new Map(calls.map((c) => [c.id, c] as const));
      const content = turn.content.map((block) => {
        const canon = block.type === "tool_use" ? byId.get(block.id) : undefined;
        return canon && block.type === "tool_use" ? { ...block, name: canon.name, input: canon.input } : block;
      });
      messages.push({ role: "assistant", content });

      // Execute tool calls in order. Sequential rather than parallel: later
      // calls in a turn frequently depend on earlier ones (write then read),
      // and a readable trace matters more here than a few hundred ms.
      const results: Extract<AiMessage["content"][number], { type: "tool_result" }>[] = [];
      batchChanges = [];
      for (const call of calls) {
        const args = formatArgs(call.input);
        input.emit({
          type: "agent_tool",
          agentId: input.agentId,
          callId: call.id,
          tool: call.name,
          args,
          phase: "start",
        });
        metrics.toolCalls += 1;
        metrics.toolCallsByName[call.name] = (metrics.toolCallsByName[call.name] ?? 0) + 1;

        // Once the run is cancelled (or the work was accepted), answer the
        // remaining calls without running them: the transcript still needs
        // a result per tool_use.
        let output: string;
        if (input.signal?.aborted) output = "Cancelled: the run was stopped.";
        else if (controller?.isDone?.()) output = "Skipped: the task was already accepted.";
        else if (call.inputError) {
          output = `Error: ${call.inputError} Call ${call.name} again with valid arguments.`;
        } else {
          const refusal = MUTATING_TOOLS.has(call.name)
            ? await controller?.beforeMutation?.({ name: call.name, input: call.input })
            : null;
          output = refusal ? refusal : await runTool(call.name, call.input, ctx);
        }
        const failed = isToolFailure(output);
        const hint = await controller?.onToolResult?.({
          name: call.name,
          input: call.input,
          output,
          failed,
          iteration,
        });
        if (hint) output = `${output}\n\n${hint}`;

        input.emit({
          type: "agent_tool",
          agentId: input.agentId,
          callId: call.id,
          tool: call.name,
          args,
          phase: "end",
          result: preview(output),
          ok: !failed,
        });

        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: output,
          ...(failed ? { is_error: true } : {}),
        });
      }

      // Edits patched the stored graph; point the engine at the fresh copy
      // so graph_search and outlines do not describe the old code.
      if (batchChanges.length) {
        const [graph, fileInfo] = await Promise.all([
          getGraph(input.handle.repoKey).catch(() => null),
          getFileInfo(input.handle.repoKey).catch(() => null),
        ]);
        if (graph) engine.graph = graph;
        if (fileInfo) engine.fileInfo = fileInfo;
      }
      const turnNote = await controller?.onTurnEnd?.({ iteration, filesChanged: [...new Set(batchChanges)] });
      const note = [truncationNote, turnNote].filter(Boolean).join("\n\n");
      if (note && results.length) {
        const last = results[results.length - 1];
        last.content = `${last.content}\n\n${note}`;
      }
      messages.push({ role: "user", content: results });
      contextTokens += estimateTokens(results);
      if (controller?.isDone?.()) {
        stopReason = "controller";
        break;
      }
      if (iteration === maxIterations - 1) stopReason = "max_iterations";
    }
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
    stopReason = "error";
  }

  if (input.signal?.aborted) {
    error = "cancelled";
    stopReason = "cancelled";
  }

  const durationMs = Date.now() - startedAt;
  const summary = finalText.trim() || (error ? `Failed: ${error}` : "No summary returned.");

  input.emit({
    type: "agent_done",
    agentId: input.agentId,
    summary,
    tokensIn: usage.inputTokens + usage.cacheReadTokens,
    tokensOut: usage.outputTokens,
    cost,
    durationMs,
    error,
  });

  return {
    agentId: input.agentId,
    stepId: input.stepId,
    role: input.role,
    summary,
    usage,
    cost,
    uncachedCost,
    filesTouched: [...filesTouched],
    durationMs,
    error,
    metrics,
    stopReason,
  };
}

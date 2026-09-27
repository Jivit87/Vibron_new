/**
 * The orchestrator.
 *
 * Turns one sentence from the user into a finished, verified change set by
 * decomposing it and running specialists in parallel waves.
 *
 * Flow:
 *   1. **Plan** — a frontier model surveys the workspace through the graph
 *      and emits a task DAG via the `submit_plan` tool.
 *   2. **Execute** — steps are batched into waves of mutually independent
 *      work. Every step declares the files it owns, and that list becomes a
 *      hard write-lock, so concurrent agents cannot clobber each other.
 *   3. **Integrate** — after each wave the graph and memory are refreshed,
 *      so the next wave sees what the previous one built.
 *   4. **Verify** — for multi-step runs, a reviewer reads the result and
 *      reports real problems.
 *
 * Everything is streamed as `OrchestrationEvent`s.
 */

import { randomUUID } from "node:crypto";

import { runTurn, resolveModel } from "@/lib/ai";
import {
  addUsage,
  EMPTY_USAGE,
  type AiMessage,
  type AiSystemBlock,
  type AiToolDef,
  type AiUsage,
} from "@/lib/ai/types";
import { buildSkeleton, ContextLedger, type EngineInput } from "@/lib/context/engine";
import { renderMemoryPrompt, renderMemoryMarkdown, saveMemory } from "@/lib/memory";
import type { ProjectMemory } from "@/lib/memory/types";
import { isToolFailure, runTool, toolDefs } from "@/lib/tools/registry";
import type { ToolContext } from "@/lib/tools/registry";
import {
  refreshMemory,
  writeMemoryMirror,
  type WorkspaceHandle,
} from "@/lib/workspace";
import { getGraph, getFileInfo } from "@/lib/store";
import { readFile as wsReadFile } from "@/lib/workspace";
import type { Interaction } from "@/lib/harness/contracts";
import type { ImageAttachment } from "@/lib/composer/types";
import { ASSIGNABLE_ROLES, getRole, ROLES, type RoleId } from "@/lib/agents/roles";
import { guessIntent } from "@/lib/agents/intent";
import { describeRules, loadRules, type RulesBundle } from "@/lib/agents/rules";
import {
  computeWaves,
  type EventSink,
  type OrchestrationEvent,
  type PlanStep,
  type RunPlan,
  type RunStatus,
} from "@/lib/agents/events";
import {
  friendlyProviderError,
  runAgent,
  type AgentRunInput,
  type AgentRunResult,
  type ApprovalRequester,
} from "@/lib/agents/runner";

export interface OrchestrationInput {
  repoKey: string;
  handle: WorkspaceHandle;
  request: string;
  /** Prior conversation, already trimmed by the caller. */
  history: { role: "user" | "assistant"; content: string }[];
  mode: "auto" | "single" | "orchestrated";
  /** "auto" resolves to the best available model. */
  model: string | "auto";
  commandPolicy: "auto" | "ask" | "never";
  /** Cap on concurrent specialists. */
  concurrency: number;
  emit: EventSink;
  signal?: AbortSignal;
  requestApproval?: ApprovalRequester;
  /** Registered run id (see lib/harness/runs). Generated when absent. */
  runId?: string;
  /** Build, plan for approval, or answer read-only. Default "agent". */
  interaction?: Interaction;
  /** A user-approved plan to execute instead of planning again. */
  plan?: RunPlan;
  editPolicy?: "auto" | "ask";
  showThinking?: boolean;
  retrieval?: { depth?: number; maxNodes?: number };
  /** Resolved `## Attached context` block, appended to the request. */
  attachments?: string;
  /** Preloaded rules; loaded from the workspace when absent. */
  rules?: RulesBundle;
  /** Pasted images; every agent (and the planner) sees them with the task. */
  images?: ImageAttachment[];
}

/* ----------------------------- plan tool ---------------------------------- */

/** What a planning turn concluded. */
type PlanOutcome =
  | { kind: "plan"; plan: RunPlan }
  | { kind: "answer"; reason: string }
  | null;

/**
 * The orchestrator's escape hatch.
 *
 * The intent heuristic deliberately returns "unsure" rather than guessing,
 * which means genuinely ambiguous prompts still reach the planner. Without
 * this tool the planner's only move is to invent a build, so a question
 * phrased like an instruction ("walk me through the auth flow") would get
 * files edited. This lets it decline to build.
 */
const ANSWER_DIRECTLY_TOOL: AiToolDef = {
  name: "answer_directly",
  description:
    "Use INSTEAD of submit_plan when the user asked a question rather than requesting a change — anything answerable by reading and explaining the code. Do not use it to avoid work on a genuine build request.",
  input_schema: {
    type: "object",
    properties: {
      reason: {
        type: "string",
        description:
          "One sentence on why this is a question rather than a change request.",
      },
    },
    required: ["reason"],
  },
};

const SUBMIT_PLAN_TOOL: AiToolDef = {
  name: "submit_plan",
  description:
    "Submit the final task breakdown. Call this exactly once, after you have oriented yourself. Steps with no depends_on run in parallel, so partition work by file: two steps must never list the same file.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description:
          "Two or three sentences for the user: what will be built and how it is split up.",
      },
      steps: {
        type: "array",
        description: "The subtasks, in dependency order.",
        items: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "Short slug, e.g. 'scaffold' or 'api-routes'.",
            },
            title: { type: "string", description: "Short imperative title." },
            role: {
              type: "string",
              enum: ASSIGNABLE_ROLES,
              description: "Which specialist executes this step.",
            },
            detail: {
              type: "string",
              description:
                "Full instructions for the specialist, who cannot see this conversation. State exactly what to build, the interfaces it must expose or consume, and how it connects to sibling steps.",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description:
                "Files this step will create or modify. Becomes an exclusive write-lock — no two steps may share a file.",
            },
            depends_on: {
              type: "array",
              items: { type: "string" },
              description: "Step ids that must complete first. Omit for none.",
            },
          },
          required: ["id", "title", "role", "detail", "files"],
        },
      },
    },
    required: ["summary", "steps"],
  },
};

interface RawStep {
  id?: unknown;
  title?: unknown;
  role?: unknown;
  detail?: unknown;
  files?: unknown;
  depends_on?: unknown;
}

/** Coerce whatever the model emitted into a plan we can actually execute. */
function normalizePlan(raw: Record<string, unknown>): RunPlan {
  const rawSteps = Array.isArray(raw.steps) ? (raw.steps as RawStep[]) : [];
  const seenIds = new Set<string>();
  const claimedFiles = new Map<string, string>();

  const steps: PlanStep[] = [];
  for (let i = 0; i < rawSteps.length; i += 1) {
    const rawStep = rawSteps[i];
    let id = typeof rawStep.id === "string" && rawStep.id.trim() ? rawStep.id.trim() : `step-${i + 1}`;
    while (seenIds.has(id)) id = `${id}-${i + 1}`;
    seenIds.add(id);

    const role: RoleId = ASSIGNABLE_ROLES.includes(rawStep.role as RoleId)
      ? (rawStep.role as RoleId)
      : "generalist";

    // Enforce the write-lock invariant even if the model ignored it: the
    // first step to claim a file keeps it. Silently sharing a file between
    // concurrent agents is the one failure mode that corrupts real work.
    const files = (Array.isArray(rawStep.files) ? rawStep.files : [])
      .filter((f): f is string => typeof f === "string" && f.trim().length > 0)
      .map((f) => f.trim())
      .filter((f) => {
        const owner = claimedFiles.get(f);
        if (owner && owner !== id) return false;
        claimedFiles.set(f, id);
        return true;
      });

    steps.push({
      id,
      title:
        typeof rawStep.title === "string" && rawStep.title.trim()
          ? rawStep.title.trim()
          : `Step ${i + 1}`,
      role,
      detail: typeof rawStep.detail === "string" ? rawStep.detail : "",
      files,
      dependsOn: (Array.isArray(rawStep.depends_on) ? rawStep.depends_on : [])
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim()),
    });
  }

  return {
    summary: typeof raw.summary === "string" ? raw.summary : "",
    steps,
    waves: computeWaves(steps),
  };
}

/* --------------------------- engine wiring -------------------------------- */

async function buildEngine(
  handle: WorkspaceHandle,
  memory: ProjectMemory,
  ledger: ContextLedger,
): Promise<EngineInput> {
  const [graph, fileInfo] = await Promise.all([
    getGraph(handle.repoKey),
    getFileInfo(handle.repoKey),
  ]);
  return {
    graph,
    memory,
    fileInfo,
    readFile: (path) => wsReadFile(handle, path),
    ledger,
  };
}

/* ------------------------------- run -------------------------------------- */

/**
 * Re-run an approved plan through the same normalization as a fresh one.
 * It came back from the browser, where the user may have edited it, so
 * roles, ids, file locks, and waves are all re-derived rather than trusted.
 */
export function renormalizePlan(plan: RunPlan): RunPlan {
  return normalizePlan({
    summary: plan.summary,
    steps: (Array.isArray(plan.steps) ? plan.steps : []).map((step) => ({
      id: step?.id,
      title: step?.title,
      role: step?.role,
      detail: step?.detail,
      files: step?.files,
      depends_on: step?.dependsOn,
    })),
  });
}

export async function orchestrate(input: OrchestrationInput): Promise<void> {
  const runId = input.runId ?? randomUUID();
  const startedAt = Date.now();
  const ledger = new ContextLedger();
  const interaction = input.interaction ?? "agent";

  let memory = await refreshMemory(input.handle);
  let engine = await buildEngine(input.handle, memory, ledger);
  const rules =
    input.rules ?? (await loadRules(input.handle).catch(() => ({ files: [], text: "" })));

  let totalUsage: AiUsage = EMPTY_USAGE;
  let totalCost = 0;
  let totalUncachedCost = 0;
  const changedFiles = new Set<string>();

  const model = await resolveModel(input.model, { agenticOnly: true });

  // What the user asked, plus anything they attached with `@`.
  const request = input.attachments
    ? `${input.request}\n\n${input.attachments}`
    : input.request;

  const emitLedger = () => {
    input.emit({
      type: "ledger",
      ledger: ledger.snapshot(),
      tokensIn: totalUsage.inputTokens + totalUsage.cacheReadTokens,
      tokensOut: totalUsage.outputTokens,
      tokensCached: totalUsage.cacheReadTokens,
      tokensCacheWrite: totalUsage.cacheWriteTokens,
      costUsd: totalCost,
      uncachedUsd: totalUncachedCost,
    });
  };

  const absorb = (result: AgentRunResult) => {
    totalUsage = addUsage(totalUsage, result.usage);
    totalCost += result.cost;
    totalUncachedCost += result.uncachedCost;
    for (const file of result.filesTouched) changedFiles.add(file);
  };

  /** Settings every agent in this run shares. */
  const shared = (): Pick<
    AgentRunInput,
    | "handle"
    | "engine"
    | "memory"
    | "emit"
    | "signal"
    | "runId"
    | "requestApproval"
    | "rules"
    | "showThinking"
    | "editPolicy"
    | "retrieval"
    | "images"
  > => ({
    handle: input.handle,
    engine,
    memory,
    emit: input.emit,
    signal: input.signal,
    runId,
    requestApproval: input.requestApproval,
    rules: rules.text,
    showThinking: input.showThinking,
    editPolicy: input.editPolicy,
    retrieval: input.retrieval,
    images: input.images,
  });

  /** One agent whose prose is the reply; used by every non-team path. */
  const runSolo = async (role: "assistant" | "generalist", intent: "ask" | "build") => {
    const result = await runAgent({
      ...shared(),
      agentId: "solo",
      stepId: "solo",
      role,
      model,
      ...(role === "assistant" ? { title: "Answering" } : {}),
      task: request,
      briefing: renderHistory(input.history),
      files: [],
      commandPolicy: role === "assistant" ? "never" : input.commandPolicy,
      // This agent's prose is the reply, so stream it into the chat.
      streamAnswer: true,
    });
    absorb(result);
    emitLedger();
    await done(result.summary, intent, result.error ? "failed" : "done");
  };

  const done = (
    summary: string,
    intent: "ask" | "build" | null = null,
    status: RunStatus = "done",
  ) =>
    finalize(input, memory, startedAt, changedFiles.size, totalCost, summary, intent, status);

  input.emit({
    type: "run_start",
    runId,
    mode:
      interaction === "plan"
        ? "plan"
        : input.mode === "single" || interaction === "ask"
          ? "single"
          : "orchestrated",
    model,
    at: startedAt,
    rules: describeRules(rules),
  });

  try {
    /* --------------------------- intent routing ------------------------- */
    /*
     * A question deserves an answer, not a build plan. Route it to a
     * read-only assistant before any of the build machinery spins up —
     * this is what stops "how does X work?" from dispatching a squad of
     * agents with write access at the codebase. "ask" makes that explicit.
     */
    const intent = interaction === "ask" ? "ask" : guessIntent(input.request);

    if (
      interaction === "ask" ||
      (interaction === "agent" && !input.plan && intent === "ask" && input.mode !== "orchestrated")
    ) {
      input.emit({
        type: "intent",
        intent: "ask",
        reason: "Answering from the code — no files will be changed.",
      });
      await runSolo("assistant", "ask");
      return;
    }

    /* ----------------------- single-agent fast path --------------------- */
    if (interaction === "agent" && !input.plan && input.mode === "single") {
      input.emit({
        type: "intent",
        intent: intent ?? "build",
        reason: "One engineer handling this end to end.",
      });
      await runSolo("generalist", "build");
      return;
    }

    let plan: RunPlan | null = null;

    if (input.plan) {
      /* ------------------------- approved plan -------------------------- */
      plan = renormalizePlan(input.plan);
      input.emit({
        type: "intent",
        intent: "build",
        reason: "Running the plan you approved.",
      });
    } else {
      /* ------------------------------ plan ------------------------------ */
      input.emit({
        type: "intent",
        intent: "build",
        reason:
          interaction === "plan"
            ? "Planning only — nothing runs until you approve."
            : "Planning the work and dispatching specialists.",
      });

      // A planning failure is never fatal: fall through to a single
      // generalist, which needs a far smaller prompt and can still do the
      // work. In plan mode there is nothing to fall back to.
      let outcome: PlanOutcome = null;
      try {
        outcome = await buildPlan(
          { ...input, model, memory, engine, ledger, request, rules },
          (usage, cost, uncached) => {
            totalUsage = addUsage(totalUsage, usage);
            totalCost += cost;
            totalUncachedCost += uncached;
          },
        );
      } catch (planError) {
        const raw =
          planError instanceof Error ? planError.message : String(planError);
        if (interaction === "plan" || !/too large|context|rate.?limit|429|413/i.test(raw)) {
          throw planError;
        }
        input.emit({
          type: "error",
          message:
            "This model could not hold the planning prompt, so the work is going to a single agent instead of a team.",
          fatal: false,
        });
      }

      if (input.signal?.aborted) {
        await done("");
        return;
      }

      if (outcome?.kind === "answer") {
        input.emit({ type: "intent", intent: "ask", reason: outcome.reason });
        await runSolo("assistant", "ask");
        return;
      }

      plan = outcome?.kind === "plan" && outcome.plan.steps.length > 0 ? outcome.plan : null;

      if (interaction === "plan") {
        if (!plan) {
          emitLedger();
          await done(
            "I could not produce a plan for that. Try rephrasing the request, or switch to Agent mode.",
            "build",
            "failed",
          );
          return;
        }
        // Plan mode stops here: the user reviews, edits, and re-posts it.
        input.emit({ type: "plan", plan, awaitingApproval: true });
        emitLedger();
        await done(
          `${plan.summary ? `${plan.summary}\n\n` : ""}Review the ${plan.steps.length}-step plan, then run it.`,
          "build",
        );
        return;
      }
    }

    if (!plan || plan.steps.length === 0) {
      // Planning produced nothing usable — fall back to one generalist
      // rather than telling the user we could not decide how to help.
      await runSolo("generalist", "build");
      return;
    }

    input.emit({ type: "plan", plan, awaitingApproval: false });
    emitLedger();

    /* ----------------------------- execute ------------------------------ */
    const byId = new Map(plan.steps.map((s) => [s.id, s] as const));
    const completed = new Map<string, AgentRunResult>();

    for (let waveIndex = 0; waveIndex < plan.waves.length; waveIndex += 1) {
      if (input.signal?.aborted) break;
      const waveIds = plan.waves[waveIndex];
      input.emit({ type: "wave_start", wave: waveIndex, stepIds: waveIds });

      // Bound concurrency so we do not open twenty simultaneous model
      // streams and trip provider rate limits.
      const queue = [...waveIds];
      const limit = Math.max(1, Math.min(input.concurrency, queue.length));

      const workers = Array.from({ length: limit }, async () => {
        while (queue.length > 0) {
          if (input.signal?.aborted) return;
          const stepId = queue.shift();
          if (!stepId) return;
          const step = byId.get(stepId);
          if (!step) continue;

          // A step built on work that failed would build on nothing.
          const blocker = step.dependsOn
            .map((id) => completed.get(id))
            .find((r) => r?.error);
          if (blocker) {
            const skipped = skipStep(step, byId.get(blocker.stepId)?.title ?? blocker.stepId, waveIndex, model);
            input.emit(skipped.start);
            input.emit(skipped.done);
            completed.set(stepId, skipped.result);
            continue;
          }

          const role = getRole(step.role);
          const stepModel = await resolveModel(
            input.model === "auto" ? "auto" : model,
            { agenticOnly: true },
          );

          const result = await runAgent({
            ...shared(),
            agentId: stepId,
            stepId,
            role: step.role,
            model: stepModel,
            title: step.title,
            task: buildStepTask(step),
            briefing: buildStepBriefing(input, plan, step, completed),
            files: step.files,
            commandPolicy: input.commandPolicy,
            wave: waveIndex,
            maxIterations: role.maxIterations,
          });

          completed.set(stepId, result);
          absorb(result);
        }
      });

      await Promise.all(workers);
      input.emit({ type: "wave_end", wave: waveIndex });

      // Re-index between waves so the next wave sees the new code.
      memory = await refreshMemory(input.handle);
      engine = await buildEngine(input.handle, memory, ledger);
      emitLedger();
    }

    /* ------------------------------ verify ------------------------------ */
    let reviewSummary = "";
    const alreadyReviewed = plan.steps.some((s) => s.role === "reviewer");
    if (
      !input.signal?.aborted &&
      plan.steps.length > 1 &&
      !alreadyReviewed &&
      changedFiles.size > 0
    ) {
      const review = await runAgent({
        ...shared(),
        agentId: "review",
        stepId: "review",
        role: "reviewer",
        model,
        task: buildReviewTask(input.request, [...changedFiles]),
        briefing: summarizeResults(completed),
        files: [],
        commandPolicy: input.commandPolicy,
        wave: plan.waves.length,
      });
      absorb(review);
      reviewSummary = review.summary;
      emitLedger();
    }

    // Partial success is still "done" (the summary lists what failed); a
    // run where no step landed is a failure.
    const anySucceeded = plan.steps.some((s) => {
      const result = completed.get(s.id);
      return result && !result.error;
    });
    const summary = composeFinalSummary(plan, completed, reviewSummary);
    await done(summary, null, anySucceeded ? "done" : "failed");
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = friendlyProviderError(raw, model);
    const cancelled = input.signal?.aborted ?? false;
    if (!cancelled) input.emit({ type: "error", message, fatal: true });
    input.emit({
      type: "run_done",
      status: cancelled ? "cancelled" : "failed",
      summary: cancelled ? cancelledSummary(changedFiles.size) : `Run failed: ${message}`,
      filesChanged: changedFiles.size,
      durationMs: Date.now() - startedAt,
      costUsd: totalCost,
    });
  }
}

/** The lane events and result for a step skipped because a dependency failed. */
function skipStep(step: PlanStep, blockerTitle: string, wave: number, model: string) {
  const error = `Skipped: depends on "${blockerTitle}", which did not complete.`;
  return {
    start: {
      type: "agent_start",
      agentId: step.id,
      stepId: step.id,
      role: step.role,
      title: step.title,
      model,
      wave,
    } satisfies OrchestrationEvent,
    done: {
      type: "agent_done",
      agentId: step.id,
      summary: error,
      tokensIn: 0,
      tokensOut: 0,
      cost: 0,
      durationMs: 0,
      error,
    } satisfies OrchestrationEvent,
    result: {
      agentId: step.id,
      stepId: step.id,
      role: step.role,
      summary: error,
      usage: EMPTY_USAGE,
      cost: 0,
      uncachedCost: 0,
      filesTouched: [],
      durationMs: 0,
      error,
    } satisfies AgentRunResult,
  };
}

function cancelledSummary(filesChanged: number): string {
  return filesChanged > 0
    ? `Stopped. ${filesChanged} file${filesChanged === 1 ? " was" : "s were"} already changed — review them in the Changes panel.`
    : "Stopped before any files were changed.";
}

/* ----------------------------- planning ----------------------------------- */

async function buildPlan(
  input: OrchestrationInput & {
    model: string;
    memory: ProjectMemory;
    engine: EngineInput;
    ledger: ContextLedger;
    rules: RulesBundle;
  },
  onUsage: (usage: AiUsage, cost: number, uncached: number) => void,
): Promise<PlanOutcome> {
  const role = ROLES.orchestrator;
  const engine: EngineInput = { ...input.engine, ledger: input.ledger.fork("orchestrator") };

  const system: AiSystemBlock[] = [
    { text: role.systemPrompt },
    { text: input.rules.text },
    { text: renderMemoryPrompt(input.memory) },
    { text: buildSkeleton(engine), cache: true },
  ].filter((b) => b.text.trim().length > 0);

  const messages: AiMessage[] = [];
  const history = renderHistory(input.history);
  if (history) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `## Conversation so far\n\n${history}` }],
    });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: "Understood. I have the prior context." }],
    });
  }
  messages.push({
    role: "user",
    content: [
      ...(input.images ?? []).map((image) => ({
        type: "image" as const,
        mediaType: image.mediaType,
        data: image.data,
      })),
      {
        type: "text",
        text: `The user's request:\n\n${input.request}\n\nOrient yourself briefly, then call submit_plan.`,
      },
    ],
  });

  const ctx: ToolContext = {
    handle: input.handle,
    engine,
    memory: input.memory,
    agent: "Orchestrator",
    allowedTools: role.tools,
    commandPolicy: "never",
    signal: input.signal,
    runId: input.runId,
    retrieval: input.retrieval,
    events: {},
  };

  const tools = [...toolDefs(role.tools), SUBMIT_PLAN_TOOL, ANSWER_DIRECTLY_TOOL];

  for (let iteration = 0; iteration < role.maxIterations; iteration += 1) {
    if (input.signal?.aborted) return null;

    const turn = await runTurn(
      {
        model: input.model,
        system,
        messages,
        tools,
        effort: role.effort,
        showThinking: input.showThinking,
        signal: input.signal,
      },
      {
        onText: (text) => input.emit({ type: "orchestrator_text", text }),
        onThinking: (text) => {
          if (input.showThinking !== false) {
            input.emit({ type: "orchestrator_thinking", text });
          }
        },
        onRetry: (info) =>
          input.emit({ type: "agent_retry", agentId: "orchestrator", ...info }),
      },
    );
    onUsage(turn.usage, turn.cost, turn.uncachedCost);

    if (turn.stopReason === "refusal") return null;

    const answerCall = turn.toolCalls.find((c) => c.name === "answer_directly");
    if (answerCall) {
      return {
        kind: "answer",
        reason:
          typeof answerCall.input.reason === "string"
            ? answerCall.input.reason
            : "This is a question about the code.",
      };
    }

    const planCall = turn.toolCalls.find((c) => c.name === "submit_plan");
    if (planCall) return { kind: "plan", plan: normalizePlan(planCall.input) };

    if (turn.toolCalls.length === 0) {
      // The model answered in prose instead of planning. Nudge once, then
      // give up and let the caller fall back to a single agent.
      if (iteration >= role.maxIterations - 2) return null;
      messages.push({ role: "assistant", content: turn.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "(System) Now call `submit_plan` with the task breakdown. Do not reply in prose.",
          },
        ],
      });
      continue;
    }

    messages.push({ role: "assistant", content: turn.content });
    const results: AiMessage["content"] = [];
    for (const call of turn.toolCalls) {
      const args = Object.keys(call.input).join(", ");
      input.emit({
        type: "agent_tool",
        agentId: "orchestrator",
        callId: call.id,
        tool: call.name,
        args,
        phase: "start",
      });
      const output = call.inputError
        ? `Error: ${call.inputError}`
        : await runTool(call.name, call.input, ctx);
      const failed = isToolFailure(output);
      input.emit({
        type: "agent_tool",
        agentId: "orchestrator",
        callId: call.id,
        tool: call.name,
        args,
        phase: "end",
        result: output.slice(0, 140),
        ok: !failed,
      });
      results.push({
        type: "tool_result",
        tool_use_id: call.id,
        content: output,
        ...(failed ? { is_error: true } : {}),
      });
    }
    messages.push({ role: "user", content: results });
  }

  return null;
}

/* ------------------------------ helpers ----------------------------------- */

function renderHistory(
  history: { role: "user" | "assistant"; content: string }[],
): string {
  if (history.length === 0) return "";
  return history
    .slice(-8)
    .map((m) => `**${m.role === "user" ? "User" : "Assistant"}:** ${m.content}`)
    .join("\n\n");
}

function buildStepTask(step: PlanStep): string {
  const files = step.files.length
    ? `\n\nFiles you own (you may only write these): ${step.files.map((f) => `\`${f}\``).join(", ")}`
    : "";
  return `## ${step.title}\n\n${step.detail}${files}`;
}

function buildStepBriefing(
  input: OrchestrationInput,
  plan: RunPlan,
  step: PlanStep,
  completed: Map<string, AgentRunResult>,
): string {
  const parts: string[] = [
    `The user asked: "${input.request}"`,
    `Overall plan: ${plan.summary}`,
  ];

  const siblings = plan.steps.filter((s) => s.id !== step.id);
  if (siblings.length > 0) {
    parts.push(
      `Other agents are handling these in parallel or after you — do not do their work, and do not edit their files:\n${siblings
        .map(
          (s) =>
            `- **${s.title}** (${getRole(s.role).label}): ${s.files.join(", ") || "no fixed files"}`,
        )
        .join("\n")}`,
    );
  }

  const upstream = step.dependsOn
    .map((id) => completed.get(id))
    .filter((r): r is AgentRunResult => Boolean(r));
  if (upstream.length > 0) {
    parts.push(
      `Work you depend on is already done. What those agents reported:\n${upstream
        .map((r) => `- ${getRole(r.role).label}: ${r.summary}`)
        .join("\n")}`,
    );
  }

  if (input.attachments) parts.push(input.attachments);

  return parts.join("\n\n");
}

function buildReviewTask(request: string, files: string[]): string {
  return `Several agents just worked in parallel on this request:

"${request}"

Files changed:
${files.map((f) => `- \`${f}\``).join("\n")}

Review the result end to end. Prioritise **integration gaps** — mismatched
imports, exports that do not exist, API contracts the two sides disagree
about, and routes that were referenced but never created. Those are what
parallel agents get wrong.

Verify with a typecheck or build if the project has one. Report a short
ranked list of real problems with file, line, and the input that breaks it.
If everything holds together, say so plainly.`;
}

function summarizeResults(completed: Map<string, AgentRunResult>): string {
  if (completed.size === 0) return "";
  return `What each agent reported:\n${[...completed.values()]
    .map((r) => `- **${getRole(r.role).label}**: ${r.summary}`)
    .join("\n")}`;
}

/**
 * Compose what the user actually reads.
 *
 * A bare `✓ Step — Role` checklist is a progress report, not a reply — it
 * tells someone what machinery ran rather than what happened to their
 * project. So lead with the specialists' own prose (that is where the real
 * content is), keep the step list as a compact status line underneath, and
 * surface failures and review findings prominently because those are the
 * parts a user must not miss.
 */
function composeFinalSummary(
  plan: RunPlan,
  completed: Map<string, AgentRunResult>,
  reviewSummary: string,
): string {
  const parts: string[] = [];
  if (plan.summary) parts.push(plan.summary);

  // The substance: what each specialist reported doing.
  const reports = plan.steps
    .map((step) => {
      const result = completed.get(step.id);
      if (!result?.summary || result.error) return null;
      return `**${step.title}** — ${result.summary.trim()}`;
    })
    .filter((line): line is string => Boolean(line));
  if (reports.length > 0) parts.push(reports.join("\n\n"));

  const failures = plan.steps
    .map((step) => {
      const result = completed.get(step.id);
      if (!result) return `- **${step.title}** did not run.`;
      if (result.error?.startsWith("Skipped")) {
        return `- **${step.title}** ${result.error.replace(/^Skipped/, "skipped")}`;
      }
      if (result.error) return `- **${step.title}** failed: ${result.error}`;
      return null;
    })
    .filter((line): line is string => Boolean(line));
  if (failures.length > 0) {
    parts.push(`### Did not complete\n\n${failures.join("\n")}`);
  }

  if (reviewSummary) parts.push(`### Review\n\n${reviewSummary}`);

  const done = plan.steps.length - failures.length;
  parts.push(
    `_${done}/${plan.steps.length} steps completed by ${
      new Set(plan.steps.map((s) => getRole(s.role).label)).size
    } specialists._`,
  );

  return parts.join("\n\n");
}

/**
 * Guarantee the user gets a real reply.
 *
 * A model can end its loop having produced nothing — no edits, no prose, no
 * error — usually after one exploratory tool call on a small or heavily
 * rate-limited model. Returning that as-is shows an empty chat bubble, which
 * reads as the app being broken. Say what happened instead, and say what to
 * do about it.
 */
export function ensureSubstantiveSummary(
  summary: string,
  filesChanged: number,
  intent: "ask" | "build" | null,
): string {
  const text = summary.trim();
  const isEmpty =
    !text || text === "No summary returned." || text.startsWith("Failed: ");

  if (!isEmpty) return text;
  if (text.startsWith("Failed: ")) return text;

  if (filesChanged > 0) {
    return `Changed ${filesChanged} file${filesChanged === 1 ? "" : "s"}, but the model stopped without describing the work. Review the diffs in the Changes panel before keeping them.`;
  }

  return [
    intent === "ask"
      ? "I could not produce an answer for that."
      : "I stopped before making any changes.",
    "",
    "The model ended its turn early without completing the task. This usually means it ran out of request budget — small models and free provider tiers cap how much context a single turn can carry.",
    "",
    "Try one of these:",
    "- Add an Anthropic key in **Settings → Providers** and use Claude, which handles long tool loops far more reliably.",
    "- Narrow the request to one file or one change.",
    "- Lower **retrieval depth** in Settings to shrink the prompt.",
  ].join("\n");
}

async function finalize(
  input: OrchestrationInput,
  memory: ProjectMemory,
  startedAt: number,
  filesChanged: number,
  costUsd: number,
  summary: string,
  intent: "ask" | "build" | null = null,
  status: RunStatus = "done",
): Promise<void> {
  memory.stats.turns += 1;
  memory.stats.costUsd += costUsd;
  await saveMemory(memory);
  await writeMemoryMirror(input.handle, renderMemoryMarkdown(memory));

  const cancelled = input.signal?.aborted ?? false;
  input.emit({
    type: "run_done",
    status: cancelled ? "cancelled" : status,
    summary: cancelled
      ? cancelledSummary(filesChanged)
      : ensureSubstantiveSummary(summary, filesChanged, intent),
    filesChanged,
    durationMs: Date.now() - startedAt,
    costUsd,
  });
}

export type { OrchestrationEvent };

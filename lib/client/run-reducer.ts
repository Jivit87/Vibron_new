/**
 * Pure run-state reducer.
 *
 * Every `OrchestrationEvent` folds into `RunState` here, with no React, no
 * Zustand and no clock of its own (`now` is injected), so each event branch
 * is unit-testable. The store's `applyEvent` is a thin wrapper that adds the
 * one cross-slice effect (mirroring agent writes into open editor tabs).
 */

import type {
  ApprovalKind,
  FailureClass,
  LoadedRule,
  OrchestrationEvent,
  PlanStep,
  RunPlan,
  RunStatus,
  TodoItem,
} from "@/lib/agents/events";
import type { LedgerSnapshot } from "@/lib/context/ledger";
import type { Interaction } from "@/lib/harness/contracts";

export type AgentStatus = "queued" | "running" | "done" | "failed";

export interface ToolCallRecord {
  callId?: string;
  tool: string;
  args: string;
  result?: string;
  ok?: boolean;
  running: boolean;
  at: number;
}

/**
 * One entry in an agent's chronological feed. Text and thinking deltas
 * coalesce into the trailing entry of the same kind; everything else is a
 * discrete row, so the view can render a lane top-to-bottom in the order the
 * model actually worked.
 */
export type FeedItem =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; index: number }
  | {
      kind: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      at: number;
    }
  | {
      kind: "compaction";
      strategy: "elide" | "summarize";
      beforeTokens: number;
      afterTokens: number;
    }
  | { kind: "diagnostics"; errorCount: number; files: string[]; injected: boolean }
  | {
      kind: "hook";
      event: "pre_tool" | "post_tool" | "stop";
      command: string;
      exitCode: number | null;
      blocked: boolean;
      output: string;
    }
  | { kind: "approval"; approvalId: string }
  /** Harness rows; `index` points into `run.verifications` / `gates` / `recoveries`. */
  | { kind: "verification"; index: number }
  | { kind: "gate"; index: number }
  | { kind: "recovery"; index: number }
  | { kind: "command"; command: string; sessionId: string; status: string; exitCode: number | null };

/** One specialist's live state during a run. */
export interface AgentLane {
  id: string;
  stepId: string;
  role: string;
  title: string;
  model: string;
  wave: number;
  status: AgentStatus;
  /** Streaming assistant text (all turns, concatenated). */
  text: string;
  /** Streaming reasoning summary, when the model exposes one. */
  thinking: string;
  tools: ToolCallRecord[];
  feed: FeedItem[];
  files: string[];
  summary: string;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  startedAt: number;
  durationMs?: number;
  /** Fix runs: which solve attempt this lane is (1-based). */
  attempt?: number;
  /** Attempt 2+: why the previous attempt was not kept. */
  retryReason?: string;
}

export interface FileChangeRecord {
  id: string;
  agentId: string;
  kind: "create" | "update" | "delete" | "rename";
  path: string;
  previousPath?: string;
  before: string | null;
  after: string | null;
  summary: string;
  adds: number;
  removes: number;
  at: number;
  reverted: boolean;
}

export type ApprovalResolution = "allow" | "deny" | "timeout" | "cancelled";

export interface ApprovalRequest {
  approvalId: string;
  agentId: string;
  kind: ApprovalKind;
  title: string;
  /** Legacy field; same as `title` for command approvals. */
  command: string;
  reason: string;
  detail?: {
    command?: string;
    path?: string;
    before?: string | null;
    after?: string | null;
    args?: string;
  };
  at: number;
  /** Set once answered locally or by an `approval_resolved` event. */
  resolution?: ApprovalResolution;
}

export interface RetryRecord {
  agentId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: string;
  at: number;
}

export interface CompactionRecord {
  agentId: string;
  strategy: "elide" | "summarize";
  beforeTokens: number;
  afterTokens: number;
  at: number;
}

/**
 * Per-check verdict from the submit gate: every check runs on the original
 * and the patched code.
 */
export type CheckVerdict = "fixes" | "regression" | "pre_existing" | "still_failing" | "pass";

export interface CheckRow {
  name: string;
  verdict: CheckVerdict;
  /** One-line outcome on the original code. */
  before?: string;
  /** One-line outcome on the patched code. */
  after?: string;
  excerpt?: string;
}

export interface VerificationRecord {
  agentId: string;
  phase: "baseline" | "gate" | "final";
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: number;
  failed: number;
  newFailures: string[];
  fixed: string[];
  durationMs: number;
  excerpt: string;
  checks: CheckRow[];
  /** `run.changes.length` when it ran, to tell whether it covers the latest edit. */
  afterChanges: number;
  at: number;
}

export type GateDecision = "accept" | "reject" | "accept_unverified" | "give_up";

export interface GateRecord {
  agentId: string;
  decision: GateDecision;
  reason: string;
  attempt: number;
  at: number;
}

export interface RecoveryRecord {
  agentId: string;
  failureClass: FailureClass;
  action: "hint" | "replan" | "rollback" | "restore_best";
  detail: string;
  checkpointId?: string;
  at: number;
}

export interface CheckpointRecord {
  id: string;
  label: string;
  fileCount: number;
  kind: "run" | "edit_batch" | "best";
  ref?: string;
}

/** Where the harness looked before the solver started (the `localize` event). */
export interface Localization {
  files: { path: string; score: number; why: string[] }[];
  /** Whether the issue's code snippet reproduced the bug on the original code. */
  snippetReproduced?: boolean;
}

/** The blind test writer's outcome (`independent_test` events, latest wins). */
export interface IndependentTest {
  status: "written" | "ran" | "skipped" | "gave_up";
  command?: string;
  /** A `CheckVerdict` when recognised; any other string is kept for display. */
  verdict?: string;
  seconds?: number;
  /** Outcome on the original / patched code, when the producer sends it. */
  before?: string;
  after?: string;
  /** Why it was skipped or given up on, when sent. */
  reason?: string;
}

/** Wall time of one harness phase (`phase` events; repeats accumulate). */
export interface PhaseTiming {
  name: string;
  ms: number;
}

export interface RunState {
  id: string;
  prompt: string;
  mode: "single" | "orchestrated" | "plan";
  model: string;
  status: "planning" | "running" | "done" | "failed" | "cancelled" | "incomplete";
  startedAt: number;
  endedAt?: number;
  plan?: RunPlan;
  /** The plan was produced in plan mode and waits for the user to run it. */
  planAwaitingApproval: boolean;
  orchestratorText: string;
  orchestratorThinking: string;
  agents: AgentLane[];
  changes: FileChangeRecord[];
  approvals: ApprovalRequest[];
  /** Latest todo list per agent id (full replace on every `todos` event). */
  todos: Record<string, TodoItem[]>;
  retries: RetryRecord[];
  compactions: CompactionRecord[];
  rules: LoadedRule[];
  ledger?: LedgerSnapshot;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  costUsd: number;
  uncachedUsd: number;
  currentWave: number;
  summary: string;
  error?: string;
  intent?: "ask" | "build";
  intentReason?: string;
  checkpointId?: string;
  checkpointLabel?: string;
  /** What the composer asked for; "fix" runs render the solve view. */
  interaction?: Interaction;
  checkpoints: CheckpointRecord[];
  verifications: VerificationRecord[];
  gates: GateRecord[];
  recoveries: RecoveryRecord[];
  localization?: Localization;
  /** Predicted acceptance criteria (`criteria` event). */
  criteria?: string[];
  independentTest?: IndependentTest;
  /** Per-phase wall time, in arrival order. */
  phaseTimings: PhaseTiming[];
  /** Server-reported wall time from `run_done.durationMs`. */
  wallMs?: number;
}

export function createRun(input: {
  id: string;
  prompt: string;
  model: string;
  mode: RunState["mode"];
  now: number;
  interaction?: Interaction;
}): RunState {
  return {
    id: input.id,
    interaction: input.interaction,
    checkpoints: [],
    verifications: [],
    gates: [],
    recoveries: [],
    phaseTimings: [],
    prompt: input.prompt,
    mode: input.mode,
    model: input.model,
    status: "planning",
    startedAt: input.now,
    planAwaitingApproval: false,
    orchestratorText: "",
    orchestratorThinking: "",
    agents: [],
    changes: [],
    approvals: [],
    todos: {},
    retries: [],
    compactions: [],
    rules: [],
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    costUsd: 0,
    uncachedUsd: 0,
    currentWave: 0,
    summary: "",
  };
}

function blankLane(
  input: Pick<AgentLane, "id" | "stepId" | "role" | "title" | "model" | "wave" | "status">,
  now: number,
): AgentLane {
  return {
    ...input,
    text: "",
    thinking: "",
    tools: [],
    feed: [],
    files: [],
    summary: "",
    tokensIn: 0,
    tokensOut: 0,
    cost: 0,
    startedAt: now,
  };
}

const MAX_TOOLS = 200;

/** Append streamed prose to the lane's feed, coalescing with the tail. */
function appendStream(
  feed: FeedItem[],
  kind: "text" | "thinking",
  text: string,
): FeedItem[] {
  const last = feed[feed.length - 1];
  if (last && last.kind === kind) {
    return [...feed.slice(0, -1), { kind, text: last.text + text }];
  }
  return [...feed, { kind, text }];
}

/**
 * Events can arrive for an agent the run has not seen (single-agent runs
 * skip `plan`, legacy producers send `agentId: "pending"`). Rather than drop
 * them, lazily create a lane so nothing the model did is invisible.
 */
function ensureLane(run: RunState, agentId: string, now: number): RunState {
  if (run.agents.some((a) => a.id === agentId)) return run;
  return {
    ...run,
    agents: [
      ...run.agents,
      blankLane(
        {
          id: agentId,
          stepId: agentId,
          role: "generalist",
          title: "Agent",
          model: run.model,
          wave: 0,
          status: "running",
        },
        now,
      ),
    ],
  };
}

function patchLane(
  run: RunState,
  agentId: string,
  now: number,
  patch: (lane: AgentLane) => AgentLane,
): RunState {
  const ensured = ensureLane(run, agentId, now);
  return {
    ...ensured,
    agents: ensured.agents.map((lane) => (lane.id === agentId ? patch(lane) : lane)),
  };
}

export interface ReduceContext {
  now: number;
  /** Id generator for change records. */
  nextId: (prefix: string) => string;
}

export function reduceRun(
  run: RunState,
  event: OrchestrationEvent,
  ctx: ReduceContext,
): RunState {
  const { now } = ctx;

  // Not in the `OrchestrationEvent` union yet; read tolerantly, ignore if malformed.
  if ((event as { type: string }).type === "localize") {
    const localization = normalizeLocalization(event);
    return localization ? { ...run, localization } : run;
  }
  // Round 5 events; read tolerantly whether or not the union has them yet.
  const loose = (event as { type: string }).type;
  if (loose === "criteria") {
    const criteria = normalizeCriteria(event);
    return criteria ? { ...run, criteria } : run;
  }
  if (loose === "independent_test") {
    const next = normalizeIndependentTest(event);
    if (!next) return run;
    // A later status keeps the command an earlier one ("written") named.
    return { ...run, independentTest: { ...next, command: next.command ?? run.independentTest?.command } };
  }
  if (loose === "phase") {
    const phase = normalizePhase(event);
    return phase ? { ...run, phaseTimings: addPhase(run.phaseTimings ?? [], phase) } : run;
  }

  switch (event.type) {
    case "run_start":
      return {
        ...run,
        id: event.runId,
        mode: event.mode,
        model: event.model,
        rules: event.rules ?? run.rules,
      };

    case "checkpoint": {
      const kind = event.kind ?? "run";
      const record: CheckpointRecord = {
        id: event.id,
        label: event.label,
        fileCount: event.fileCount,
        kind,
        ref: event.ref,
      };
      const checkpoints = [...run.checkpoints.filter((c) => c.id !== event.id), record];
      // Only the pre-run snapshot backs "Undo run"; tree snapshots are the
      // harness's own rollback points.
      return kind === "run"
        ? { ...run, checkpoints, checkpointId: event.id, checkpointLabel: event.label }
        : { ...run, checkpoints };
    }

    case "verification": {
      const extra = event as typeof event & { checks?: unknown };
      const record: VerificationRecord = {
        agentId: event.agentId,
        phase: event.phase,
        command: event.command,
        exitCode: event.exitCode,
        timedOut: event.timedOut,
        passed: event.passed,
        failed: event.failed,
        newFailures: event.newFailures ?? [],
        fixed: event.fixed ?? [],
        durationMs: event.durationMs,
        excerpt: event.excerpt ?? "",
        checks: normalizeChecks(extra.checks, event.newFailures ?? [], event.fixed ?? []),
        afterChanges: run.changes.length,
        at: now,
      };
      const verifications = [...run.verifications, record];
      return patchLane({ ...run, verifications }, event.agentId, now, (lane) => ({
        ...lane,
        feed: [...lane.feed, { kind: "verification", index: verifications.length - 1 }],
      }));
    }

    case "gate": {
      const gates: GateRecord[] = [
        ...run.gates,
        { agentId: event.agentId, decision: event.decision, reason: event.reason, attempt: event.attempt, at: now },
      ];
      return patchLane({ ...run, gates }, event.agentId, now, (lane) => ({
        ...lane,
        feed: [...lane.feed, { kind: "gate", index: gates.length - 1 }],
      }));
    }

    case "recovery": {
      const recoveries: RecoveryRecord[] = [
        ...run.recoveries,
        {
          agentId: event.agentId,
          failureClass: event.failureClass,
          action: event.action,
          detail: event.detail,
          checkpointId: event.checkpointId,
          at: now,
        },
      ];
      return patchLane({ ...run, recoveries }, event.agentId, now, (lane) => ({
        ...lane,
        feed: [...lane.feed, { kind: "recovery", index: recoveries.length - 1 }],
      }));
    }

    case "intent":
      return { ...run, intent: event.intent, intentReason: event.reason };

    case "answer":
      return run;

    case "orchestrator_thinking":
      return { ...run, orchestratorThinking: run.orchestratorThinking + event.text };

    case "orchestrator_text":
      return { ...run, orchestratorText: run.orchestratorText + event.text };

    case "plan": {
      const awaiting = Boolean(event.awaitingApproval);
      return {
        ...run,
        plan: event.plan,
        planAwaitingApproval: awaiting,
        status: awaiting ? run.status : "running",
        agents: event.plan.steps.map((step: PlanStep) => {
          const existing = run.agents.find((a) => a.id === step.id);
          if (existing) return existing;
          const lane = blankLane(
            {
              id: step.id,
              stepId: step.id,
              role: step.role,
              title: step.title,
              model: run.model,
              wave: event.plan.waves.findIndex((w) => w.includes(step.id)),
              status: "queued",
            },
            0,
          );
          return { ...lane, files: step.files };
        }),
      };
    }

    case "agent_start": {
      const extra = event as typeof event & { attempt?: unknown; reason?: unknown };
      const declared = extra.attempt;
      let existing = run.agents.find((a) => a.id === event.agentId);
      // solveTask reuses one agent id per attempt; keep the earlier attempt's lane.
      if (
        existing &&
        typeof declared === "number" &&
        existing.attempt !== undefined &&
        existing.attempt !== declared &&
        existing.status !== "queued"
      ) {
        const prior = existing;
        const archivedId = `${prior.id}#${prior.attempt}`;
        run = {
          ...run,
          agents: run.agents.map((a) =>
            a === prior ? { ...a, id: archivedId, status: a.status === "running" ? "done" : a.status } : a,
          ),
        };
        existing = undefined;
      }
      const attempt =
        typeof declared === "number"
          ? declared
          : run.interaction === "fix" && event.role !== "reviewer"
            ? (existing?.attempt ??
              run.agents.filter((a) => a.role !== "reviewer" && a.status !== "queued").length + 1)
            : undefined;
      const lane: AgentLane = {
        ...blankLane(
          {
            id: event.agentId,
            stepId: event.stepId,
            role: event.role,
            title: event.title,
            model: event.model,
            wave: event.wave,
            status: "running",
          },
          now,
        ),
        files: existing?.files ?? [],
        attempt,
        retryReason:
          attempt !== undefined && attempt > 1
            ? typeof extra.reason === "string" && extra.reason
              ? extra.reason
              : retryReasonOf(run, attempt)
            : undefined,
      };
      return {
        ...run,
        status: "running",
        agents: existing
          ? run.agents.map((a) => (a.id === event.agentId ? lane : a))
          : [...run.agents, lane],
      };
    }

    case "agent_text":
      return patchLane(run, event.agentId, now, (lane) => ({
        ...lane,
        text: lane.text + event.text,
        feed: appendStream(lane.feed, "text", event.text),
      }));

    case "agent_thinking":
      return patchLane(run, event.agentId, now, (lane) => ({
        ...lane,
        thinking: lane.thinking + event.text,
        feed: appendStream(lane.feed, "thinking", event.text),
      }));

    case "agent_tool":
      return patchLane(run, event.agentId, now, (lane) => {
        if (event.phase === "start") {
          const record: ToolCallRecord = {
            callId: event.callId,
            tool: event.tool,
            args: event.args,
            running: true,
            at: now,
          };
          let tools = [...lane.tools, record];
          let feed: FeedItem[] = [...lane.feed, { kind: "tool", index: tools.length - 1 }];
          // Bound memory on very long runs; re-index the feed when trimming.
          if (tools.length > MAX_TOOLS) {
            const drop = tools.length - MAX_TOOLS;
            tools = tools.slice(drop);
            feed = feed
              .filter((f) => f.kind !== "tool" || f.index >= drop)
              .map((f) => (f.kind === "tool" ? { ...f, index: f.index - drop } : f));
          }
          return { ...lane, tools, feed };
        }
        const tools = [...lane.tools];
        const index = findOpenCall(tools, event.callId, event.tool);
        if (index !== -1) {
          tools[index] = {
            ...tools[index],
            running: false,
            result: event.result,
            ok: event.ok,
          };
          return { ...lane, tools };
        }
        // An `end` without a `start` (reconnect, trimmed history): record it.
        tools.push({
          callId: event.callId,
          tool: event.tool,
          args: event.args,
          running: false,
          result: event.result,
          ok: event.ok,
          at: now,
        });
        return {
          ...lane,
          tools,
          feed: [...lane.feed, { kind: "tool", index: tools.length - 1 }],
        };
      });

    case "agent_done":
      return patchLane(run, event.agentId, now, (lane) => ({
        ...lane,
        status: event.error ? "failed" : "done",
        summary: event.summary,
        error: event.error,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        cost: event.cost,
        durationMs: event.durationMs,
        // A finished agent has no calls in flight.
        tools: lane.tools.map((t) => (t.running ? { ...t, running: false } : t)),
      }));

    case "file_change": {
      const record: FileChangeRecord = {
        id: ctx.nextId("chg"),
        agentId: event.agentId,
        kind: event.kind,
        path: event.path,
        previousPath: event.previousPath,
        before: event.before,
        after: event.after,
        summary: event.summary,
        adds: event.adds,
        removes: event.removes,
        at: now,
        reverted: false,
      };
      return {
        ...run,
        changes: [...run.changes, record],
        agents: run.agents.map((lane) =>
          lane.id === event.agentId && !lane.files.includes(event.path)
            ? { ...lane, files: [...lane.files, event.path] }
            : lane,
        ),
      };
    }

    case "command":
      return patchLane(run, event.agentId, now, (lane) => {
        const existing = lane.feed.findIndex(
          (f) => f.kind === "command" && f.sessionId === event.sessionId,
        );
        const item: FeedItem = {
          kind: "command",
          command: event.command,
          sessionId: event.sessionId,
          status: event.status,
          exitCode: event.exitCode,
        };
        if (existing === -1) return { ...lane, feed: [...lane.feed, item] };
        const feed = lane.feed.slice();
        feed[existing] = item;
        return { ...lane, feed };
      });

    case "approval_request": {
      if (run.approvals.some((a) => a.approvalId === event.approvalId)) return run;
      const title = event.title ?? event.command;
      const approval: ApprovalRequest = {
        approvalId: event.approvalId,
        agentId: event.agentId,
        kind: event.kind ?? "command",
        title,
        command: event.command ?? title,
        reason: event.reason,
        detail: event.detail ?? (event.command ? { command: event.command } : undefined),
        at: now,
      };
      const withApproval = { ...run, approvals: [...run.approvals, approval] };
      // Pin it into the agent's feed when we know the agent, so it renders
      // right where the tool call that needs it sits.
      if (run.agents.some((a) => a.id === event.agentId)) {
        return patchLane(withApproval, event.agentId, now, (lane) => ({
          ...lane,
          feed: [...lane.feed, { kind: "approval", approvalId: event.approvalId }],
        }));
      }
      return withApproval;
    }

    case "approval_resolved":
      return {
        ...run,
        approvals: run.approvals.map((a) =>
          a.approvalId === event.approvalId ? { ...a, resolution: event.decision } : a,
        ),
      };

    case "agent_retry": {
      const record: RetryRecord = {
        agentId: event.agentId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
        at: now,
      };
      return patchLane({ ...run, retries: [...run.retries, record] }, event.agentId, now, (lane) => ({
        ...lane,
        feed: [
          ...lane.feed,
          {
            kind: "retry",
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
            at: now,
          },
        ],
      }));
    }

    case "todos":
      return { ...run, todos: { ...run.todos, [event.agentId]: event.items } };

    case "compaction": {
      const record: CompactionRecord = {
        agentId: event.agentId,
        strategy: event.strategy,
        beforeTokens: event.beforeTokens,
        afterTokens: event.afterTokens,
        at: now,
      };
      return patchLane(
        { ...run, compactions: [...run.compactions, record] },
        event.agentId,
        now,
        (lane) => ({
          ...lane,
          feed: [
            ...lane.feed,
            {
              kind: "compaction",
              strategy: event.strategy,
              beforeTokens: event.beforeTokens,
              afterTokens: event.afterTokens,
            },
          ],
        }),
      );
    }

    case "diagnostics":
      return patchLane(run, event.agentId, now, (lane) => ({
        ...lane,
        feed: [
          ...lane.feed,
          {
            kind: "diagnostics",
            errorCount: event.errorCount,
            files: event.files,
            injected: event.injected,
          },
        ],
      }));

    case "hook":
      return patchLane(run, event.agentId, now, (lane) => ({
        ...lane,
        feed: [
          ...lane.feed,
          {
            kind: "hook",
            event: event.event,
            command: event.command,
            exitCode: event.exitCode,
            blocked: event.blocked,
            output: event.output,
          },
        ],
      }));

    case "memory":
      return run;

    case "ledger":
      return {
        ...run,
        ledger: event.ledger,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        tokensCached: event.tokensCached,
        costUsd: event.costUsd,
        uncachedUsd: event.uncachedUsd,
      };

    case "wave_start":
      return { ...run, currentWave: event.wave };

    case "wave_end":
      return run;

    case "run_done": {
      const status: RunStatus = event.status ?? (run.status === "failed" ? "failed" : "done");
      const done = event as typeof event & { metrics?: { phaseMs?: unknown }; phaseMs?: unknown };
      return {
        ...run,
        phaseTimings: mergePhaseMs(run.phaseTimings ?? [], done.metrics?.phaseMs ?? done.phaseMs),
        wallMs: typeof event.durationMs === "number" && event.durationMs > 0 ? event.durationMs : run.wallMs,
        status,
        summary: event.summary,
        costUsd: event.costUsd || run.costUsd,
        endedAt: now,
        // Nothing can still be pending once the run is over.
        approvals: run.approvals.map((a) =>
          a.resolution ? a : { ...a, resolution: status === "cancelled" ? "cancelled" : "timeout" },
        ),
        agents: run.agents.map((lane) =>
          lane.status === "running"
            ? { ...lane, status: status === "done" ? "done" : "failed" }
            : lane,
        ),
      };
    }

    case "error":
      return {
        ...run,
        status: event.fatal ? "failed" : run.status,
        error: event.message,
      };

    default:
      return run;
  }
}

/** Index of the in-flight call an `end` closes: by callId, else newest same-name. */
export function findOpenCall(
  tools: readonly ToolCallRecord[],
  callId: string | undefined,
  tool: string,
): number {
  if (callId) {
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      if (tools[i].callId === callId) return i;
    }
  }
  for (let i = tools.length - 1; i >= 0; i -= 1) {
    if (tools[i].tool === tool && tools[i].running) return i;
  }
  return -1;
}

/** Pending (unanswered) approvals, oldest first. */
export function pendingApprovals(run: RunState): ApprovalRequest[] {
  return run.approvals.filter((a) => !a.resolution);
}

/** The todo list to show for a run: the most recently updated agent's. */
export function activeTodos(run: RunState): TodoItem[] {
  const entries = Object.entries(run.todos);
  if (entries.length === 0) return [];
  if (entries.length === 1) return entries[0][1];
  // Prefer a running agent's list.
  const running = run.agents.find((a) => a.status === "running" && run.todos[a.id]);
  return running ? run.todos[running.id] : entries[entries.length - 1][1];
}

const VERDICTS: readonly CheckVerdict[] = ["fixes", "regression", "pre_existing", "still_failing", "pass"];

/** A check's outcome on one side, as a short string: `"pass"`, `"fail: ..."`, or `exit N`. */
function outcomeText(value: unknown): string | undefined {
  if (typeof value === "string") return value || undefined;
  if (typeof value === "boolean") return value ? "pass" : "fail";
  if (!value || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o.summary === "string" && o.summary) return o.summary;
  const passed = typeof o.passed === "number" ? o.passed : undefined;
  const failed = typeof o.failed === "number" ? o.failed : undefined;
  if (passed !== undefined || failed !== undefined) return `${passed ?? 0} passed · ${failed ?? 0} failed`;
  if (typeof o.exitCode === "number") return o.exitCode === 0 ? "pass" : `exit ${o.exitCode}`;
  if (o.timedOut === true) return "timed out";
  return undefined;
}

/**
 * Per-check verdicts. The gate may send them (`checks`); when it only sends
 * the `fixed` / `newFailures` name lists, derive the two verdicts those imply.
 */
export function normalizeChecks(raw: unknown, newFailures: string[], fixed: string[]): CheckRow[] {
  if (Array.isArray(raw)) {
    const rows: CheckRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const name = [r.name, r.command, r.id].find((v): v is string => typeof v === "string" && v.length > 0);
      const raw = String(r.verdict ?? "").replace("-", "_");
      const verdict = (raw === "passes" ? "pass" : raw) as CheckVerdict;
      if (!name || !VERDICTS.includes(verdict)) continue;
      rows.push({
        name,
        verdict,
        before: outcomeText(r.before ?? r.original),
        after: outcomeText(r.after ?? r.patched),
        excerpt: typeof r.excerpt === "string" ? r.excerpt : undefined,
      });
    }
    if (rows.length > 0) return rows;
  }
  return [
    ...fixed.map((name) => ({ name, verdict: "fixes" as const, before: "fail", after: "pass" })),
    ...newFailures.map((name) => ({ name, verdict: "regression" as const, before: "pass", after: "fail" })),
  ];
}

/* ------------------------------ fix runs ---------------------------------- */

export type PhaseState = "pending" | "active" | "done" | "failed";
export interface FixPhase {
  id: "localize" | "edit" | "verify" | "review";
  label: string;
  state: PhaseState;
}

function netChanged(run: RunState): number {
  return new Set(run.changes.filter((c) => !c.reverted).map((c) => c.path)).size;
}

/**
 * Where a fix run is: localize, edit, verify, review. Derived from the
 * events that already stream (edits, harness checks, gate rulings).
 */
export function fixPhases(run: RunState): FixPhase[] {
  const over = !(run.status === "planning" || run.status === "running");
  const lastGate = run.gates[run.gates.length - 1];
  const edited = run.changes.length > 0;
  const accepted = lastGate?.decision === "accept" || lastGate?.decision === "accept_unverified";
  const bad = run.status === "failed" || run.status === "incomplete" || lastGate?.decision === "give_up";
  const lastCheck = [...run.verifications].reverse().find((v) => v.phase !== "baseline");
  // A check that ran after the latest edit means the model is waiting on proof.
  const checkingLatest = Boolean(lastCheck && lastCheck.afterChanges === run.changes.length);

  const localize: PhaseState = edited || over ? "done" : "active";
  let edit: PhaseState = "pending";
  if (edited) edit = accepted || over || (checkingLatest && lastGate?.decision !== "reject") ? "done" : "active";
  let verify: PhaseState = "pending";
  if (accepted) verify = "done";
  else if (edited && over) verify = "failed";
  else if (edited && (checkingLatest || run.gates.length > 0)) verify = "active";
  let review: PhaseState = "pending";
  if (accepted) review = over ? (bad ? "failed" : "done") : "active";
  else if (over && edited && bad) review = "failed";
  return [
    { id: "localize", label: "Localize", state: localize },
    { id: "edit", label: "Edit", state: edit },
    { id: "verify", label: "Verify", state: verify },
    { id: "review", label: "Review", state: review },
  ];
}

export type EvidenceOutcome = "verified" | "unverified" | "no_patch" | "incomplete" | "failed";

export interface Evidence {
  outcome: EvidenceOutcome;
  reason: string;
  filesChanged: number;
  baseline?: VerificationRecord;
  final?: VerificationRecord;
  fixes: number;
  regressions: number;
  attempts: number;
  rejections: number;
  tokens: number;
  toolCalls: number;
  durationMs: number;
}

/** The end-of-run receipt for a fix: was the patch proven, and at what cost. */
export function evidenceOf(run: RunState): Evidence {
  const lastGate = run.gates[run.gates.length - 1];
  const baseline = run.verifications.find((v) => v.phase === "baseline");
  const final = [...run.verifications].reverse().find((v) => v.phase !== "baseline");
  const files = netChanged(run);
  let outcome: EvidenceOutcome;
  if (files === 0) outcome = "no_patch";
  else if (run.status === "failed" || run.status === "cancelled") outcome = "failed";
  else if (run.status === "incomplete" || lastGate?.decision === "give_up") outcome = "incomplete";
  else if (lastGate?.decision === "accept") outcome = "verified";
  else outcome = "unverified";
  const checks = final?.checks ?? [];
  return {
    outcome,
    reason: lastGate?.reason ?? run.error ?? "",
    filesChanged: files,
    baseline,
    final,
    fixes: checks.filter((c) => c.verdict === "fixes").length,
    regressions: checks.filter((c) => c.verdict === "regression").length,
    attempts: Math.max(1, ...run.agents.map((a) => a.attempt ?? 1)),
    rejections: run.gates.filter((g) => g.decision === "reject").length,
    tokens: run.tokensIn + run.tokensOut,
    toolCalls: run.agents.reduce((sum, a) => sum + a.tools.length, 0),
    durationMs: run.wallMs ?? (run.endedAt ?? run.startedAt) - run.startedAt,
  };
}

/* ----------------------------- localization ------------------------------ */

/**
 * `{ type: "localize", files: [{ path, score, why }], snippetReproduced? }`.
 * `why` may be a string or a list; `snippetRun.exitCode` stands in for
 * `snippetReproduced` (a snippet that errors on the original reproduces it).
 */
export function normalizeLocalization(raw: unknown): Localization | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const files: Localization["files"] = [];
  for (const item of Array.isArray(r.files) ? r.files : []) {
    if (typeof item === "string") {
      if (item) files.push({ path: item, score: 0, why: [] });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const f = item as Record<string, unknown>;
    if (typeof f.path !== "string" || !f.path) continue;
    const why = Array.isArray(f.why)
      ? f.why.filter((w): w is string => typeof w === "string" && w.length > 0)
      : typeof f.why === "string" && f.why
        ? [f.why]
        : [];
    files.push({ path: f.path, score: typeof f.score === "number" && Number.isFinite(f.score) ? f.score : 0, why });
  }
  let snippetReproduced = typeof r.snippetReproduced === "boolean" ? r.snippetReproduced : undefined;
  const snippet = r.snippetRun as { exitCode?: unknown } | undefined;
  if (snippetReproduced === undefined && snippet && typeof snippet === "object" && typeof snippet.exitCode === "number") {
    snippetReproduced = snippet.exitCode !== 0;
  }
  if (files.length === 0 && snippetReproduced === undefined) return null;
  return { files, snippetReproduced };
}

/** Why attempt `n` ran: the last ruling or intervention on the attempt before it. */
export function retryReasonOf(run: RunState, attempt: number): string {
  const prev = `Attempt ${attempt - 1}`;
  const gate = [...run.gates].reverse().find((g) => g.decision !== "accept" && g.decision !== "accept_unverified");
  if (gate?.reason) return `${prev} ended without proof: ${gate.reason}`;
  const recovery = run.recoveries[run.recoveries.length - 1];
  if (recovery?.detail) return `${prev} ended without proof after: ${recovery.detail}`;
  return `${prev} ended without proof.`;
}

/* ------------------- criteria, independent test, phases ------------------- */

/** `{ type: "criteria", items: string[] }`; blank or non-string items are dropped. */
export function normalizeCriteria(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const items = (raw as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  const out = items
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  return out.length > 0 ? out : null;
}

const TEST_STATUSES: readonly IndependentTest["status"][] = ["written", "ran", "skipped", "gave_up"];

/**
 * `{ type: "independent_test", status, command?, verdict?, seconds? }`.
 * `status` may arrive as "gave-up"; `before/after` (or `original/patched`)
 * are read when present, like the gate's per-check rows.
 */
export function normalizeIndependentTest(raw: unknown): IndependentTest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const status = String(r.status ?? "").replace("-", "_") as IndependentTest["status"];
  if (!TEST_STATUSES.includes(status)) return null;
  const verdictRaw = typeof r.verdict === "string" ? r.verdict.trim().replace("-", "_") : "";
  const verdict = verdictRaw === "passes" ? "pass" : verdictRaw || undefined;
  const seconds =
    typeof r.seconds === "number" && Number.isFinite(r.seconds) && r.seconds >= 0 ? r.seconds : undefined;
  const reason = [r.reason, r.detail].find((v): v is string => typeof v === "string" && v.length > 0);
  return {
    status,
    command: typeof r.command === "string" && r.command ? r.command : undefined,
    verdict,
    seconds,
    before: outcomeText(r.before ?? r.original),
    after: outcomeText(r.after ?? r.patched),
    reason,
  };
}

/** The original / patched outcome a verdict implies, when the producer sent none. */
export function impliedOutcomes(verdict: string | undefined): { before?: string; after?: string } {
  switch (verdict) {
    case "fixes":
      return { before: "fail", after: "pass" };
    case "still_failing":
    case "pre_existing":
      return { before: "fail", after: "fail" };
    case "regression":
      return { before: "pass", after: "fail" };
    case "pass":
      return { before: "pass", after: "pass" };
    default:
      return {};
  }
}

/** `{ type: "phase", name, ms }`; negative or non-finite ms are ignored. */
export function normalizePhase(raw: unknown): PhaseTiming | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const ms = typeof r.ms === "number" ? r.ms : Number.NaN;
  if (!name || !Number.isFinite(ms) || ms < 0) return null;
  return { name, ms: Math.round(ms) };
}

function addPhase(list: readonly PhaseTiming[], phase: PhaseTiming): PhaseTiming[] {
  const i = list.findIndex((p) => p.name === phase.name);
  if (i === -1) return [...list, phase];
  const next = list.slice();
  next[i] = { name: phase.name, ms: next[i].ms + phase.ms };
  return next;
}

/** Fill phases the stream never reported from `metrics.phaseMs`; streamed ones win. */
export function mergePhaseMs(list: readonly PhaseTiming[], phaseMs: unknown): PhaseTiming[] {
  const out = list.slice();
  if (!phaseMs || typeof phaseMs !== "object" || Array.isArray(phaseMs)) return out;
  for (const [name, ms] of Object.entries(phaseMs as Record<string, unknown>)) {
    if (out.some((p) => p.name === name)) continue;
    const phase = normalizePhase({ name, ms });
    if (phase) out.push(phase);
  }
  return out;
}

/** The solve pipeline's order; unknown phases follow in arrival order. */
export const PHASE_ORDER = ["setup", "localize", "criteria", "loop", "gate", "testWriter", "independentRun", "review", "deliver"] as const;

export interface PhaseStrip {
  segments: PhaseTiming[];
  /** Sum of phase ms. Setup phases overlap, so this can exceed the wall time. */
  sumMs: number;
  /** Server-reported wall time once done, else elapsed. */
  wallMs: number;
  /** Elapsed time no finished phase covers yet, while running. */
  liveMs: number;
}

export function phaseStrip(run: RunState, now: number): PhaseStrip {
  const list = run.phaseTimings ?? [];
  const rank = (name: string) => {
    const i = (PHASE_ORDER as readonly string[]).indexOf(name);
    return i === -1 ? PHASE_ORDER.length + list.findIndex((p) => p.name === name) : i;
  };
  const segments = list.filter((p) => p.ms > 0).sort((a, b) => rank(a.name) - rank(b.name));
  const sumMs = segments.reduce((sum, p) => sum + p.ms, 0);
  const active = run.status === "planning" || run.status === "running";
  const elapsed = Math.max(0, (active ? now : (run.endedAt ?? now)) - run.startedAt);
  const wallMs = !active && run.wallMs ? run.wallMs : elapsed;
  return { segments, sumMs, wallMs, liveMs: active ? Math.max(0, elapsed - sumMs) : 0 };
}

/**
 * Rendering window for a long list: the last `limit` items unless expanded,
 * so the run view never mounts thousands of rows at once.
 */
export function tailWindow<T>(
  items: readonly T[],
  limit: number,
  expanded: boolean,
): { shown: T[]; hidden: number; offset: number } {
  if (expanded || items.length <= limit) return { shown: items.slice(), hidden: 0, offset: 0 };
  const offset = items.length - limit;
  return { shown: items.slice(offset), hidden: offset, offset };
}

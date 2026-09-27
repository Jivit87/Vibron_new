/**
 * The orchestration event stream.
 *
 * Everything the UI renders — the plan, live agent output, file diffs,
 * terminal output, the token ledger — arrives as one ordered stream of these
 * events over SSE. Keeping a single typed union means the client has exactly
 * one place to handle protocol, and adding a capability is one variant here
 * plus one branch there.
 */

import type { LedgerSnapshot } from "@/lib/context/ledger";
import type { RoleId } from "@/lib/agents/roles";

export interface PlanStep {
  id: string;
  title: string;
  role: RoleId;
  detail: string;
  /** Files this step owns. Doubles as its exclusive write lock. */
  files: string[];
  dependsOn: string[];
}

export interface RunPlan {
  summary: string;
  steps: PlanStep[];
  /** Batches of step ids that can run concurrently, in execution order. */
  waves: string[][];
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export type ApprovalKind = "command" | "edit" | "mcp";
export type ApprovalDecision = "allow" | "deny" | "allow_always";
export type RunStatus = "done" | "failed" | "cancelled" | "incomplete";

/** How the harness classifies a failed tool call or verification, to pick a recovery. */
export type FailureClass =
  | "patch_conflict"
  | "missing_file"
  | "command_not_found"
  | "test_failure"
  | "regression"
  | "timeout"
  | "schema_error"
  | "refused"
  | "syntax_error"
  | "no_progress"
  /** A model turn was cut off by its output cap (see the runner's truncation recovery). */
  | "truncated"
  /** The reviewer flagged a high-severity problem in an accepted change. */
  | "review";

/** One gate check, compared on the original and the patched code. */
export interface VerificationCheckRow {
  /** The command, or a test id. */
  name: string;
  verdict: "fixes" | "regression" | "pre_existing" | "still_failing" | "pass";
  /** Short result summary on the original code. */
  before?: string;
  /** Short result summary on the patched code. */
  after?: string;
  excerpt?: string;
}

/** A rules file (AGENTS.md, CLAUDE.md, …) loaded into the prompt prefix. */
export interface LoadedRule {
  path: string;
  tokens: number;
}

export type OrchestrationEvent =
  /** Run accepted; tells the UI which mode and model are in play. */
  | {
      type: "run_start";
      runId: string;
      mode: "single" | "orchestrated" | "plan";
      model: string;
      at: number;
      /** Rules files folded into the system prompt for this run. */
      rules?: LoadedRule[];
    }
  /** A pre-run snapshot exists; the UI can offer a one-click restore. */
  | {
      type: "checkpoint";
      id: string;
      label: string;
      fileCount: number;
      /** "run" = store snapshot before the run; "edit_batch"/"best" = git tree snapshots. */
      kind?: "run" | "edit_batch" | "best";
      /** Git tree sha for tree snapshots. */
      ref?: string;
    }
  /** A test/typecheck run the harness performed itself, outside the model. */
  | {
      type: "verification";
      agentId: string;
      phase: "baseline" | "gate" | "final";
      command: string;
      exitCode: number | null;
      timedOut: boolean;
      passed: number;
      failed: number;
      /** Tests that passed in the baseline and no longer do. */
      newFailures: string[];
      /** Tests that failed in the baseline and pass now. */
      fixed: string[];
      durationMs: number;
      /** Extracted failure output, at most ~4k chars. */
      excerpt: string;
      /** One row per check the gate ran on the original vs the patched code. */
      checks?: VerificationCheckRow[];
    }
  /** The verification gate's ruling on the agent's attempt to finish. */
  | {
      type: "gate";
      agentId: string;
      decision: "accept" | "reject" | "accept_unverified" | "give_up";
      reason: string;
      attempt: number;
    }
  /** Zero-token localization at the start of a solve run: where the fix likely belongs. */
  | {
      type: "localize";
      files: { path: string; score: number; why: string[] }[];
      /** Whether the task's code snippet failed on the original code (absent when none ran). */
      snippetReproduced?: boolean;
    }
  /** Acceptance criteria predicted from the task before the solver starts (may be wrong). */
  | { type: "criteria"; items: string[] }
  /** The blind independent test writer: it never sees the patch. */
  | {
      type: "independent_test";
      status: "written" | "ran" | "skipped" | "gave_up";
      command?: string;
      verdict?: "fixes" | "passes" | "still_failing" | "regression" | "inconclusive";
      seconds?: number;
    }
  /** A harness phase ended (setup, localize, criteria, loop, gate, testWriter, review). */
  | { type: "phase"; name: string; ms: number }
  /** The harness intervened after a failure: a hint, a forced replan, or a rollback. */
  | {
      type: "recovery";
      agentId: string;
      failureClass: FailureClass;
      action: "hint" | "replan" | "rollback" | "restore_best";
      detail: string;
      checkpointId?: string;
    }
  /**
   * Prose destined for the chat bubble itself, streamed token by token.
   *
   * Distinct from `agent_text`, which belongs to a specialist's lane. When a
   * run is answering a question rather than building, the reply *is* the
   * output — it must land in the conversation, not inside a collapsed
   * progress row.
   */
  | { type: "answer"; text: string }
  /** How this run was routed, so the UI can label it honestly. */
  | { type: "intent"; intent: "ask" | "build"; reason: string }
  /** Orchestrator narration while it is deciding how to decompose. */
  | { type: "orchestrator_thinking"; text: string }
  | { type: "orchestrator_text"; text: string }
  /** `awaitingApproval` is true in plan mode: nothing runs until the user approves. */
  | { type: "plan"; plan: RunPlan; awaitingApproval?: boolean }
  /** A specialist has been dispatched. */
  | {
      type: "agent_start";
      agentId: string;
      stepId: string;
      role: RoleId;
      title: string;
      model: string;
      wave: number;
      /** 1-based solveTask attempt; attempt 2+ starts from a fresh context. */
      attempt?: number;
      /** Why this attempt started (attempt 2+: what the previous one lacked). */
      reason?: string;
    }
  | { type: "agent_thinking"; agentId: string; text: string }
  | { type: "agent_text"; agentId: string; text: string }
  | {
      type: "agent_tool";
      agentId: string;
      /** Pairs a `start` with its `end`; tool names repeat within a turn. */
      callId?: string;
      tool: string;
      /** Compact one-line rendering of the arguments. */
      args: string;
      phase: "start" | "end";
      /** Short preview of the result, on `end`. */
      result?: string;
      ok?: boolean;
    }
  | {
      type: "agent_done";
      agentId: string;
      summary: string;
      tokensIn: number;
      tokensOut: number;
      cost: number;
      durationMs: number;
      error?: string;
    }
  /** A file was created, changed, deleted, or moved. */
  | {
      type: "file_change";
      agentId: string;
      kind: "create" | "update" | "delete" | "rename";
      path: string;
      previousPath?: string;
      before: string | null;
      after: string | null;
      summary: string;
      adds: number;
      removes: number;
    }
  | {
      type: "command";
      agentId: string;
      command: string;
      sessionId: string;
      status: string;
      exitCode: number | null;
    }
  /** The agent wants to run something outside the auto-approve list. */
  | {
      type: "approval_request";
      approvalId: string;
      agentId: string;
      kind?: ApprovalKind;
      /** Command text, "Edit src/x.ts", or the MCP tool name. */
      title?: string;
      /** @deprecated Use `title`. Kept while older producers migrate. */
      command: string;
      reason: string;
      detail?: {
        command?: string;
        path?: string;
        before?: string | null;
        after?: string | null;
        args?: string;
      };
    }
  | {
      type: "approval_resolved";
      approvalId: string;
      decision: "allow" | "deny" | "timeout" | "cancelled";
    }
  /** Provider asked us to back off (429 / 529 / 5xx); the call will be retried. */
  | {
      type: "agent_retry";
      agentId: string;
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  /** Full todo list for an agent; replace, don't merge. */
  | { type: "todos"; agentId: string; items: TodoItem[] }
  /** Older history was shrunk to stay inside the context window. */
  | {
      type: "compaction";
      agentId: string;
      strategy: "elide" | "summarize";
      beforeTokens: number;
      afterTokens: number;
    }
  /** Post-edit typecheck/lint results fed back to the agent. */
  | {
      type: "diagnostics";
      agentId: string;
      errorCount: number;
      files: string[];
      injected: boolean;
    }
  /** A user-configured lifecycle hook ran. */
  | {
      type: "hook";
      agentId: string;
      event: "pre_tool" | "post_tool" | "stop";
      command: string;
      exitCode: number | null;
      blocked: boolean;
      output: string;
    }
  | { type: "memory"; kind: string; text: string }
  /** Live token/cost accounting, emitted after every agent turn. */
  | {
      type: "ledger";
      ledger: LedgerSnapshot;
      tokensIn: number;
      tokensOut: number;
      tokensCached: number;
      costUsd: number;
      uncachedUsd: number;
    }
  | { type: "wave_start"; wave: number; stepIds: string[] }
  | { type: "wave_end"; wave: number }
  | {
      type: "run_done";
      /** Absent from older producers; treat as "done". */
      status?: RunStatus;
      summary: string;
      filesChanged: number;
      durationMs: number;
      costUsd: number;
    }
  | { type: "error"; message: string; fatal: boolean };

export type EventSink = (event: OrchestrationEvent) => void;

/** Topologically batch steps into waves of mutually independent work. */
export function computeWaves(steps: PlanStep[]): string[][] {
  const byId = new Map(steps.map((s) => [s.id, s] as const));
  const done = new Set<string>();
  const waves: string[][] = [];
  let remaining = steps.filter((s) => byId.has(s.id));

  while (remaining.length > 0) {
    const ready = remaining.filter((step) =>
      step.dependsOn.every((dep) => done.has(dep) || !byId.has(dep)),
    );

    if (ready.length === 0) {
      // A dependency cycle, or a reference to a step that does not exist.
      // Rather than deadlock, flush everything left as one final wave —
      // a degraded plan still beats a hung run.
      waves.push(remaining.map((s) => s.id));
      break;
    }

    waves.push(ready.map((s) => s.id));
    for (const step of ready) done.add(step.id);
    remaining = remaining.filter((s) => !done.has(s.id));
  }

  return waves;
}

/** Line-level add/remove counts for the diff trace. */
export function countLineDiff(
  before: string | null,
  after: string | null,
): { adds: number; removes: number } {
  const a = before ?? "";
  const b = after ?? "";
  const countBy = (text: string) => {
    const map = new Map<string, number>();
    if (!text) return map;
    for (const line of text.split("\n")) {
      map.set(line, (map.get(line) ?? 0) + 1);
    }
    return map;
  };
  const aMap = countBy(a);
  const bMap = countBy(b);
  let adds = 0;
  let removes = 0;
  for (const [line, count] of bMap) {
    const prev = aMap.get(line) ?? 0;
    if (count > prev) adds += count - prev;
  }
  for (const [line, count] of aMap) {
    const next = bMap.get(line) ?? 0;
    if (count > next) removes += count - next;
  }
  return { adds, removes };
}

"use client";

/**
 * The live run view.
 *
 * A run reads top to bottom the way it happened: a one-line header, the
 * todo checklist, the plan, then each agent's feed (prose, tool rows,
 * retries, compaction, approvals) in chronological order, then the files
 * it changed. Dense rows, no cards; the only boxed elements are the things
 * that need a decision (approvals, plan review).
 */

import { useEffect, useMemo, useState } from "react";
import {
  Ban,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Loader2,
  Minus,
  Plus,
  RotateCcw,
  Square,
  SquareCheck,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { PlanStep, RunPlan, TodoItem } from "@/lib/agents/events";
import { answerApproval, refreshWorkspace, runPlan } from "@/lib/client/agent-stream";
import { diffLines, withContext } from "@/lib/client/line-diff";
import { addStep, moveStep, removeStep, updateStep } from "@/lib/client/plan-edit";
import { activeTodos, tailWindow, type FeedItem } from "@/lib/client/run-reducer";
import { contextFill, formatTok, formatUsd, runTotals, totalTokens } from "@/lib/client/usage";
import { ContextMeter, fillTitle } from "@/components/vibe/usage-ui";
import { LiveUsagePanel } from "@/components/vibe/LiveUsage";
import {
  AttemptSeparator,
  CriteriaBlock,
  EvidenceSummary,
  FixPhases,
  GateRow,
  LocalizationBlock,
  PhaseTimingStrip,
  RecoveryRow,
  VerificationBlock,
  VerificationRow,
} from "@/components/vibe/FixRun";
import { canDeliver, DeliverBar } from "@/components/vibe/DeliverBar";
import { pendingReviews } from "@/lib/editor/review";
import { useUsageStore } from "@/store/usage";
import {
  useViberon,
  type AgentLane,
  type ApprovalRequest,
  type FileChangeRecord,
  type RunState,
  type ToolCallRecord,
} from "@/store/viberon";
import {
  cx,
  DiffCounts,
  Dot,
  formatDuration,
  formatTokens,
  RoleChip,
  splitPath,
} from "@/components/vibe/primitives";

export function AgentRunView({ run }: { run: RunState }) {
  const active = run.status === "planning" || run.status === "running";
  useLiveClock(active);
  const todos = activeTodos(run);
  const solo = run.agents.length <= 1 && !run.plan;
  const fix = run.interaction === "fix";
  const checked = run.verifications.length > 0 || run.gates.length > 0;
  const orphanApprovals = run.approvals.filter(
    (a) => !run.agents.some((lane) => lane.id === a.agentId),
  );

  return (
    <div className="flex flex-col gap-2">
      <RunHeader run={run} />

      <LiveUsagePanel run={run} />

      {fix && <FixPhases run={run} />}

      {fix && <PhaseTimingStrip run={run} />}

      {fix && <LocalizationBlock run={run} />}

      {fix && <CriteriaBlock run={run} />}

      {todos.length > 0 && <TodoList items={todos} />}

      {run.status === "planning" && !run.plan && (run.orchestratorText || run.orchestratorThinking) && (
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--vb-text-dim)" }}>
          {(run.orchestratorText || run.orchestratorThinking).trim().slice(-280)}
        </p>
      )}

      {run.plan && run.planAwaitingApproval ? (
        <PlanReview run={run} plan={run.plan} />
      ) : run.plan ? (
        <PlanSummary run={run} />
      ) : null}

      {!run.planAwaitingApproval &&
        (fix ? (
          // Attempts read as one continuous trace, split by a separator.
          <div className="flex flex-col">
            {run.agents.map((lane) => (
              <div key={lane.id} className="flex flex-col">
                {(lane.attempt ?? 1) > 1 && <AttemptSeparator attempt={lane.attempt ?? 1} reason={lane.retryReason} />}
                <Feed lane={lane} run={run} />
              </div>
            ))}
          </div>
        ) : solo ? (
          run.agents[0] && <Feed lane={run.agents[0]} run={run} />
        ) : (
          <div className="flex flex-col">
            {run.agents.map((lane) => (
              <LaneSection key={lane.id} lane={lane} run={run} />
            ))}
          </div>
        ))}

      {orphanApprovals.map((approval) => (
        <ApprovalCard key={approval.approvalId} approval={approval} />
      ))}

      {checked && <VerificationBlock run={run} />}

      {run.changes.length > 0 && <ChangeList run={run} />}

      {fix && !active && <EvidenceSummary run={run} />}

      {fix && canDeliver(run) && <DeliverBar run={run} />}

      {run.error && (
        <div
          className="flex items-start gap-2 border-l-2 py-1 pl-2 text-[12px]"
          style={{ borderColor: "var(--vb-rose)", color: "var(--vb-text)" }}
        >
          <span className="whitespace-pre-wrap leading-relaxed">{run.error}</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ header ----------------------------------- */

const STATUS_LABEL: Record<RunState["status"], string> = {
  planning: "Planning",
  running: "Working",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
  incomplete: "Incomplete",
};

function RunHeader({ run }: { run: RunState }) {
  // The server's wall time wins once the run is over (a reattached task started before this view).
  const elapsed = run.endedAt && run.wallMs ? run.wallMs : (run.endedAt ?? Date.now()) - run.startedAt;
  const label = run.planAwaitingApproval && run.status === "done" ? "Plan ready" : STATUS_LABEL[run.status];
  const rulesTitle = run.rules.map((r) => `${r.path} (${r.tokens} tok)`).join("\n");
  return (
    <div
      className="flex h-6 items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[11px]"
      style={{ color: "var(--vb-text-dim)" }}
    >
      <RunStatusIcon status={run.status} />
      <span style={{ color: statusColor(run.status) }}>{label}</span>
      <span>{formatDuration(Math.max(0, elapsed))}</span>
      {run.model && run.model !== "auto" && <span className="min-w-0 truncate">{run.model}</span>}
      <div className="flex-1" />
      {run.rules.length > 0 && (
        <span title={rulesTitle} className="cursor-default">
          {run.rules.length} rule{run.rules.length === 1 ? "" : "s"}
        </span>
      )}
      <RunUsage run={run} />
    </div>
  );
}

/** Tokens, cost, and the context-window meter; opens the usage panel. */
function RunUsage({ run }: { run: RunState }) {
  const extra = useUsageStore((s) => s.live[run.id]);
  const totals = runTotals(run, extra);
  const tokens = totalTokens(totals);
  if (tokens === 0 && totals.costUsd === 0) return null;
  const last = extra?.turns.at(-1);
  const fill = last ? contextFill(last.contextTokens, last.model) : null;
  const detail = [
    `${formatTok(totals.input)} input`,
    `${formatTok(totals.cacheRead)} cache read`,
    totals.cacheWrite > 0 ? `${formatTok(totals.cacheWrite)} cache write` : "",
    `${formatTok(totals.output)} output`,
    fill && last ? fillTitle(fill, last.model) : "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <button
      type="button"
      title={`${detail}\nOpen the usage panel`}
      onClick={() => {
        const store = useViberon.getState();
        useUsageStore.getState().setScope("run");
        store.setAppMode("ide");
        store.setBottomPanel("ledger");
      }}
      className="flex h-5 items-center gap-2 rounded-[3px] px-1 tabular-nums hover:bg-[var(--vb-hover)]"
      style={{ color: "var(--vb-text-dim)" }}
    >
      <span>{formatTok(tokens)} tok</span>
      {totals.costUsd > 0 && <span>{formatUsd(totals.costUsd)}</span>}
      {fill && <ContextMeter fill={fill} width={24} />}
    </button>
  );
}

function statusColor(status: RunState["status"]): string {
  if (status === "failed") return "var(--vb-rose)";
  if (status === "incomplete") return "var(--vb-amber)";
  if (status === "cancelled") return "var(--vb-text-mid)";
  if (status === "done") return "var(--vb-text-mid)";
  return "var(--vb-text-hi)";
}

function RunStatusIcon({ status }: { status: RunState["status"] }) {
  if (status === "planning" || status === "running")
    return <Loader2 className="size-3.5 animate-spin" style={{ color: "var(--vb-text-mid)" }} />;
  if (status === "failed") return <X className="size-3.5" style={{ color: "var(--vb-rose)" }} />;
  if (status === "cancelled") return <Square className="size-3" style={{ color: "var(--vb-text-dim)" }} />;
  if (status === "incomplete") return <Minus className="size-3.5" style={{ color: "var(--vb-amber)" }} />;
  return <Check className="size-3.5" style={{ color: "var(--vb-mint)" }} />;
}

/* ------------------------------- todos ----------------------------------- */

function TodoList({ items }: { items: TodoItem[] }) {
  const done = items.filter((t) => t.status === "completed").length;
  return (
    <div className="flex flex-col border-y py-1" style={{ borderColor: "var(--vb-line)" }}>
      <div className="flex h-5 items-center gap-2 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
        <span>Todos</span>
        <span className="font-mono">
          {done}/{items.length}
        </span>
      </div>
      {items.slice(0, LIST_CAP).map((item) => (
        <div key={item.id} className="flex min-h-[22px] items-center gap-2 text-[12.5px]">
          {item.status === "completed" ? (
            <SquareCheck className="size-3.5 shrink-0" style={{ color: "var(--vb-text-dim)" }} />
          ) : item.status === "in_progress" ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin" style={{ color: "var(--vb-accent)" }} />
          ) : item.status === "cancelled" ? (
            <Ban className="size-3.5 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          ) : (
            <Square className="size-3.5 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          )}
          <span
            className={cx(item.status === "completed" && "line-through")}
            style={{
              color:
                item.status === "completed" || item.status === "cancelled"
                  ? "var(--vb-text-dim)"
                  : item.status === "in_progress"
                    ? "var(--vb-text-hi)"
                    : "var(--vb-text)",
            }}
          >
            {item.content}
            {item.status === "cancelled" && (
              <span className="ml-1.5 text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                cancelled
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------- plan ----------------------------------- */

function StepStatus({ status }: { status: AgentLane["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 shrink-0 animate-spin" style={{ color: "var(--vb-accent)" }} />;
    case "done":
      return <Check className="size-3.5 shrink-0" style={{ color: "var(--vb-mint)" }} />;
    case "failed":
      return <X className="size-3.5 shrink-0" style={{ color: "var(--vb-rose)" }} />;
    default:
      return <Circle className="size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />;
  }
}

function PlanSummary({ run }: { run: RunState }) {
  const [open, setOpen] = useState(false);
  const plan = run.plan!;
  const done = run.agents.filter((a) => a.status === "done").length;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-6 items-center gap-1.5 text-left text-[12px]"
        style={{ color: "var(--vb-text-mid)" }}
      >
        <ChevronRight className={cx("size-3.5", open && "rotate-90")} />
        <span style={{ color: "var(--vb-text)" }}>Plan</span>
        <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          {done}/{plan.steps.length} steps, {plan.waves.length} wave{plan.waves.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col pl-5">
          {plan.summary && (
            <p className="pb-1 text-[12px] leading-relaxed" style={{ color: "var(--vb-text-dim)" }}>
              {plan.summary}
            </p>
          )}
          {plan.steps.map((step, index) => {
            const lane = run.agents.find((a) => a.id === step.id);
            return (
              <div key={step.id} className="flex min-h-[22px] items-center gap-2 text-[12px]">
                <StepStatus status={lane?.status ?? "queued"} />
                <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                  {index + 1}
                </span>
                <span className="truncate" style={{ color: "var(--vb-text)" }}>
                  {step.title}
                </span>
                <RoleChip role={step.role} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Plan mode: an editable step list and a Run button that re-POSTs it. */
function PlanReview({ run, plan: initial }: { run: RunState; plan: RunPlan }) {
  const streaming = useViberon((s) => s.streaming);
  const [plan, setPlan] = useState(initial);
  useEffect(() => setPlan(initial), [initial]);

  const canRun = !streaming && run.status !== "planning" && plan.steps.length > 0;

  return (
    <div className="vb-box flex flex-col">
      <div
        className="flex h-7 items-center gap-2 border-b px-2.5 text-[12px]"
        style={{ borderColor: "var(--vb-line)" }}
      >
        <span style={{ color: "var(--vb-text-hi)" }}>Review plan</span>
        <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          {plan.steps.length} steps, {plan.waves.length} waves
        </span>
      </div>
      {plan.summary && (
        <p className="px-2.5 pt-2 text-[12px] leading-relaxed" style={{ color: "var(--vb-text-mid)" }}>
          {plan.summary}
        </p>
      )}
      <ol className="flex flex-col py-1">
        {plan.steps.map((step, index) => (
          <PlanStepRow
            key={step.id}
            step={step}
            index={index}
            wave={plan.waves.findIndex((w) => w.includes(step.id))}
            first={index === 0}
            last={index === plan.steps.length - 1}
            onChange={(patch) => setPlan((p) => updateStep(p, step.id, patch))}
            onMove={(delta) => setPlan((p) => moveStep(p, step.id, delta))}
            onRemove={() => setPlan((p) => removeStep(p, step.id))}
          />
        ))}
      </ol>
      <div
        className="flex items-center gap-1.5 border-t px-2 py-1.5"
        style={{ borderColor: "var(--vb-line)" }}
      >
        <button
          type="button"
          className="vb-btn vb-btn-ghost"
          onClick={() => setPlan((p) => addStep(p, "New step"))}
        >
          <Plus className="size-3.5" />
          Add step
        </button>
        <div className="flex-1" />
        {plan !== initial && (
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => setPlan(initial)}>
            Reset
          </button>
        )}
        <button
          type="button"
          className="vb-btn vb-btn-primary"
          disabled={!canRun}
          onClick={() => void runPlan(plan, run.prompt)}
          title="Execute these steps"
        >
          Run plan
        </button>
      </div>
    </div>
  );
}

function PlanStepRow({
  step,
  index,
  wave,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  step: PlanStep;
  index: number;
  wave: number;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<PlanStep>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="group flex flex-col px-1.5">
      <div className="flex min-h-[26px] items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? "Hide details" : "Show details"}
          className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)]"
          style={{ color: "var(--vb-text-dim)" }}
        >
          <ChevronRight className={cx("size-3.5", open && "rotate-90")} />
        </button>
        <span className="w-4 text-right font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {index + 1}
        </span>
        <input
          value={step.title}
          onChange={(e) => onChange({ title: e.target.value })}
          aria-label={`Step ${index + 1} title`}
          className="h-[22px] min-w-0 flex-1 rounded-[3px] border border-transparent bg-transparent px-1 text-[12.5px] outline-none hover:border-[var(--vb-line)] focus:border-[var(--vb-accent-line)]"
          style={{ color: "var(--vb-text-hi)" }}
        />
        <RoleChip role={step.role} />
        <span className="w-6 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }} title="Wave">
          w{wave + 1}
        </span>
        <span className="flex items-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
          <MiniButton title="Move up" disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp className="size-3" />
          </MiniButton>
          <MiniButton title="Move down" disabled={last} onClick={() => onMove(1)}>
            <ArrowDown className="size-3" />
          </MiniButton>
          <MiniButton title="Remove step" onClick={onRemove}>
            <Trash2 className="size-3" />
          </MiniButton>
        </span>
      </div>
      {open && (
        <div className="flex flex-col gap-1 pb-1.5 pl-[46px] pr-1">
          <textarea
            value={step.detail}
            onChange={(e) => onChange({ detail: e.target.value })}
            rows={2}
            aria-label="Step detail"
            className="w-full resize-y rounded-[3px] border px-1.5 py-1 text-[12px] outline-none focus:border-[var(--vb-accent-line)]"
            style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-input)", color: "var(--vb-text)" }}
          />
          <input
            value={step.files.join(", ")}
            onChange={(e) =>
              onChange({
                files: e.target.value
                  .split(",")
                  .map((f) => f.trim())
                  .filter(Boolean),
              })
            }
            placeholder="Files this step owns, comma-separated"
            aria-label="Step files"
            className="vb-input w-full font-mono text-[11.5px]"
          />
        </div>
      )}
    </li>
  );
}

function MiniButton({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)] disabled:opacity-30"
      style={{ color: "var(--vb-text-dim)" }}
    >
      {children}
    </button>
  );
}

/* ------------------------------- lanes ----------------------------------- */

function LaneSection({ lane, run }: { lane: AgentLane; run: RunState }) {
  const running = lane.status === "running";
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? (running || lane.status === "failed");
  const current = [...lane.tools].reverse().find((t) => t.running);

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        disabled={lane.status === "queued"}
        className="flex h-[26px] items-center gap-2 rounded-[3px] px-1 text-left hover:bg-[var(--vb-hover)] disabled:hover:bg-transparent"
      >
        <StepStatus status={lane.status} />
        <span
          className="min-w-0 truncate text-[12.5px]"
          style={{ color: lane.status === "queued" ? "var(--vb-text-dim)" : "var(--vb-text-hi)" }}
        >
          {lane.title}
        </span>
        <RoleChip role={lane.role} />
        {running && current && (
          <span className="min-w-0 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            {current.tool}
          </span>
        )}
        <div className="flex-1" />
        {lane.files.length > 0 && lane.status !== "queued" && (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {lane.files.length} file{lane.files.length === 1 ? "" : "s"}
          </span>
        )}
        {lane.durationMs !== undefined && (
          <span className="shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {formatDuration(lane.durationMs)}
          </span>
        )}
        {lane.status !== "queued" && (
          <ChevronRight
            className={cx("size-3.5 shrink-0", expanded && "rotate-90")}
            style={{ color: "var(--vb-text-faint)" }}
          />
        )}
      </button>
      {expanded && lane.status !== "queued" && (
        <div className="ml-[11px] border-l pb-1 pl-3" style={{ borderColor: "var(--vb-line)" }}>
          <Feed lane={lane} run={run} />
        </div>
      )}
    </div>
  );
}

const FEED_WINDOW = 250;
const LIST_CAP = 300;

/** One agent's work, in the order it happened. */
function Feed({ lane, run }: { lane: AgentLane; run: RunState }) {
  const showThinking = useViberon((s) => s.settings.showThinking);
  const running = lane.status === "running";
  const [expanded, setExpanded] = useState(false);
  // Long runs produce thousands of rows; mount only the recent tail by default.
  const { shown, hidden, offset } = tailWindow(lane.feed, FEED_WINDOW, expanded);
  return (
    <div className="flex flex-col gap-0.5 py-0.5">
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-[22px] items-center self-start text-[11.5px] hover:text-[var(--vb-text)]"
          style={{ color: "var(--vb-text-dim)" }}
        >
          Show {hidden} earlier row{hidden === 1 ? "" : "s"}
        </button>
      )}
      {shown.map((item, i) => (
        <FeedRow
          key={offset + i}
          item={item}
          lane={lane}
          run={run}
          last={offset + i === lane.feed.length - 1}
          live={running}
          showThinking={showThinking}
        />
      ))}
      {lane.summary && lane.status === "done" && !lane.feed.some((f) => f.kind === "text") && (
        <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--vb-text)" }}>
          {lane.summary}
        </p>
      )}
      {lane.error && (
        <p className="text-[12px]" style={{ color: "var(--vb-rose)" }}>
          {lane.error}
        </p>
      )}
    </div>
  );
}

function FeedRow({
  item,
  lane,
  run,
  last,
  live,
  showThinking,
}: {
  item: FeedItem;
  lane: AgentLane;
  run: RunState;
  last: boolean;
  live: boolean;
  showThinking: boolean;
}) {
  switch (item.kind) {
    case "text":
      return (
        <p
          className={cx("whitespace-pre-wrap py-0.5 text-[12.5px] leading-relaxed", last && live && "vb-caret")}
          style={{ color: "var(--vb-text)" }}
        >
          {item.text.trim()}
        </p>
      );
    case "thinking":
      return showThinking ? <ThinkingRow text={item.text} live={last && live} /> : null;
    case "tool": {
      const record = lane.tools[item.index];
      return record ? <ToolRow record={record} /> : null;
    }
    case "retry":
      return (
        <div className="flex h-[22px] items-center gap-2 overflow-hidden whitespace-nowrap text-[12px]" style={{ color: "var(--vb-amber)" }}>
          <RotateCcw className="size-3.5 shrink-0" />
          <span>
            Retrying {item.attempt}/{item.maxAttempts} in {formatDuration(item.delayMs)}
          </span>
          <span className="truncate" style={{ color: "var(--vb-text-dim)" }}>
            {item.reason}
          </span>
        </div>
      );
    case "compaction":
      return (
        <div className="flex h-[22px] items-center gap-2 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          <span className="h-px flex-1" style={{ background: "var(--vb-line)" }} />
          <span className="font-mono">
            context compacted {formatTokens(item.beforeTokens)} to {formatTokens(item.afterTokens)} (
            {item.strategy})
          </span>
          <span className="h-px flex-1" style={{ background: "var(--vb-line)" }} />
        </div>
      );
    case "diagnostics":
      return (
        <div className="flex h-[22px] items-center gap-2 overflow-hidden whitespace-nowrap text-[12px]" style={{ color: "var(--vb-text-mid)" }}>
          <Dot color={item.errorCount > 0 ? "var(--vb-rose)" : "var(--vb-mint)"} size={6} />
          <span>
            {item.errorCount === 0
              ? "Typecheck clean"
              : `${item.errorCount} error${item.errorCount === 1 ? "" : "s"} after edit`}
          </span>
          <span className="truncate font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            {item.files.join(", ")}
          </span>
          {item.injected && item.errorCount > 0 && (
            <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              sent to agent
            </span>
          )}
        </div>
      );
    case "hook":
      return (
        <div
          className="flex h-[22px] items-center gap-2 overflow-hidden whitespace-nowrap font-mono text-[11.5px]"
          style={{ color: item.blocked ? "var(--vb-amber)" : "var(--vb-text-dim)" }}
          title={item.output}
        >
          <span>hook {item.event}</span>
          <span className="truncate">{item.command}</span>
          <span>{item.blocked ? "blocked" : `exit ${item.exitCode ?? "?"}`}</span>
        </div>
      );
    case "verification": {
      const record = run.verifications[item.index];
      return record ? <VerificationRow record={record} /> : null;
    }
    case "gate": {
      const record = run.gates[item.index];
      return record ? <GateRow record={record} /> : null;
    }
    case "recovery": {
      const record = run.recoveries[item.index];
      return record ? <RecoveryRow record={record} /> : null;
    }
    case "approval": {
      const approval = run.approvals.find((a) => a.approvalId === item.approvalId);
      return approval ? <ApprovalCard approval={approval} /> : null;
    }
    case "command":
      return (
        <button
          type="button"
          onClick={() => {
            const store = useViberon.getState();
            store.setAppMode("ide");
            store.setActiveTerminal(item.sessionId);
            store.setBottomPanel("terminal");
          }}
          className="flex h-[22px] items-center gap-2 rounded-[3px] text-left font-mono text-[11.5px] hover:bg-[var(--vb-hover)]"
          title="Show in terminal"
        >
          <span style={{ color: "var(--vb-text-dim)" }}>$</span>
          <span className="truncate" style={{ color: "var(--vb-text)" }}>
            {item.command}
          </span>
          <span
            style={{
              color:
                item.status === "running"
                  ? "var(--vb-text-dim)"
                  : item.exitCode === 0
                    ? "var(--vb-text-dim)"
                    : "var(--vb-rose)",
            }}
          >
            {item.status === "running" ? "running" : `exit ${item.exitCode ?? "?"}`}
          </span>
        </button>
      );
  }
}

function ThinkingRow({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[22px] items-center gap-1.5 text-left text-[12px]"
        style={{ color: "var(--vb-text-dim)" }}
      >
        <ChevronRight className={cx("size-3.5", open && "rotate-90")} />
        <span>{live ? "Thinking" : "Thought"}</span>
        {!open && (
          <span className="min-w-0 truncate italic" style={{ color: "var(--vb-text-faint)" }}>
            {text.trim().slice(-120)}
          </span>
        )}
      </button>
      {open && (
        <p
          className="whitespace-pre-wrap border-l pl-3 text-[12px] italic leading-relaxed"
          style={{ borderColor: "var(--vb-line)", color: "var(--vb-text-dim)" }}
        >
          {text.trim()}
        </p>
      )}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  rename_file: "Rename",
  delete_file: "Delete",
  list_files: "List",
  search: "Search",
  grep: "Grep",
  run_command: "Run",
  todo_write: "Todos",
};

function ToolRow({ record }: { record: ToolCallRecord }) {
  const [open, setOpen] = useState(false);
  const failed = record.ok === false;
  const label = TOOL_LABELS[record.tool] ?? record.tool;
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => record.result && setOpen((v) => !v)}
        className={cx(
          "flex h-[22px] min-w-0 items-center gap-2 rounded-[3px] text-left text-[12px]",
          record.result && "hover:bg-[var(--vb-hover)]",
        )}
        title={record.args}
      >
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {record.running ? (
            <Loader2 className="size-3 animate-spin" style={{ color: "var(--vb-text-dim)" }} />
          ) : failed ? (
            <X className="size-3.5" style={{ color: "var(--vb-rose)" }} />
          ) : (
            <Minus className="size-3" style={{ color: "var(--vb-text-faint)" }} />
          )}
        </span>
        <span className="shrink-0" style={{ color: "var(--vb-text-mid)" }}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          {record.args}
        </span>
        {record.result && !record.running && (
          <span
            className="hidden max-w-[40%] shrink-0 truncate text-[11.5px] sm:inline"
            style={{ color: failed ? "var(--vb-rose)" : "var(--vb-text-faint)" }}
          >
            {record.result}
          </span>
        )}
      </button>
      {open && record.result && (
        <pre
          className="mb-1 ml-[22px] max-h-40 overflow-auto rounded-[3px] border px-2 py-1 font-mono text-[11.5px] whitespace-pre-wrap"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-mid)" }}
        >
          {record.result}
        </pre>
      )}
    </div>
  );
}

/* ----------------------------- approvals ---------------------------------- */

function ApprovalCard({ approval }: { approval: ApprovalRequest }) {
  const resolved = approval.resolution;
  if (resolved) {
    const verb =
      resolved === "allow"
        ? "Allowed"
        : resolved === "deny"
          ? "Denied"
          : resolved === "timeout"
            ? "Timed out"
            : "Cancelled";
    return (
      <div className="flex h-[22px] items-center gap-2 overflow-hidden whitespace-nowrap text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
        {resolved === "allow" ? (
          <Check className="size-3.5 shrink-0" />
        ) : (
          <X className="size-3.5 shrink-0" />
        )}
        <span>{verb}</span>
        <span className="truncate font-mono text-[11.5px]">{approval.title}</span>
      </div>
    );
  }

  const isEdit = approval.kind === "edit";
  const heading = isEdit ? "Apply this edit?" : approval.kind === "mcp" ? "Call this tool?" : "Run this command?";

  return (
    <div
      className="vb-in my-1 flex flex-col border-l-2 pl-2.5"
      style={{ borderColor: "var(--vb-amber)" }}
      role="alertdialog"
      aria-label={heading}
    >
      <div className="flex min-h-[22px] items-center gap-2 text-[12.5px]">
        <span style={{ color: "var(--vb-text-hi)" }}>{heading}</span>
        <span className="truncate text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
          {approval.reason}
        </span>
      </div>
      {isEdit && approval.detail ? (
        <MiniDiff
          path={approval.detail.path ?? approval.title}
          before={approval.detail.before ?? null}
          after={approval.detail.after ?? null}
        />
      ) : (
        <code
          className="my-1 block overflow-x-auto rounded-[3px] border px-2 py-1 font-mono text-[12px]"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-hi)" }}
        >
          {approval.kind === "mcp" ? approval.title : `$ ${approval.detail?.command ?? approval.command}`}
          {approval.detail?.args && (
            <span style={{ color: "var(--vb-text-dim)" }}> {approval.detail.args}</span>
          )}
        </code>
      )}
      <div className="flex items-center gap-1.5 py-1">
        <button
          type="button"
          className="vb-btn vb-btn-primary"
          onClick={() => void answerApproval(approval.approvalId, "allow")}
        >
          {isEdit ? "Apply" : "Allow"}
        </button>
        {!isEdit && (
          <button
            type="button"
            className="vb-btn"
            title="Allow this and identical requests for the rest of the session"
            onClick={() => void answerApproval(approval.approvalId, "allow_always")}
          >
            Always allow
          </button>
        )}
        <button
          type="button"
          className="vb-btn vb-btn-ghost"
          onClick={() => void answerApproval(approval.approvalId, "deny")}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function MiniDiff({ path, before, after }: { path: string; before: string | null; after: string | null }) {
  const lines = useMemo(() => withContext(diffLines(before, after), 2).slice(0, 60), [before, after]);
  return (
    <div className="my-1 overflow-hidden rounded-[3px] border" style={{ borderColor: "var(--vb-line)" }}>
      <div
        className="flex h-[22px] items-center border-b px-2 font-mono text-[11.5px]"
        style={{ borderColor: "var(--vb-line)", color: "var(--vb-text-mid)" }}
      >
        {path}
      </div>
      <div className="max-h-56 overflow-auto py-0.5 font-mono text-[11.5px] leading-[18px]" style={{ background: "var(--vb-bg-void)" }}>
        {lines.map((line, i) =>
          line.kind === "gap" ? (
            <div key={i} className="px-2" style={{ color: "var(--vb-text-faint)" }}>
              ⋯ {line.hidden} unchanged
            </div>
          ) : (
            <div
              key={i}
              className="whitespace-pre px-2"
              style={{
                background:
                  line.kind === "add" ? "var(--vb-add-bg)" : line.kind === "del" ? "var(--vb-del-bg)" : undefined,
                color:
                  line.kind === "add" ? "var(--vb-add)" : line.kind === "del" ? "var(--vb-del)" : "var(--vb-text-dim)",
              }}
            >
              {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
              {line.text}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/* ---------------------------- file changes -------------------------------- */

function ChangeList({ run }: { run: RunState }) {
  const repoKey = useViberon((s) => s.repoKey);
  const decisions = useViberon((s) => s.reviewDecisions);
  const streaming = useViberon((s) => s.streaming);
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => {
    const byPath = new Map<string, FileChangeRecord & { count: number }>();
    for (const change of run.changes) {
      const existing = byPath.get(change.path);
      byPath.set(
        change.path,
        existing
          ? {
              ...existing,
              after: change.after,
              adds: existing.adds + change.adds,
              removes: existing.removes + change.removes,
              count: existing.count + 1,
              reverted: change.reverted,
              kind: existing.kind === "create" ? "create" : change.kind,
            }
          : { ...change, count: 1 },
      );
    }
    return [...byPath.values()];
  }, [run.changes]);

  const pending = pendingReviews(run.id, run.changes, decisions).length;
  const totalAdds = rows.reduce((sum, r) => sum + r.adds, 0);
  const totalRemoves = rows.reduce((sum, r) => sum + r.removes, 0);

  async function restoreCheckpoint() {
    if (!run.checkpointId) return;
    const response = await fetch("/api/checkpoints", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoKey, id: run.checkpointId }),
    }).catch(() => null);
    if (response?.ok) {
      const body = (await response.json()) as { restored: number; deleted: number };
      toast.success(`Restored ${body.restored} file${body.restored === 1 ? "" : "s"}.`);
      void refreshWorkspace();
    } else {
      toast.error("Could not restore that checkpoint.");
    }
  }

  return (
    <div className="flex flex-col border-t pt-1.5" style={{ borderColor: "var(--vb-line)" }}>
      <div className="flex h-6 items-center gap-2 text-[12px]">
        <span style={{ color: "var(--vb-text)" }}>
          {rows.length} file{rows.length === 1 ? "" : "s"} changed
        </span>
        <DiffCounts adds={totalAdds} removes={totalRemoves} />
        <div className="flex-1" />
        {run.checkpointId && !streaming && (
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => void restoreCheckpoint()}>
            Undo run
          </button>
        )}
        {pending > 0 && (
          <button
            type="button"
            className="vb-btn"
            onClick={() => useViberon.getState().openReviewTab()}
          >
            Review {pending}
          </button>
        )}
      </div>
      {(showAll ? rows : rows.slice(0, LIST_CAP)).map((row) => {
        const { name, dir } = splitPath(row.path);
        return (
          <button
            key={row.path}
            type="button"
            onClick={() => {
              const store = useViberon.getState();
              store.setAppMode("ide");
              store.openTab(row.path, undefined, { preview: true });
            }}
            className={cx(
              "flex h-[22px] items-center gap-2 rounded-[3px] px-1 text-left hover:bg-[var(--vb-hover)]",
              row.reverted && "opacity-50",
            )}
            title={row.summary || row.path}
          >
            <KindLetter kind={row.kind} />
            <span className="truncate text-[12.5px]" style={{ color: "var(--vb-text)" }}>
              {name}
            </span>
            <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
              {dir}
            </span>
            <DiffCounts adds={row.adds} removes={row.removes} />
          </button>
        );
      })}
      {rows.length > LIST_CAP && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="flex h-[22px] items-center self-start px-1 text-[11.5px] hover:text-[var(--vb-text)]"
          style={{ color: "var(--vb-text-dim)" }}
        >
          {showAll ? `Show first ${LIST_CAP}` : `Show all ${rows.length} files`}
        </button>
      )}
    </div>
  );
}

export function KindLetter({ kind }: { kind: FileChangeRecord["kind"] }) {
  const map = {
    create: { letter: "A", color: "var(--vb-add)" },
    update: { letter: "M", color: "var(--vb-amber)" },
    delete: { letter: "D", color: "var(--vb-del)" },
    rename: { letter: "R", color: "var(--vb-text-mid)" },
  } as const;
  const { letter, color } = map[kind];
  return (
    <span className="w-3 shrink-0 text-center font-mono text-[11px]" style={{ color }}>
      {letter}
    </span>
  );
}

/** Ticks once a second so elapsed time stays live. */
export function useLiveClock(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active]);
}

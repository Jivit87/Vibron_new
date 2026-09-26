"use client";

/**
 * Pieces of the run view that only exist because the harness checks the
 * model's work: the phase row, where localization looked, harness check /
 * gate / recovery rows in the trace, the per-check evidence table, and the
 * evidence summary at the end.
 */

import { useState } from "react";
import { Check, ChevronRight, CornerDownRight, Loader2, RotateCcw, X } from "lucide-react";

import {
  evidenceOf,
  fixPhases,
  type CheckRow,
  type CheckVerdict,
  type EvidenceOutcome,
  type GateDecision,
  type GateRecord,
  type PhaseState,
  type RecoveryRecord,
  type RunState,
  type VerificationRecord,
} from "@/lib/client/run-reducer";
import { loadFile } from "@/lib/file-loader";
import { useViberon } from "@/store/viberon";
import { cx, formatDuration, formatTokens, splitPath } from "@/components/vibe/primitives";

/* -------------------------------- phases ---------------------------------- */

export function FixPhases({ run }: { run: RunState }) {
  const phases = fixPhases(run);
  return (
    <ol className="flex h-6 items-center gap-1 overflow-hidden whitespace-nowrap text-[11.5px]" aria-label="Fix phases">
      {phases.map((phase, i) => (
        <li key={phase.id} className="flex items-center gap-1">
          {i > 0 && (
            <span className="mx-1 h-px w-4" style={{ background: "var(--vb-line-strong)" }} aria-hidden />
          )}
          <PhaseIcon state={phase.state} />
          <span style={{ color: PHASE_COLOR[phase.state] }}>{phase.label}</span>
        </li>
      ))}
    </ol>
  );
}

const PHASE_COLOR: Record<PhaseState, string> = {
  pending: "var(--vb-text-faint)",
  active: "var(--vb-text-hi)",
  done: "var(--vb-text-mid)",
  failed: "var(--vb-rose)",
};

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === "active") return <Loader2 className="size-3 animate-spin" style={{ color: "var(--vb-text-mid)" }} />;
  if (state === "done") return <Check className="size-3" style={{ color: "var(--vb-mint)" }} />;
  if (state === "failed") return <X className="size-3" style={{ color: "var(--vb-rose)" }} />;
  return <span className="inline-block size-[7px] rounded-full border" style={{ borderColor: "var(--vb-text-faint)" }} />;
}

/* ------------------------------ localization ------------------------------ */

/** Where the harness pointed the solver before it started, and whether the issue reproduced. */
export function LocalizationBlock({ run }: { run: RunState }) {
  const loc = run.localization;
  if (!loc) return null;
  const files = loc.files.slice(0, 5);
  return (
    <section className="flex flex-col" aria-label="Localization">
      <div className="flex h-6 items-center gap-2 text-[12px]">
        <span style={{ color: "var(--vb-text)" }}>Localization</span>
        {loc.snippetReproduced !== undefined && (
          <span
            className="inline-flex h-[18px] items-center rounded-[3px] border px-1.5 font-mono text-[10.5px]"
            style={{
              borderColor: "var(--vb-line-strong)",
              color: loc.snippetReproduced ? "var(--vb-mint)" : "var(--vb-text-dim)",
            }}
            title="The code snippet from the issue, run on the original code"
          >
            {loc.snippetReproduced ? "snippet reproduced" : "snippet did not reproduce"}
          </span>
        )}
        <div className="flex-1" />
        {loc.files.length > files.length && (
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            top {files.length} of {loc.files.length}
          </span>
        )}
      </div>
      {files.map((file) => {
        const { name, dir } = splitPath(file.path);
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => {
              const store = useViberon.getState();
              store.setAppMode("ide");
              void loadFile(store.repoKey, file.path);
            }}
            className="flex h-[22px] min-w-0 items-center gap-2 rounded-[3px] px-1 text-left text-[12px] hover:bg-[var(--vb-hover)]"
            title={[file.path, ...file.why].join("\n")}
          >
            <span className="shrink-0 font-mono" style={{ color: "var(--vb-text)" }}>
              {name}
            </span>
            {dir && (
              <span className="max-w-[35%] shrink-0 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                {dir}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {file.why.join(" · ")}
            </span>
            {file.score > 0 && (
              <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                {file.score.toFixed(file.score < 10 ? 2 : 0)}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}

/* ------------------------------ trace rows -------------------------------- */

const PHASE_LABEL: Record<VerificationRecord["phase"], string> = {
  baseline: "Baseline",
  gate: "Gate check",
  final: "Final check",
};

/** A check with no test counts (a compile or syntax check) is summarised by its exit code. */
function resultLabel(record: VerificationRecord): string {
  if (record.passed + record.failed > 0) return `${record.passed} passed · ${record.failed} failed`;
  return record.exitCode === 0 ? "ok" : `exit ${record.exitCode ?? "?"}`;
}

/** One harness-run check, inline in the trace. */
export function VerificationRow({ record }: { record: VerificationRecord }) {
  const regressions = record.checks.filter((c) => c.verdict === "regression").length;
  const fixes = record.checks.filter((c) => c.verdict === "fixes").length;
  return (
    <div
      className="flex h-[22px] min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12px]"
      title={record.command}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        <span className="size-[6px] rounded-full" style={{ background: regressions > 0 ? "var(--vb-rose)" : "var(--vb-text-faint)" }} />
      </span>
      <span className="shrink-0" style={{ color: "var(--vb-text-mid)" }}>
        {PHASE_LABEL[record.phase]}
      </span>
      <span className="shrink-0 font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
        {resultLabel(record)}
        {record.timedOut ? " · timed out" : ""}
      </span>
      {record.phase !== "baseline" && fixes > 0 && (
        <span className="shrink-0 font-mono text-[11.5px]" style={{ color: "var(--vb-mint)" }}>
          {fixes} fixed
        </span>
      )}
      {regressions > 0 && (
        <span className="shrink-0 font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
          {regressions} regression{regressions === 1 ? "" : "s"}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
        {record.command}
      </span>
      <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
        {formatDuration(record.durationMs)}
      </span>
    </div>
  );
}

const GATE: Record<GateDecision, { label: string; color: string }> = {
  accept: { label: "Accepted", color: "var(--vb-mint)" },
  reject: { label: "Rejected", color: "var(--vb-rose)" },
  accept_unverified: { label: "Accepted, unverified", color: "var(--vb-amber)" },
  give_up: { label: "Gave up", color: "var(--vb-text-mid)" },
};

export function GateChip({ decision }: { decision: GateDecision }) {
  const { label, color } = GATE[decision];
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-[3px] border px-1.5 font-mono text-[10.5px]"
      style={{ color, borderColor: "var(--vb-line-strong)" }}
    >
      {label}
    </span>
  );
}

export function GateRow({ record }: { record: GateRecord }) {
  return (
    <div className="flex min-h-[22px] min-w-0 items-center gap-2 text-[12px]">
      <span className="w-3.5 shrink-0" />
      <span className="shrink-0" style={{ color: "var(--vb-text-mid)" }}>
        Gate
      </span>
      <GateChip decision={record.decision} />
      <span className="min-w-0 truncate" style={{ color: "var(--vb-text-dim)" }} title={record.reason}>
        {record.reason}
      </span>
    </div>
  );
}

const RECOVERY_LABEL: Record<RecoveryRecord["action"], string> = {
  hint: "Nudge",
  replan: "Replan",
  rollback: "Rolled back",
  restore_best: "Restored best",
};

export function RecoveryRow({ record }: { record: RecoveryRecord }) {
  const undo = record.action === "rollback" || record.action === "restore_best";
  const Icon = undo ? RotateCcw : CornerDownRight;
  return (
    <div
      className="flex h-[22px] min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap text-[12px]"
      style={{ color: "var(--vb-amber)" }}
      title={record.detail}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="shrink-0">{RECOVERY_LABEL[record.action]}</span>
      <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
        {record.failureClass.replace(/_/g, " ")}
      </span>
      <span className="min-w-0 truncate" style={{ color: "var(--vb-text-dim)" }}>
        {record.detail}
      </span>
    </div>
  );
}

export function AttemptSeparator({ attempt, reason }: { attempt: number; reason?: string }) {
  return (
    <div className="flex flex-col pb-1">
      <div className="flex h-7 items-center gap-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
        <span className="h-px flex-1" style={{ background: "var(--vb-line)" }} />
        <span>Attempt {attempt} — fresh context</span>
        <span className="h-px flex-1" style={{ background: "var(--vb-line)" }} />
      </div>
      {reason && (
        <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--vb-text-dim)" }}>
          {reason} Restarted from the original code; the better-proven patch is kept.
        </p>
      )}
    </div>
  );
}

/* --------------------------- verification block --------------------------- */

const VERDICT: Record<CheckVerdict, { label: string; color: string; order: number }> = {
  regression: { label: "regression", color: "var(--vb-rose)", order: 0 },
  still_failing: { label: "still failing", color: "var(--vb-amber)", order: 1 },
  fixes: { label: "fixes", color: "var(--vb-mint)", order: 2 },
  pre_existing: { label: "pre-existing", color: "var(--vb-text-dim)", order: 3 },
  pass: { label: "passes", color: "var(--vb-text-faint)", order: 4 },
};

/** Baseline vs patched, and what each check says about the patch. */
export function VerificationBlock({ run }: { run: RunState }) {
  const [showExcerpt, setShowExcerpt] = useState(false);
  const [showPassing, setShowPassing] = useState(false);
  const baseline = run.verifications.find((v) => v.phase === "baseline");
  const latest = [...run.verifications].reverse().find((v) => v.phase !== "baseline");
  const lastGate = run.gates[run.gates.length - 1];
  if (!baseline && !latest) return null;

  const checks = [...(latest?.checks ?? [])].sort((a, b) => VERDICT[a.verdict].order - VERDICT[b.verdict].order);
  const passing = checks.filter((c) => c.verdict === "pass");
  const visible = showPassing ? checks : checks.filter((c) => c.verdict !== "pass");
  const excerpt = (latest ?? baseline)?.excerpt ?? "";

  return (
    <section className="@container flex flex-col border-t pt-1.5" style={{ borderColor: "var(--vb-line)" }} aria-label="Verification">
      <div className="flex h-6 items-center gap-2 text-[12px]">
        <span style={{ color: "var(--vb-text)" }}>Verification</span>
        {lastGate && <GateChip decision={lastGate.decision} />}
        <div className="flex-1" />
        <span className="min-w-0 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {(latest ?? baseline)?.command}
        </span>
      </div>

      <div className="grid grid-cols-[auto_1fr] gap-x-4 py-0.5 font-mono text-[11.5px]">
        <Counts label="original" record={baseline} />
        <Counts label="patched" record={latest} pending={!latest} />
      </div>

      {visible.length > 0 && (
        <table className="mt-1 w-full table-fixed border-collapse text-[11.5px]" aria-label="Evidence per check">
          <thead>
            <tr className="text-left" style={{ color: "var(--vb-text-faint)" }}>
              <th className="py-0.5 font-normal">check</th>
              <th className="w-[40%] py-0.5 font-normal">original → patched</th>
              <th className="w-[84px] py-0.5 text-right font-normal">verdict</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((check) => (
              <CheckLine key={check.name} check={check} />
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center gap-3">
        {excerpt && (
          <button
            type="button"
            onClick={() => setShowExcerpt((v) => !v)}
            className="flex h-[22px] items-center gap-1 text-[11.5px] hover:text-[var(--vb-text)]"
            style={{ color: "var(--vb-text-dim)" }}
            aria-expanded={showExcerpt}
          >
            <ChevronRight className={cx("size-3.5", showExcerpt && "rotate-90")} />
            Failure output
          </button>
        )}
        {passing.length > 0 && (
          <button
            type="button"
            onClick={() => setShowPassing((v) => !v)}
            className="h-[22px] text-[11.5px] hover:text-[var(--vb-text)]"
            style={{ color: "var(--vb-text-dim)" }}
          >
            {showPassing ? "Hide" : "Show"} {passing.length} unchanged passing
          </button>
        )}
      </div>
      {showExcerpt && excerpt && (
        <pre
          className="mb-1 max-h-48 overflow-auto rounded-[3px] border px-2 py-1 font-mono text-[11.5px] whitespace-pre-wrap"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-mid)" }}
        >
          {excerpt}
        </pre>
      )}
    </section>
  );
}

function Counts({ label, record, pending }: { label: string; record?: VerificationRecord; pending?: boolean }) {
  return (
    <>
      <span style={{ color: "var(--vb-text-dim)" }}>{label}</span>
      <span style={{ color: "var(--vb-text-mid)" }}>
        {record ? (
          <>
            {record.passed} passed · <span style={{ color: record.failed > 0 ? "var(--vb-text)" : undefined }}>{record.failed} failed</span>
            <span style={{ color: "var(--vb-text-faint)" }}> · {formatDuration(record.durationMs)}</span>
          </>
        ) : (
          <span style={{ color: "var(--vb-text-faint)" }}>{pending ? "not run yet" : "not run"}</span>
        )}
      </span>
    </>
  );
}

function CheckLine({ check }: { check: CheckRow }) {
  const [open, setOpen] = useState(false);
  const v = VERDICT[check.verdict];
  const detail = check.excerpt;
  return (
    <>
      <tr
        className={cx("border-t align-top", detail && "cursor-pointer hover:bg-[var(--vb-hover)]")}
        style={{ borderColor: "var(--vb-line-faint)" }}
        onClick={() => detail && setOpen((o) => !o)}
      >
        <td className="truncate py-[3px] pr-2 font-mono" style={{ color: "var(--vb-text)" }} title={check.name}>
          {check.name}
        </td>
        <td
          className="truncate py-[3px] pr-2 font-mono text-[11px]"
          style={{ color: "var(--vb-text-dim)" }}
          title={`original: ${check.before ?? "?"}\npatched: ${check.after ?? "?"}`}
        >
          {check.before ?? "?"} <span style={{ color: "var(--vb-text-faint)" }}>→</span> {check.after ?? "?"}
        </td>
        <td className="py-[3px] text-right font-mono" style={{ color: v.color }}>
          {v.label}
        </td>
      </tr>
      {open && detail && (
        <tr>
          <td colSpan={3}>
            <pre
              className="mb-1 overflow-auto rounded-[3px] border px-2 py-1 font-mono text-[11px] whitespace-pre-wrap"
              style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-mid)" }}
            >
              {detail}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

/* ------------------------------- evidence -------------------------------- */

const OUTCOME: Record<EvidenceOutcome, { label: string; color: string }> = {
  verified: { label: "Verified fix", color: "var(--vb-mint)" },
  unverified: { label: "Unverified patch", color: "var(--vb-amber)" },
  no_patch: { label: "No patch", color: "var(--vb-text-mid)" },
  incomplete: { label: "Incomplete", color: "var(--vb-amber)" },
  failed: { label: "Failed", color: "var(--vb-rose)" },
};

/** The receipt: was the patch proven, and what did it cost. */
export function EvidenceSummary({ run }: { run: RunState }) {
  const e = evidenceOf(run);
  const { label, color } = OUTCOME[e.outcome];
  const stats = [
    e.baseline && e.final ? `${e.baseline.failed} → ${e.final.failed} failing` : null,
    e.final ? `${e.fixes} fixed` : null,
    e.final ? `${e.regressions} regression${e.regressions === 1 ? "" : "s"}` : null,
    `${e.filesChanged} file${e.filesChanged === 1 ? "" : "s"}`,
    e.attempts > 1 ? `${e.attempts} attempts` : null,
    e.rejections > 0 ? `${e.rejections} rejected` : null,
  ].filter(Boolean);
  const cost = [
    e.tokens > 0 ? `${formatTokens(e.tokens)} tok` : null,
    `${e.toolCalls} call${e.toolCalls === 1 ? "" : "s"}`,
    formatDuration(Math.max(0, e.durationMs)),
  ].filter(Boolean);

  return (
    <section
      className="flex flex-col gap-1 rounded-[4px] border px-2.5 py-2"
      style={{ borderColor: "var(--vb-line-strong)" }}
      aria-label="Evidence"
    >
      <div className="flex min-h-[22px] items-center gap-2">
        <span className="size-[7px] shrink-0 rounded-full" style={{ background: color }} />
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: "var(--vb-text-hi)" }}>
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }} title={stats.join(" · ")}>
          {stats.join(" · ")}
        </span>
        {e.filesChanged > 0 && (
          <button type="button" className="vb-btn shrink-0" onClick={() => useViberon.getState().openReviewTab()}>
            Review changes
          </button>
        )}
      </div>
      {e.reason && (
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--vb-text-mid)" }}>
          {e.reason}
        </p>
      )}
      <p className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
        {cost.join(" · ")}
      </p>
    </section>
  );
}

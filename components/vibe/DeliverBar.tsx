"use client";

/**
 * After a verified fix: open a pull request, report back on the issue, and
 * watch the PR's checks. Every network action is an explicit click; a
 * refused delivery (e.g. a workflow file changed) needs a second, explicit
 * confirmation.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, ExternalLink, Loader2, X } from "lucide-react";

import { findIssueUrl } from "@/lib/client/clone";
import { branchError, deliveryEvidence, shortRef, type CiCheck } from "@/lib/client/deliver";
import { isMockMode } from "@/lib/client/mock-run";
import { sameJson, startBackoffPolling } from "@/lib/client/use-polling";
import { evidenceOf, type RunState } from "@/lib/client/run-reducer";
import { useDeliver, type DeliverDraft } from "@/store/deliver";
import { useViberon } from "@/store/viberon";
import { Checkbox, cx, formatAgo } from "@/components/vibe/primitives";

const CI_POLL_MS = 20_000;
const CI_POLL_MOCK_MS = 3_000;
/** Unchanged checks back off to at most this multiple of the base interval. */
const CI_POLL_MAX_FACTOR = 8;
/** `.vb-btn` is unlayered CSS, so size overrides go inline rather than as utilities. */
const SMALL_BTN = { height: 20, padding: "0 6px", fontSize: 11.5 } as const;

/** Whether this run ended in a state worth shipping. */
export function canDeliver(run: RunState): boolean {
  if (run.interaction !== "fix") return false;
  if (run.status === "planning" || run.status === "running") return false;
  return evidenceOf(run).outcome === "verified";
}

export function DeliverBar({ run }: { run: RunState }) {
  const repoKey = useViberon((s) => s.repoKey);
  const d = useDeliver((s) => s.byRun[run.id]);
  const issueUrl = useMemo(() => findIssueUrl(run.prompt) ?? undefined, [run.prompt]);
  const files = useMemo(() => [...new Set(run.changes.map((c) => c.path))], [run.changes]);

  useEffect(() => {
    const store = useDeliver.getState();
    const draft = store.ensure(run.id, run.prompt);
    if (!draft.described && !draft.describing && draft.phase === "edit" && !draft.pr) {
      void store.describe(run.id, repoKey);
    }
  }, [run.id, run.prompt, repoKey]);

  if (!d) return null;

  return (
    <section
      className="flex flex-col gap-1.5 rounded-[4px] border px-2.5 py-2"
      style={{ borderColor: "var(--vb-line-strong)" }}
      aria-label="Deliver"
    >
      {d.pr ? (
        <Delivered runId={run.id} d={d} issueUrl={issueUrl} run={run} />
      ) : d.pushed ? (
        <div className="flex min-h-[22px] items-center gap-2 text-[12px]">
          <span style={{ color: "var(--vb-mint)" }}>Pushed</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--vb-text)" }}>
            {d.pushed.branch}
            {d.pushed.commit ? ` @ ${d.pushed.commit.slice(0, 7)}` : ""}
          </span>
          <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            no pull request: the remote is not on GitHub
          </span>
        </div>
      ) : (
        <DeliverForm runId={run.id} d={d} files={files} issueUrl={issueUrl} />
      )}
    </section>
  );
}

/* --------------------------------- form ---------------------------------- */

function DeliverForm({ runId, d, files, issueUrl }: { runId: string; d: DeliverDraft; files: string[]; issueUrl?: string }) {
  const repoKey = useViberon((s) => s.repoKey);
  const patch = useDeliver((s) => s.patch);
  const busy = d.phase === "delivering";
  const branchProblem = branchError(d.branch);
  const blocked = busy || Boolean(branchProblem) || !d.title.trim();
  const deliver = (confirm?: boolean, pushOnly?: boolean) =>
    void useDeliver.getState().deliver(runId, { repoKey, files, issueUrl, confirm, pushOnly });

  return (
    <>
      <div className="flex min-h-[22px] items-center gap-2">
        <span className="text-[12px]" style={{ color: "var(--vb-text)" }}>
          Pull request
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={files.join("\n")}>
          {files.length} file{files.length === 1 ? "" : "s"}
          {issueUrl ? ` · ${shortRef(issueUrl)}` : ""}
        </span>
        {d.describing && (
          <span className="flex items-center gap-1 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            <Loader2 className="size-3 animate-spin" />
            describing
          </span>
        )}
      </div>

      <div className="grid grid-cols-[44px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <label htmlFor={`br-${runId}`} className="text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          branch
        </label>
        <input
          id={`br-${runId}`}
          value={d.branch}
          onChange={(e) => patch(runId, { branch: e.target.value })}
          disabled={busy}
          spellCheck={false}
          className="vb-input h-[24px] w-full font-mono text-[12px]"
          style={branchProblem ? { borderColor: "var(--vb-rose)" } : undefined}
          title={branchProblem ?? undefined}
        />
        <label htmlFor={`ti-${runId}`} className="text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          title
        </label>
        <input
          id={`ti-${runId}`}
          value={d.title}
          onChange={(e) => patch(runId, { title: e.target.value })}
          disabled={busy}
          className="vb-input h-[24px] w-full text-[12.5px]"
        />
        <label htmlFor={`bo-${runId}`} className="self-start pt-1 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          body
        </label>
        <textarea
          id={`bo-${runId}`}
          value={d.body}
          onChange={(e) => patch(runId, { body: e.target.value })}
          disabled={busy}
          rows={5}
          placeholder={d.describing ? "Writing a description from the diff…" : "Describe the change"}
          className="vb-input vb-textarea w-full resize-y font-mono text-[11.5px] leading-[17px]"
        />
      </div>

      {d.phase === "confirm" ? (
        <div className="flex flex-col gap-1.5 border-l-2 py-0.5 pl-2" style={{ borderColor: "var(--vb-amber)" }}>
          <p className="text-[12px] leading-relaxed" style={{ color: "var(--vb-text)" }}>
            {d.error}
          </p>
          {d.confirmFiles.length > 0 && (
            <p className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              {d.confirmFiles.join(", ")}
            </p>
          )}
          <div className="flex items-center gap-1">
            <button type="button" className="vb-btn" onClick={() => deliver(true)}>
              Include workflow changes and open
            </button>
            <button type="button" className="vb-btn vb-btn-ghost" onClick={() => patch(runId, { phase: "edit", error: null, confirmFiles: [] })}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {d.error && (
            <p className="whitespace-pre-wrap border-l-2 py-0.5 pl-2 font-mono text-[11.5px] leading-relaxed" style={{ borderColor: "var(--vb-rose)", color: "var(--vb-text)" }}>
              {d.error}
            </p>
          )}
          <div className="flex items-center gap-1">
            <Checkbox
              checked={d.draft}
              onChange={(draft) => patch(runId, { draft })}
              label="Draft"
              title="Open as a draft pull request"
              disabled={busy}
            />
            <div className="flex-1" />
            {branchProblem && (
              <span className="mr-1 text-[11px]" style={{ color: "var(--vb-rose)" }}>
                {branchProblem}
              </span>
            )}
            {d.notGithub && (
              <button
                type="button"
                className="vb-btn"
                disabled={blocked}
                title="The remote is not on GitHub: push the branch without opening a pull request"
                onClick={() => deliver(false, true)}
              >
                Push branch only
              </button>
            )}
            <button type="button" className="vb-btn vb-btn-primary" disabled={blocked} onClick={() => deliver()}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {busy ? "Pushing…" : "Open pull request"}
            </button>
          </div>
        </>
      )}
    </>
  );
}

/* ------------------------------- delivered ------------------------------- */

function Delivered({ runId, d, issueUrl, run }: { runId: string; d: DeliverDraft; issueUrl?: string; run: RunState }) {
  const repoKey = useViberon((s) => s.repoKey);
  const pr = d.pr!;
  const pending = !d.ci || d.ci.state === "pending";

  useEffect(() => {
    if (!pending) return;
    const base = isMockMode() ? CI_POLL_MOCK_MS : CI_POLL_MS;
    // Back off while the checks are unchanged, pause while the window is
    // hidden, stop once they complete.
    return startBackoffPolling({
      baseMs: base,
      maxMs: base * CI_POLL_MAX_FACTOR,
      tick: async () => {
        const before = useDeliver.getState().byRun[runId]?.ci;
        await useDeliver.getState().pollCi(runId);
        const after = useDeliver.getState().byRun[runId]?.ci;
        if (after && after.state !== "pending") return "done";
        return sameJson(before, after) ? "same" : "changed";
      },
    });
  }, [pending, runId]);

  function comment() {
    if (!issueUrl) return;
    const files = [...new Set(run.changes.map((c) => c.path))];
    const evidence = deliveryEvidence(evidenceOf(run), files);
    void useDeliver.getState().comment(runId, { repoKey, issueUrl, summary: run.summary || d.title, evidence });
  }

  return (
    <>
      <div className="flex min-h-[22px] min-w-0 items-center gap-2">
        <Check className="size-3.5 shrink-0" style={{ color: "var(--vb-mint)" }} />
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="flex min-w-0 items-center gap-1 text-[12.5px] hover:underline"
          style={{ color: "var(--vb-text-hi)" }}
        >
          <span className="truncate">
            {pr.updated ? "Updated" : "Opened"} {pr.number ? `#${pr.number}` : shortRef(pr.url)}
          </span>
          <ExternalLink className="size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
        </a>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }} title={pr.branch}>
          {d.draft ? "draft · " : ""}
          {pr.branch}
          {pr.commit ? ` · ${pr.commit.slice(0, 7)}` : ""}
        </span>
        {issueUrl &&
          (d.comment.state === "done" ? (
            d.comment.url ? (
              <a href={d.comment.url} target="_blank" rel="noreferrer" className="shrink-0 text-[11.5px] hover:underline" style={{ color: "var(--vb-text-mid)" }}>
                Commented on {shortRef(issueUrl)}
              </a>
            ) : (
              <span className="shrink-0 text-[11.5px]" style={{ color: "var(--vb-text-mid)" }}>
                Commented
              </span>
            )
          ) : (
            <button
              type="button"
              className="vb-btn shrink-0"
              disabled={d.comment.state === "posting"}
              onClick={comment}
              title={`Post the PR link and the evidence on ${issueUrl}`}
            >
              {d.comment.state === "posting" && <Loader2 className="size-3 animate-spin" />}
              Comment on issue
            </button>
          ))}
      </div>
      {d.comment.state === "error" && (
        <p className="border-l-2 py-0.5 pl-2 font-mono text-[11.5px]" style={{ borderColor: "var(--vb-rose)", color: "var(--vb-text)" }}>
          {d.comment.error}
        </p>
      )}
      <CiStrip runId={runId} d={d} />
    </>
  );
}

/* ---------------------------------- CI ----------------------------------- */

const CHECK_ORDER: Record<CiCheck["state"], number> = { failure: 0, pending: 1, success: 2, skipped: 3 };

function CiStrip({ runId, d }: { runId: string; d: DeliverDraft }) {
  const repoKey = useViberon((s) => s.repoKey);
  const ci = d.ci;
  const failing = ci?.checks.filter((c) => c.state === "failure") ?? [];
  const checks = [...(ci?.checks ?? [])].sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state]);
  const color = !ci ? "var(--vb-text-faint)" : ci.state === "failure" ? "var(--vb-rose)" : ci.state === "success" ? "var(--vb-mint)" : "var(--vb-amber)";
  const limitHit = d.rerunLimit !== undefined && d.rerunCount !== undefined && d.rerunCount >= d.rerunLimit;

  return (
    <div className="flex flex-col border-t pt-1.5" style={{ borderColor: "var(--vb-line)" }}>
      <div className="flex h-[22px] min-w-0 items-center gap-2 text-[12px]">
        <span style={{ color: "var(--vb-text)" }}>Checks</span>
        {ci ? (
          <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
            <span className={cx("size-[6px] rounded-full", ci.state === "pending" && "vb-pulse")} style={{ background: color }} />
            {ci.state}
          </span>
        ) : (
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {d.ciError ? "unavailable" : "waiting"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {ci?.headSha ? ci.headSha.slice(0, 7) : ""}
          {d.ciCheckedAt ? ` · checked ${formatAgo(d.ciCheckedAt)}` : ""}
          {d.rerunCount !== undefined && d.rerunLimit !== undefined ? ` · re-runs ${d.rerunCount}/${d.rerunLimit}` : ""}
        </span>
        {d.ciLoading && <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: "var(--vb-text-dim)" }} />}
        {failing.length > 0 &&
          (d.fixTask?.state === "queued" ? (
            <button
              type="button"
              className="shrink-0 text-[11.5px] hover:underline"
              style={{ color: "var(--vb-text-mid)" }}
              onClick={() => {
                const store = useViberon.getState();
                store.setAppMode("ide");
                store.setBottomPanel("tasks");
              }}
            >
              Fix queued{d.fixTask.id ? ` · ${d.fixTask.id}` : ""}
            </button>
          ) : (
            <button
              type="button"
              className="vb-btn shrink-0"
              disabled={d.fixTask?.state === "sending"}
              onClick={() => void useDeliver.getState().fixCi(runId, repoKey)}
              title="Queue a fix run seeded with the failing checks' output"
            >
              {d.fixTask?.state === "sending" && <Loader2 className="size-3 animate-spin" />}
              Fix CI
            </button>
          ))}
        <button
          type="button"
          className="vb-btn vb-btn-ghost shrink-0" style={{ padding: "0 6px" }}
          disabled={d.ciLoading}
          onClick={() => void useDeliver.getState().pollCi(runId)}
        >
          Refresh
        </button>
      </div>
      {d.ciError && (
        <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
          {d.ciError}
        </p>
      )}
      {d.fixTask?.state === "error" && (
        <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
          {d.fixTask.error}
        </p>
      )}
      {ci && ci.checks.length === 0 && (
        <p className="text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          No checks reported yet for this commit.
        </p>
      )}
      {checks.map((check) => (
        <CheckRow key={check.name} runId={runId} d={d} check={check} limitHit={limitHit} />
      ))}
    </div>
  );
}

function CheckRow({ runId, d, check, limitHit }: { runId: string; d: DeliverDraft; check: CiCheck; limitHit: boolean }) {
  const [open, setOpen] = useState(false);
  const rerun = d.reruns[check.name];
  const setRerun = useDeliver((s) => s.setRerun);
  const failed = check.state === "failure";
  const icon =
    check.state === "success" ? (
      <Check className="size-3 shrink-0" style={{ color: "var(--vb-mint)" }} />
    ) : check.state === "failure" ? (
      <X className="size-3 shrink-0" style={{ color: "var(--vb-rose)" }} />
    ) : check.state === "pending" ? (
      <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: "var(--vb-text-dim)" }} />
    ) : (
      <span className="inline-block size-3 shrink-0" />
    );

  return (
    <div className="flex flex-col">
      <div className="group flex h-[22px] min-w-0 items-center gap-2 text-[12px]">
        {check.logExcerpt ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={open}
          >
            {icon}
            <span className="truncate font-mono" style={{ color: "var(--vb-text)" }}>
              {check.name}
            </span>
            <ChevronRight className={cx("size-3 shrink-0", open && "rotate-90")} style={{ color: "var(--vb-text-faint)" }} />
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {icon}
            <span className="truncate font-mono" style={{ color: "var(--vb-text)" }}>
              {check.name}
            </span>
          </span>
        )}
        <span className="shrink-0 font-mono text-[11px]" style={{ color: failed ? "var(--vb-rose)" : "var(--vb-text-dim)" }}>
          {check.conclusion.replace(/_/g, " ")}
        </span>
        {failed && !rerun?.asking && (
          <button
            type="button"
            className="vb-btn vb-btn-ghost shrink-0" style={SMALL_BTN}
            disabled={limitHit}
            title={limitHit ? `Re-run limit reached for this commit (${d.rerunLimit})` : "Re-run this job if the failure is flaky"}
            onClick={() => setRerun(runId, check.name, { asking: true, error: undefined })}
          >
            Re-run
          </button>
        )}
        {rerun?.done && check.state === "pending" && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            re-running
          </span>
        )}
        {check.url && (
          <a href={check.url} target="_blank" rel="noreferrer" className="shrink-0" title="Open on GitHub" style={{ color: "var(--vb-text-faint)" }}>
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      {open && check.logExcerpt && (
        <pre
          className="mb-1 max-h-40 overflow-auto rounded-[3px] border px-2 py-1 font-mono text-[11px] whitespace-pre-wrap"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-mid)" }}
        >
          {check.logExcerpt}
        </pre>
      )}
      {rerun?.asking && (
        <div className="flex flex-col gap-1 pb-1 pl-5">
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={rerun.reason}
              onChange={(e) => setRerun(runId, check.name, { reason: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") void useDeliver.getState().rerun(runId, check.name);
                if (e.key === "Escape") setRerun(runId, check.name, { asking: false });
              }}
              placeholder="Why is this flaky? e.g. network timeout fetching a fixture"
              aria-label="Evidence that the failure is flaky"
              className="vb-input min-w-0 flex-1" style={{ height: 22, fontSize: 12 }}
            />
            <button
              type="button"
              className="vb-btn shrink-0" style={{ height: 22 }}
              disabled={!rerun.reason.trim() || rerun.sending}
              onClick={() => void useDeliver.getState().rerun(runId, check.name)}
            >
              {rerun.sending && <Loader2 className="size-3 animate-spin" />}
              Re-run
            </button>
            <button type="button" className="vb-btn vb-btn-ghost shrink-0" style={{ height: 22, padding: "0 6px" }} onClick={() => setRerun(runId, check.name, { asking: false })}>
              Cancel
            </button>
          </div>
          {rerun.error && (
            <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-rose)" }}>
              {rerun.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

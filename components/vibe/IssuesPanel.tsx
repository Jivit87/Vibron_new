"use client";

/**
 * GitHub issues → fix → pull request. Lists the repo's open issues (optionally
 * one label), queues fix+deliver tasks for the selected ones, and configures
 * the auto-fix watcher that picks up maintainer-labeled issues.
 * Contract: docs/PLAN-ISSUES.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { attachedTask, attachTaskRun } from "@/lib/client/agent-stream";
import { shortRef } from "@/lib/client/deliver";
import {
  canFix,
  clampInterval,
  fetchIssues,
  fixAllIssuesInOnePr,
  fixIssues,
  INTERVAL_MAX,
  INTERVAL_MIN,
  issueStatus,
  pollInterval,
  saveWatch,
  WATCH_DEFAULT,
  type IssueRow,
  type IssuesError,
  type IssueStatusKind,
  type WatchConfig,
} from "@/lib/client/issues";
import { useViberon } from "@/store/viberon";
import { Checkbox, cx, EmptyState, formatAgo, IconButton, Switch } from "@/components/vibe/primitives";

const STATUS_COLOR: Record<IssueStatusKind, string> = {
  none: "var(--vb-text-faint)",
  queued: "var(--vb-text-mid)",
  running: "var(--vb-accent)",
  done: "var(--vb-mint)",
  failed: "var(--vb-rose)",
  not_delivered: "var(--vb-amber)",
  cancelled: "var(--vb-text-faint)",
};

const EXPLAIN = "Only issues a maintainer labeled are picked up. Fixes open as draft pull requests after their checks pass.";

/** `.vb-btn` is unlayered CSS, so size overrides go inline. */
const SMALL_BTN = { height: 20, padding: "0 6px", fontSize: 11.5 } as const;

function openIntegrations() {
  useViberon.getState().openSettingsTab();
  window.setTimeout(() => document.getElementById("settings-integrations")?.scrollIntoView({ block: "start" }), 60);
}

export function IssuesPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const streaming = useViberon((s) => s.streaming);

  const [rows, setRows] = useState<IssueRow[] | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [error, setError] = useState<IssuesError | null>(null);
  const [loading, setLoading] = useState(false);
  const [labelInput, setLabelInput] = useState("");
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fixingAll, setFixingAll] = useState(false);
  const [pending, setPending] = useState<Set<number>>(new Set());
  const [skipped, setSkipped] = useState<Map<number, string>>(new Map());
  const [fixError, setFixError] = useState<IssuesError | null>(null);

  const [watch, setWatch] = useState<WatchConfig>(WATCH_DEFAULT);
  const [watchLabel, setWatchLabel] = useState(WATCH_DEFAULT.label);
  const [watchInterval, setWatchInterval] = useState(String(WATCH_DEFAULT.intervalMinutes));
  const [watchSaving, setWatchSaving] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const watchTouched = useRef(false);

  // The filter applies after typing pauses.
  useEffect(() => {
    const id = window.setTimeout(() => setLabel(labelInput.trim()), 400);
    return () => window.clearTimeout(id);
  }, [labelInput]);

  const applyWatch = useCallback((w: WatchConfig) => {
    setWatch(w);
    if (!watchTouched.current) {
      setWatchLabel(w.label);
      setWatchInterval(String(w.intervalMinutes));
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!repoKey) return;
    setLoading(true);
    const result = await fetchIssues(repoKey, label);
    setLoading(false);
    if (result.ok === false) {
      setError(result.error);
      return;
    }
    const { data } = result;
    setError(null);
    setRows(data.issues);
    setRepo(data.repo ? `${data.repo.owner}/${data.repo.repo}` : null);
    if (data.watch) applyWatch(data.watch);
    // Drop selections that are gone or no longer fixable.
    setSelected((prev) => {
      const fixable = new Set(data.issues.filter(canFix).map((r) => r.number));
      const next = new Set([...prev].filter((n) => fixable.has(n)));
      return next.size === prev.size ? prev : next;
    });
  }, [repoKey, label, applyWatch]);

  const interval = pollInterval(rows);
  const stop = error?.kind === "missing" || error?.kind === "no_folder" || error?.kind === "no_github_remote";

  useEffect(() => {
    void refresh();
    if (stop) return;
    const id = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(id);
  }, [refresh, interval, stop]);

  async function fixAll() {
    if (!repoKey) return;
    setFixingAll(true);
    const error = await fixAllIssuesInOnePr(repoKey, useViberon.getState().settings.model);
    setFixingAll(false);
    if (error) toast.error(error);
    else toast.success("Fixing all open issues; one pull request at the end.");
    void refresh();
  }

  async function fix(numbers: number[]) {
    if (!repoKey || numbers.length === 0) return;
    setPending((p) => new Set([...p, ...numbers]));
    setFixError(null);
    const result = await fixIssues(repoKey, numbers);
    setPending((p) => new Set([...p].filter((n) => !numbers.includes(n))));
    if (!result.ok) {
      setFixError(result.error ?? { kind: "other", message: "Could not queue the fixes." });
      return;
    }
    setSkipped((prev) => {
      const next = new Map(prev);
      for (const n of numbers) next.delete(n);
      for (const s of result.skipped) next.set(s.number, s.reason);
      return next;
    });
    setSelected((prev) => new Set([...prev].filter((n) => !numbers.includes(n))));
    if (result.tasks.length > 0) {
      toast.success(`Queued ${result.tasks.length} fix${result.tasks.length === 1 ? "" : "es"}.`);
    }
    void refresh();
  }

  async function persistWatch(patch: Partial<Pick<WatchConfig, "enabled" | "label" | "intervalMinutes">>) {
    if (!repoKey) return;
    const next = {
      enabled: patch.enabled ?? watch.enabled,
      label: (patch.label ?? watchLabel).trim() || WATCH_DEFAULT.label,
      intervalMinutes: clampInterval(patch.intervalMinutes ?? watchInterval),
    };
    if (next.enabled === watch.enabled && next.label === watch.label && next.intervalMinutes === watch.intervalMinutes) {
      setWatchLabel(next.label);
      setWatchInterval(String(next.intervalMinutes));
      return;
    }
    setWatchSaving(true);
    const result = await saveWatch(repoKey, next);
    setWatchSaving(false);
    watchTouched.current = false;
    if (!result.ok || !result.watch) {
      setWatchError(result.error ?? "Could not save the auto-fix settings.");
      setWatchLabel(watch.label);
      setWatchInterval(String(watch.intervalMinutes));
      return;
    }
    setWatchError(null);
    applyWatch(result.watch);
    setWatchLabel(result.watch.label);
    setWatchInterval(String(result.watch.intervalMinutes));
  }

  function attach(row: IssueRow) {
    if (!row.task) return;
    if (streaming) {
      toast.error("A run is already showing. Stop it first.");
      return;
    }
    useViberon.getState().setAgentDockOpen(true);
    void attachTaskRun({ id: row.task.id, task: `Fix #${row.number}: ${row.title}` });
  }

  const attached = streaming ? attachedTask() : null;
  const fixable = (rows ?? []).filter(canFix);
  const allSelected = fixable.length > 0 && fixable.every((r) => selected.has(r.number));
  const selectedCount = selected.size;

  function toggle(n: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(n);
      else next.delete(n);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: repo, label filter, refresh, bulk fix. */}
      <div className="flex h-[30px] shrink-0 items-center gap-2 border-b px-3 text-[12px]" style={{ borderColor: "var(--vb-line-faint)" }}>
        <span className="truncate font-mono text-[11.5px]" style={{ color: repo ? "var(--vb-text-hi)" : "var(--vb-text-faint)" }}>
          {repo ?? "no repository"}
        </span>
        {rows && (
          <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {rows.length} open
          </span>
        )}
        <input
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setLabel(labelInput.trim())}
          placeholder="filter by label"
          aria-label="Filter by label"
          spellCheck={false}
          className="vb-input ml-2 w-[170px] font-mono text-[11.5px]"
          style={{ height: 22 }}
        />
        <div className="flex-1" />
        <IconButton title="Refresh" onClick={() => void refresh()}>
          <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
        </IconButton>
        <button
          type="button"
          className="vb-btn"
          style={{ height: 22, padding: "0 8px" }}
          disabled={selectedCount === 0}
          title="One pull request per issue"
          onClick={() => void fix([...selected])}
        >
          Fix selected{selectedCount > 0 ? ` (${selectedCount})` : ""}
        </button>
        <button
          type="button"
          className="vb-btn vb-btn-primary"
          style={{ height: 22, padding: "0 8px" }}
          disabled={fixable.length === 0 || fixingAll}
          title="Fix every open issue on one branch and open one pull request"
          onClick={() => void fixAll()}
        >
          {fixingAll ? <Loader2 className="size-3.5 animate-spin" /> : null}
          Fix all → 1 PR
        </button>
      </div>

      {/* Auto-fix watcher. */}
      <div className="flex h-[26px] shrink-0 items-center gap-2 px-3 pt-1 text-[12px]" style={{ color: "var(--vb-text-mid)" }}>
        <Switch
          checked={watch.enabled}
          label="Automatically fix new issues labeled"
          onChange={(v) => !watchSaving && void persistWatch({ enabled: v })}
        />
        <span className="shrink-0">Automatically fix new issues labeled</span>
        <input
          value={watchLabel}
          onChange={(e) => {
            watchTouched.current = true;
            setWatchLabel(e.target.value);
          }}
          onBlur={() => void persistWatch({ label: watchLabel })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          aria-label="Auto-fix label"
          spellCheck={false}
          className="vb-input w-[96px] font-mono text-[11.5px]"
          style={{ height: 20 }}
        />
        <span className="shrink-0">every</span>
        <input
          value={watchInterval}
          type="number"
          min={INTERVAL_MIN}
          max={INTERVAL_MAX}
          onChange={(e) => {
            watchTouched.current = true;
            setWatchInterval(e.target.value);
          }}
          onBlur={() => void persistWatch({ intervalMinutes: clampInterval(watchInterval) })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          aria-label="Check interval in minutes"
          className="vb-input w-[56px] font-mono text-[11.5px]"
          style={{ height: 20, paddingRight: 2 }}
        />
        <span className="shrink-0">min</span>
        <span className="ml-2 shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {watchSaving
            ? "saving"
            : [watch.lastCheckedAt ? `checked ${formatAgo(watch.lastCheckedAt)}` : "not checked yet", watch.handled ? `${watch.handled} handled` : ""]
                .filter(Boolean)
                .join(" · ")}
        </span>
        {(watchError ?? watch.lastError) && (
          <span className="min-w-0 shrink truncate text-[11.5px]" style={{ color: "var(--vb-rose)" }} title={watchError ?? watch.lastError}>
            {watchError ?? watch.lastError}
          </span>
        )}
      </div>
      <div className="shrink-0 truncate border-b px-3 py-[3px] pl-[53px] text-[11.5px]" style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-faint)" }} title={EXPLAIN}>
        {EXPLAIN}
      </div>

      {fixError && (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[12px]" style={{ borderColor: "var(--vb-line-faint)", background: "var(--vb-warn-bg)", color: "var(--vb-text)" }}>
          <span className="min-w-0 truncate">{fixError.message}</span>
          {fixError.kind === "token" && <IntegrationsLink />}
          <div className="flex-1" />
          <button type="button" className="vb-btn vb-btn-ghost" style={SMALL_BTN} onClick={() => setFixError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !rows ? (
          <EmptyState
            title={error.kind === "other" ? "Could not load issues" : error.message}
            body={error.kind === "other" ? error.message : undefined}
            action={error.kind === "token" ? <IntegrationsLink /> : undefined}
          />
        ) : !rows ? (
          <div className="flex flex-col gap-1.5 px-3 py-2">
            <div className="vb-shimmer h-3 w-2/3 rounded-[3px]" />
            <div className="vb-shimmer h-3 w-1/2 rounded-[3px]" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={label ? `No open issues labeled ${label}` : "No open issues"} />
        ) : (
          <>
            {error && (
              <div className="flex items-center gap-2 px-3 py-1 text-[12px]" style={{ color: "var(--vb-rose)" }}>
                <span className="truncate">{error.message}</span>
                {error.kind === "token" && <IntegrationsLink />}
              </div>
            )}
            <table className="w-full table-fixed border-collapse text-[12px]" aria-label="Open issues">
              <thead>
                <tr className="text-left text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                  <th className="w-[30px] py-0.5 pl-2 font-normal">
                    <Checkbox
                      checked={allSelected}
                      disabled={fixable.length === 0}
                      title={allSelected ? "Clear selection" : "Select all fixable issues"}
                      onChange={(v) => setSelected(v ? new Set(fixable.map((r) => r.number)) : new Set())}
                      label={null}
                    />
                  </th>
                  <th className="w-[46px] py-0.5 font-normal">#</th>
                  <th className="py-0.5 font-normal">title</th>
                  <th className="w-[112px] py-0.5 font-normal">labels</th>
                  <th className="w-[80px] py-0.5 font-normal">author</th>
                  <th className="w-[40px] py-0.5 text-right font-normal" title="Comments">
                    cmt
                  </th>
                  <th className="w-[70px] py-0.5 pl-3 font-normal">updated</th>
                  <th className="w-[132px] py-0.5 font-normal">status</th>
                  <th className="w-[66px] py-0.5" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const status = issueStatus(row.task);
                  const color = STATUS_COLOR[status.kind];
                  const isSelected = selected.has(row.number);
                  const isPending = pending.has(row.number);
                  const skipReason = skipped.get(row.number);
                  const fixableRow = canFix(row);
                  const isAttached = Boolean(row.task && attached === row.task.id);
                  return (
                    <tr
                      key={row.number}
                      className="group h-[24px] border-t align-middle hover:bg-[var(--vb-hover)]"
                      style={{ borderColor: "var(--vb-line-faint)", background: isSelected ? "var(--vb-accent-soft)" : undefined }}
                    >
                      <td className="pl-2">
                        <Checkbox
                          checked={isSelected}
                          disabled={!fixableRow}
                          title={fixableRow ? `Select #${row.number}` : "Already has a task or a pull request"}
                          onChange={(v) => toggle(row.number, v)}
                          label={null}
                        />
                      </td>
                      <td className="font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
                        #{row.number}
                      </td>
                      <td className="truncate pr-2">
                        {row.url ? (
                          <a href={row.url} target="_blank" rel="noreferrer" className="hover:underline" style={{ color: "var(--vb-text)" }} title={row.title}>
                            {row.title}
                          </a>
                        ) : (
                          <span style={{ color: "var(--vb-text)" }}>{row.title}</span>
                        )}
                      </td>
                      <td className="truncate pr-2 text-[11px]" style={{ color: "var(--vb-text-dim)" }} title={row.labels.join(", ")}>
                        {row.labels.join(", ")}
                      </td>
                      <td className="truncate pr-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
                        {row.author ?? ""}
                      </td>
                      <td className="text-right font-mono text-[11px]" style={{ color: row.comments ? "var(--vb-text-dim)" : "var(--vb-text-faint)" }}>
                        {row.comments}
                      </td>
                      <td className="pl-3 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                        {row.updatedAt ? formatAgo(row.updatedAt) : ""}
                      </td>
                      <td className="truncate pr-2">
                        <StatusCell
                          row={row}
                          kind={status.kind}
                          label={isAttached ? "watching" : status.label}
                          detail={status.detail}
                          color={color}
                          skipReason={skipReason}
                          onAttach={() => !isAttached && attach(row)}
                        />
                      </td>
                      <td className="pr-2 text-right">
                        {fixableRow && (
                          <button
                            type="button"
                            className="vb-btn vb-btn-ghost"
                            style={SMALL_BTN}
                            disabled={isPending}
                            title={`Fix #${row.number} and open a draft pull request`}
                            onClick={() => void fix([row.number])}
                          >
                            {isPending ? <Loader2 className="size-3 animate-spin" /> : "Fix → PR"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

function StatusCell({
  row,
  kind,
  label,
  detail,
  color,
  skipReason,
  onAttach,
}: {
  row: IssueRow;
  kind: IssueStatusKind;
  label: string;
  detail?: string;
  color: string;
  skipReason?: string;
  onAttach: () => void;
}) {
  const dot = <span className="size-[6px] shrink-0 rounded-full" style={{ background: color }} />;
  if (kind === "none") {
    return skipReason ? (
      <span className="text-[11.5px]" style={{ color: "var(--vb-text-dim)" }} title={`Skipped: ${skipReason}`}>
        skipped: {skipReason}
      </span>
    ) : null;
  }
  if (kind === "running") {
    return (
      <button
        type="button"
        onClick={onAttach}
        title="Watch the live run"
        className="flex items-center gap-1.5 font-mono text-[11px] hover:underline"
        style={{ color }}
      >
        <Loader2 className="size-3 animate-spin" />
        {label}
      </button>
    );
  }
  if (kind === "done" && row.task?.prUrl) {
    const ref = shortRef(row.task.prUrl);
    const short = ref.includes("#") ? `PR #${ref.split("#")[1]}` : ref;
    return (
      <span className="flex items-center gap-1.5 font-mono text-[11px]" style={{ color }}>
        {dot}
        <a
          href={row.task.prUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:underline"
          style={{ color: "var(--vb-text-mid)" }}
          title={row.task.prUrl}
        >
          {short}
          <ExternalLink className="size-3 shrink-0" />
        </a>
      </span>
    );
  }
  const suffix = skipReason ? ` · skipped: ${skipReason}` : "";
  return (
    <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]" style={{ color }} title={[detail, skipReason ? `Skipped: ${skipReason}` : ""].filter(Boolean).join("\n")}>
      {dot}
      <span className={cx("truncate", detail && "cursor-help")}>{label}</span>
      {suffix && (
        <span className="truncate font-sans text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          {suffix}
        </span>
      )}
    </span>
  );
}

function IntegrationsLink() {
  return (
    <button type="button" onClick={openIntegrations} className="text-[12px] underline underline-offset-2" style={{ color: "var(--vb-accent)" }}>
      Add a GitHub token in Settings → Integrations
    </button>
  );
}

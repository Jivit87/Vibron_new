"use client";

/**
 * Live usage under the run header: running totals and burn rate, a stacked
 * bar per model call, and each agent's share. Fed by `turn_usage` events as
 * they land, so it grows while the run works rather than after it ends.
 */

import { useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { formatTok, formatUsd, summarizeRun, tokenRate, totalTokens } from "@/lib/client/usage";
import { ContextMeter, fillFor, fillTitle, TimelineChart, TimelineLegend } from "@/components/vibe/usage-ui";
import { useUsageStore } from "@/store/usage";
import type { RunState } from "@/store/viberon";

export function LiveUsagePanel({ run }: { run: RunState }) {
  const active = run.status === "planning" || run.status === "running";
  const extra = useUsageStore((s) => s.live[run.id]);
  const open = useUsageStore((s) => s.liveOpen);
  const usage = useMemo(() => summarizeRun(run, extra), [run, extra]);
  const tokens = totalTokens(usage.totals);

  if (!active && tokens === 0) return null;

  const turns = extra?.turns ?? [];
  const rate = active ? tokenRate(turns, Date.now()) : 0;
  const fill = fillFor(usage);
  const lanes = new Map(run.agents.map((l) => [l.id, l] as const));
  const agents = usage.byAgent.filter((r) => totalTokens(r) > 0).slice(0, 6);
  const maxAgent = Math.max(1, ...agents.map((r) => totalTokens(r)));

  return (
    <div className="flex flex-col rounded-[4px] border" style={{ borderColor: "var(--vb-line)" }}>
      <button
        type="button"
        onClick={() => useUsageStore.getState().setLiveOpen(!open)}
        aria-expanded={open}
        className="flex h-7 items-center gap-2 px-2 text-[11.5px] tabular-nums hover:bg-[var(--vb-hover)]"
        style={{ color: "var(--vb-text-dim)" }}
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {active && (
          <span
            className="inline-block size-1.5 animate-pulse rounded-full motion-reduce:animate-none"
            style={{ background: "var(--vb-accent)" }}
          />
        )}
        <span style={{ color: "var(--vb-text)" }}>Usage</span>
        <span className="font-mono">{formatTok(tokens)} tok</span>
        {usage.totals.costUsd > 0 && <span className="font-mono">{formatUsd(usage.totals.costUsd)}</span>}
        {rate > 0 && <span className="font-mono">{formatTok(rate)}/min</span>}
        <span className="flex-1" />
        <span className="font-mono">
          {turns.length} call{turns.length === 1 ? "" : "s"}
        </span>
        {fill && usage.lastContext && (
          <span title={fillTitle(fill, usage.lastContext.model)}>
            <ContextMeter fill={fill} width={32} />
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col gap-2 border-t px-2 py-2" style={{ borderColor: "var(--vb-line)" }}>
          {turns.length === 0 ? (
            <span className="text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
              Waiting for the first model call…
            </span>
          ) : (
            <>
              <TimelineChart bars={usage.timeline} height={72} />
              <TimelineLegend />
            </>
          )}

          {agents.length > 0 && (
            <div className="flex flex-col gap-1">
              {agents.map((row) => {
                const t = totalTokens(row);
                const live = lanes.get(row.key)?.status === "running";
                return (
                  <div key={row.key} className="flex items-center gap-2 text-[11.5px]">
                    <span className="w-[120px] min-w-0 shrink-0 truncate" style={{ color: "var(--vb-text-dim)" }} title={row.label}>
                      {row.label}
                    </span>
                    <span className="h-[6px] min-w-0 flex-1 overflow-hidden rounded-[1px]" style={{ background: "var(--vb-fill)" }}>
                      <span
                        className="block h-full transition-[width] duration-300 motion-reduce:transition-none"
                        style={{
                          width: `${Math.max(2, (t / maxAgent) * 100)}%`,
                          background: live ? "var(--vb-accent)" : "var(--vb-text-faint)",
                        }}
                      />
                    </span>
                    <span className="w-[52px] shrink-0 text-right font-mono tabular-nums" style={{ color: "var(--vb-text)" }}>
                      {formatTok(t)}
                    </span>
                    <span className="w-[48px] shrink-0 text-right font-mono tabular-nums" style={{ color: "var(--vb-text-faint)" }}>
                      {formatUsd(row.costUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

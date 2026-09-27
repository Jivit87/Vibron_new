"use client";

/**
 * Usage panel (bottom panel tab, formerly the token ledger).
 *
 * Totals, a per-call timeline, breakdowns by model / agent / source, where
 * the context tokens went (files and symbols), and the three savings
 * mechanisms accounted separately, because they are genuinely different
 * wins:
 *
 *   graph      answering from a symbol slice instead of whole files
 *   dedupe     refusing to re-send content already in the conversation
 *   cache      provider-side prompt caching on the stable prefix
 *
 * Scope: this run, this conversation, or the session.
 */

import { useMemo, useState } from "react";
import { Flame } from "lucide-react";

import { useUsageStore } from "@/store/usage";
import { useViberon } from "@/store/viberon";
import {
  cacheHitRate,
  cacheSavings,
  formatPercent,
  formatTok,
  formatUsd,
  graphSavings,
  promptTokens,
  totalTokens,
  type ContextStat,
  type UsageRow,
  type UsageSummary,
} from "@/lib/client/usage";
import {
  ContextMeter,
  fillFor,
  fillTitle,
  SCOPE_LABEL,
  ScopeSwitch,
  TimelineChart,
  TimelineLegend,
  useUsage,
} from "@/components/vibe/usage-ui";
import { EmptyState, IconButton, PanelHeader, Segmented, splitPath } from "@/components/vibe/primitives";

export function LedgerPanel() {
  const { scope, usage } = useUsage();
  const graphHeat = useUsageStore((s) => s.graphHeat);
  const empty = totalTokens(usage.totals) === 0 && usage.totals.costUsd === 0 && usage.context.sent === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Usage"
        actions={
          <div className="flex items-center gap-1.5">
            <ScopeSwitch />
            <IconButton
              title={graphHeat ? "Hide token heatmap on the graph" : "Show token heatmap on the graph"}
              active={graphHeat}
              onClick={() => {
                const store = useViberon.getState();
                const next = !useUsageStore.getState().graphHeat;
                useUsageStore.getState().setGraphHeat(next);
                if (next) {
                  store.setAppMode("ide");
                  store.openGraphTab();
                }
              }}
            >
              <Flame className="size-3.5" />
            </IconButton>
          </div>
        }
      />

      {empty ? (
        <EmptyState
          title={scope === "run" ? "No run yet" : `No usage in ${SCOPE_LABEL[scope].toLowerCase()}`}
          body="Once agents start working, this shows tokens and cost per call, where the context went, and what graph retrieval, dedupe and prompt caching saved."
        />
      ) : (
        <div className="@container min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 px-3 py-3">
            <Totals usage={usage} />
            <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <Section
                title={scope === "run" ? "Per call" : "Per run"}
                aside={<TimelineLegend />}
              >
                {usage.timeline.length > 0 ? (
                  <TimelineChart bars={usage.timeline} />
                ) : (
                  <Muted>No calls recorded.</Muted>
                )}
              </Section>
              <Savings usage={usage} />
            </div>
            <div className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
              <Breakdown title="By model" rows={usage.byModel} />
              <Breakdown title="By agent" rows={usage.byAgent} showDetail />
              <Sources usage={usage} />
            </div>
            <TopContext usage={usage} />
            {scope === "run" && <RecentReads />}
          </div>
        </div>
      )}
    </div>
  );
}

export { LedgerPanel as UsagePanel };

/* -------------------------------- pieces ---------------------------------- */

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-h-[18px] items-center gap-3">
        <span className="vb-label">{title}</span>
        <span className="flex-1" />
        {aside}
      </div>
      {children}
    </section>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[12px]" style={{ color: "var(--vb-text-faint)" }}>
      {children}
    </p>
  );
}

function Figure({ label, value, sub, title }: { label: string; value: string; sub?: string; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="font-mono text-[13px] tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
          {value}
        </span>
        {sub && (
          <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--vb-text-faint)" }}>
            {sub}
          </span>
        )}
      </span>
    </div>
  );
}

function Totals({ usage }: { usage: UsageSummary }) {
  const t = usage.totals;
  const prompt = promptTokens(t);
  const fill = fillFor(usage);
  return (
    <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
      <Figure label="Total tokens" value={formatTok(totalTokens(t))} sub={`${usage.runs} run${usage.runs === 1 ? "" : "s"}`} />
      <Figure label="Input" value={formatTok(t.input)} title="Uncached prompt tokens, full input price" />
      <Figure
        label="Cache read"
        value={formatTok(t.cacheRead)}
        sub={prompt > 0 ? formatPercent(cacheHitRate(t)) : undefined}
        title="Prompt tokens served from the provider cache, about 10% of the input price"
      />
      {t.cacheWrite > 0 && (
        <Figure label="Cache write" value={formatTok(t.cacheWrite)} title="Prompt tokens written to the cache, about 125% of the input price" />
      )}
      <Figure label="Output" value={formatTok(t.output)} />
      <Figure label="Cost" value={formatUsd(t.costUsd)} sub={formatUsd(t.uncachedUsd) !== formatUsd(t.costUsd) ? `of ${formatUsd(t.uncachedUsd)}` : undefined} title="Billed cost, and what it would have been without prompt caching" />
      {fill && usage.lastContext && (
        <div className="flex min-w-[140px] flex-col gap-1" title={fillTitle(fill, usage.lastContext.model)}>
          <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            Context window
          </span>
          <span className="flex items-center gap-2">
            <ContextMeter fill={fill} width={72} height={4} />
            <span className="font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text)" }}>
              {formatTok(fill.used)} / {formatTok(fill.window)}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

/** A 2px proportion bar under a row. */
function ShareBar({ ratio, tone = "var(--vb-text-faint)" }: { ratio: number; tone?: string }) {
  return (
    <span className="block h-[2px] w-full overflow-hidden rounded-[1px]" style={{ background: "var(--vb-fill)" }}>
      <span className="block h-full" style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: tone }} />
    </span>
  );
}

function Breakdown({ title, rows, showDetail = false }: { title: string; rows: UsageRow[]; showDetail?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => totalTokens(r)));
  return (
    <Section title={title}>
      {rows.length === 0 ? (
        <Muted>Nothing yet.</Muted>
      ) : (
        <div className="flex flex-col">
          <HeaderRow cols={["", "tokens", "cost"]} />
          {rows.slice(0, 8).map((row) => (
            <div key={row.key} className="flex flex-col gap-0.5 py-1" title={rowTitle(row)}>
              <div className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
                  {row.label}
                  {showDetail && row.detail && row.detail !== row.label && (
                    <span className="ml-1.5 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                      {row.detail}
                    </span>
                  )}
                </span>
                <span className="w-[56px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-mid)" }}>
                  {formatTok(totalTokens(row))}
                </span>
                <span className="w-[60px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
                  {formatUsd(row.costUsd)}
                </span>
              </div>
              <ShareBar ratio={totalTokens(row) / max} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function rowTitle(row: UsageRow): string {
  return [
    `${formatTok(row.input)} input`,
    `${formatTok(row.cacheRead)} cache read`,
    row.cacheWrite > 0 ? `${formatTok(row.cacheWrite)} cache write` : "",
    `${formatTok(row.output)} output`,
    row.calls > 0 ? `${row.calls} call${row.calls === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function HeaderRow({ cols }: { cols: string[] }) {
  return (
    <div className="flex items-center gap-2 pb-0.5 text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
      <span className="flex-1">{cols[0]}</span>
      {cols.slice(1).map((c, i) => (
        <span key={c} className={i === 0 ? "w-[56px] text-right" : "w-[60px] text-right"}>
          {c}
        </span>
      ))}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  graph_slice: "graph_search",
  read_file: "read_file",
  symbol_outline: "symbol_outline",
  grep: "grep",
  find_symbols: "find_symbols",
  view: "view",
};

function Sources({ usage }: { usage: UsageSummary }) {
  const rows = usage.bySource;
  const max = Math.max(1, ...rows.map((r) => r.tokens + r.dedupedTokens));
  return (
    <Section title="Context by tool">
      {rows.length === 0 ? (
        <Muted>No context reads recorded.</Muted>
      ) : (
        <div className="flex flex-col">
          <HeaderRow cols={["", "calls", "tokens"]} />
          {rows.slice(0, 8).map((row) => (
            <div
              key={row.source}
              className="flex flex-col gap-0.5 py-1"
              title={row.dedupedTokens > 0 ? `${formatTok(row.dedupedTokens)} more tokens held back by dedupe` : undefined}
            >
              <div className="flex items-center gap-2 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]" style={{ color: "var(--vb-text)" }}>
                  {SOURCE_LABEL[row.source] ?? row.source}
                </span>
                <span className="w-[56px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-mid)" }}>
                  {row.count}
                </span>
                <span className="w-[60px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
                  {formatTok(row.tokens)}
                </span>
              </div>
              <ShareBar ratio={row.tokens / max} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function Savings({ usage }: { usage: UsageSummary }) {
  const graph = graphSavings(usage.context);
  const cache = cacheSavings(usage.totals);
  const hit = cacheHitRate(usage.totals);
  const deduped = usage.context.deduped;
  const nothing = graph.tokens === 0 && cache.usd === 0 && deduped === 0;

  return (
    <Section title="Savings">
      {nothing ? (
        <Muted>No savings recorded yet.</Muted>
      ) : (
        <div className="flex flex-col gap-3">
          {usage.context.baseline > 0 && (
            <Saving
              title="Graph retrieval"
              value={`${formatTok(graph.tokens)} tok`}
              ratio={graph.percent / 100}
              note={`${formatTok(usage.context.sent)} tokens of symbol slices and file windows instead of ${formatTok(usage.context.baseline)} for the whole files: ${graph.percent}% less.`}
            />
          )}
          {deduped > 0 && (
            <Saving
              title="Repeat-read dedupe"
              value={`${formatTok(deduped)} tok`}
              ratio={usage.context.sent + deduped > 0 ? deduped / (usage.context.sent + deduped) : 0}
              note="Chunks an agent had already been given came back as a one-line pointer instead of the bytes."
            />
          )}
          {cache.usd > 0 && (
            <Saving
              title="Prompt caching"
              value={formatUsd(cache.usd)}
              ratio={cache.percent / 100}
              note={`${formatPercent(hit)} of prompt tokens were cache reads. ${formatUsd(usage.totals.costUsd)} billed against ${formatUsd(usage.totals.uncachedUsd)} uncached.`}
            />
          )}
        </div>
      )}
    </Section>
  );
}

function Saving({ title, value, ratio, note }: { title: string; value: string; ratio: number; note: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-[12px]">
        <span style={{ color: "var(--vb-text)" }}>{title}</span>
        <span className="flex-1" />
        <span className="font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
          {value}
        </span>
        <span className="w-[34px] text-right font-mono text-[11px] tabular-nums" style={{ color: "var(--vb-text-dim)" }}>
          {formatPercent(ratio)}
        </span>
      </div>
      <ShareBar ratio={ratio} tone="var(--vb-text-dim)" />
      <p className="text-[11.5px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
        {note}
      </p>
    </div>
  );
}

function TopContext({ usage }: { usage: UsageSummary }) {
  const [kind, setKind] = useState<"files" | "symbols">("files");
  const graph = useViberon((s) => s.graph);
  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n] as const)), [graph]);

  const rows = kind === "files" ? usage.files : usage.nodes;
  const shown = rows.filter((r) => r.sentTokens > 0 || r.dedupedTokens > 0).slice(0, 12);
  const max = Math.max(1, ...shown.map((r) => r.sentTokens));

  const open = (stat: ContextStat) => {
    const store = useViberon.getState();
    const path = kind === "files" ? stat.key : nodeById.get(stat.key)?.file;
    if (!path) return;
    store.setAppMode("ide");
    store.openTab(path, undefined, { preview: true });
    if (kind === "symbols") store.selectNode(stat.key);
  };

  return (
    <Section
      title="Top context"
      aside={
        <Segmented<"files" | "symbols">
          value={kind}
          options={[
            { value: "files", label: "Files" },
            { value: "symbols", label: "Symbols" },
          ]}
          onChange={setKind}
        />
      }
    >
      {shown.length === 0 ? (
        <Muted>
          {kind === "files" ? "No file reads attributed" : "No symbols attributed"} in this scope.
        </Muted>
      ) : (
        <div className="flex flex-col">
          <div className="flex items-center gap-2 pb-0.5 text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
            <span className="flex-1" />
            <span className="w-[44px] text-right">reads</span>
            <span className="w-[64px] text-right">deduped</span>
            <span className="w-[56px] text-right">tokens</span>
          </div>
          {shown.map((stat) => {
            const node = kind === "symbols" ? nodeById.get(stat.key) : undefined;
            const { name, dir } =
              kind === "files"
                ? splitPath(stat.key)
                : { name: node?.name ?? stat.key.split(/[#:]/).pop() ?? stat.key, dir: node?.file ?? "" };
            const openable = kind === "files" || Boolean(node);
            return (
              <button
                key={stat.key}
                type="button"
                disabled={!openable}
                onClick={() => open(stat)}
                className="group flex flex-col gap-0.5 rounded-[2px] px-1 py-1 text-left hover:bg-[var(--vb-hover)] disabled:hover:bg-transparent"
                title={openable ? `Open ${kind === "files" ? stat.key : dir}` : stat.key}
              >
                <span className="flex w-full items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">
                    <span style={{ color: "var(--vb-text)" }}>{name}</span>
                    {dir && (
                      <span className="ml-2 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                        {dir}
                      </span>
                    )}
                  </span>
                  <span className="w-[44px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-dim)" }}>
                    {stat.reads}
                  </span>
                  <span className="w-[64px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-faint)" }}>
                    {stat.dedupedTokens > 0 ? formatTok(stat.dedupedTokens) : "–"}
                  </span>
                  <span className="w-[56px] text-right font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
                    {formatTok(stat.sentTokens)}
                  </span>
                </span>
                <ShareBar ratio={stat.sentTokens / max} tone="var(--vb-accent)" />
              </button>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/** The run's raw context events, newest first (the old ledger list). */
function RecentReads() {
  const events = useViberon((s) => s.run?.ledger?.events);
  const [open, setOpen] = useState(false);
  if (!events || events.length === 0) return null;
  const shown = events.slice(-(open ? 60 : 8)).reverse();
  return (
    <Section
      title="Context reads"
      aside={
        events.length > 8 ? (
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => setOpen((v) => !v)}>
            {open ? "Show fewer" : `Show ${Math.min(60, events.length)}`}
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col">
        {shown.map((event, index) => (
          <div key={index} className="flex h-[22px] items-center gap-2 font-mono text-[11px]">
            <span className="w-[104px] shrink-0 truncate" style={{ color: "var(--vb-text-mid)" }}>
              {SOURCE_LABEL[event.source] ?? event.source}
            </span>
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text-dim)" }} title={event.label}>
              {event.label}
            </span>
            <span
              className="shrink-0 tabular-nums"
              style={{ color: event.deduped ? "var(--vb-text-faint)" : "var(--vb-text-mid)" }}
            >
              {event.deduped ? `deduped ${formatTok(event.tokens)}` : formatTok(event.tokens)}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

export default LedgerPanel;

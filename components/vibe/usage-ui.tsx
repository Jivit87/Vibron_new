"use client";

/**
 * Shared usage UI: the scope hook, the context meter, the per-turn timeline
 * chart, the status-bar chip with its breakdown popover, and the dim
 * per-message usage line. The full panel lives in `LedgerPanel.tsx`.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useUsageStore } from "@/store/usage";
import { useViberon, type ChatMessage } from "@/store/viberon";
import {
  cacheSavings,
  contextFill,
  formatPercent,
  formatTok,
  formatUsd,
  graphSavings,
  modelLabel as usageModelLabel,
  promptTokens,
  scopeUsage,
  totalTokens,
  type ContextFill,
  type UsageBar,
  type UsageScope,
  type UsageSummary,
  type UsageTotals,
} from "@/lib/client/usage";
import { cx, Segmented } from "@/components/vibe/primitives";

export const SCOPE_OPTIONS: { value: UsageScope; label: string; title: string }[] = [
  { value: "run", label: "Run", title: "The current or most recent run" },
  { value: "conversation", label: "Chat", title: "Every run in this conversation" },
  { value: "session", label: "Session", title: "Every run since the app started" },
];

export const SCOPE_LABEL: Record<UsageScope, string> = {
  run: "This run",
  conversation: "This conversation",
  session: "This session",
};

/** Usage for a scope (defaults to the shared scope), recomputed on change. */
export function useUsage(scopeOverride?: UsageScope): { scope: UsageScope; usage: UsageSummary } {
  const shared = useUsageStore((s) => s.scope);
  const scope = scopeOverride ?? shared;
  const run = useViberon((s) => s.run);
  const conversationRuns = useViberon((s) => s.conversationRuns);
  const sessionRuns = useUsageStore((s) => s.sessionRuns);
  const extra = useUsageStore((s) => (run ? s.live[run.id] : undefined));
  const usage = useMemo(
    () => scopeUsage({ scope, run, conversationRuns, sessionRuns, extra }),
    [scope, run, conversationRuns, sessionRuns, extra],
  );
  return { scope, usage };
}

export function ScopeSwitch() {
  const scope = useUsageStore((s) => s.scope);
  return (
    <Segmented<UsageScope>
      value={scope}
      options={SCOPE_OPTIONS}
      onChange={(next) => useUsageStore.getState().setScope(next)}
    />
  );
}

export function fillFor(usage: UsageSummary): ContextFill | null {
  return usage.lastContext ? contextFill(usage.lastContext.tokens, usage.lastContext.model) : null;
}

function fillColor(fill: ContextFill): string {
  return fill.level === "high" ? "var(--vb-rose)" : fill.level === "warn" ? "var(--vb-amber)" : "var(--vb-text-mid)";
}

/** A thin context-window meter. Neutral until it gets genuinely full. */
export function ContextMeter({
  fill,
  width = 36,
  height = 3,
}: {
  fill: ContextFill;
  width?: number;
  height?: number;
}) {
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-[1px]"
      style={{ width, height, background: "var(--vb-fill)" }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={fill.window}
      aria-valuenow={fill.used}
      aria-label="Context window used"
    >
      <span
        className="block h-full"
        style={{ width: `${Math.max(2, fill.ratio * 100)}%`, background: fillColor(fill) }}
      />
    </span>
  );
}

export function fillTitle(fill: ContextFill, model: string): string {
  return `Context window: ${formatTok(fill.used)} of ${formatTok(fill.window)} (${formatPercent(fill.ratio)}) on ${model}`;
}

/* ------------------------------ status chip ------------------------------- */

export function UsageChip() {
  const { scope, usage } = useUsage();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (totalTokens(usage.totals) === 0 && usage.totals.costUsd === 0) return null;
  const fill = fillFor(usage);

  return (
    <div ref={ref} className="relative flex h-full items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Token usage · ${SCOPE_LABEL[scope].toLowerCase()}`}
        className={cx(
          "flex h-full items-center gap-1.5 whitespace-nowrap px-1.5 hover:bg-[var(--vb-hover)]",
          open && "bg-[var(--vb-active)]",
        )}
        data-testid="usage-chip"
      >
        <span className="font-mono tabular-nums">
          {formatTok(totalTokens(usage.totals))} tok · {formatUsd(usage.totals.costUsd)}
        </span>
        {fill && <ContextMeter fill={fill} width={28} />}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Token usage"
          className="vb-pop absolute bottom-[calc(100%+4px)] right-0 z-50 w-[320px]"
        >
          <UsagePopoverBody usage={usage} scope={scope} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  hint,
  strong = false,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  strong?: boolean;
  tone?: string;
}) {
  return (
    <div className="flex h-[20px] items-center gap-2 text-[12px]">
      <span style={{ color: "var(--vb-text-dim)" }}>{label}</span>
      <span className="flex-1" />
      {hint && (
        <span className="font-mono text-[11px] tabular-nums" style={{ color: "var(--vb-text-faint)" }}>
          {hint}
        </span>
      )}
      <span
        className="font-mono tabular-nums"
        style={{ color: tone ?? (strong ? "var(--vb-text-hi)" : "var(--vb-text)") }}
      >
        {value}
      </span>
    </div>
  );
}

function share(part: number, whole: number): string | undefined {
  return whole > 0 && part > 0 ? formatPercent(part / whole) : undefined;
}

function UsagePopoverBody({
  usage,
  scope,
  onClose,
}: {
  usage: UsageSummary;
  scope: UsageScope;
  onClose: () => void;
}) {
  const t = usage.totals;
  const prompt = promptTokens(t);
  const cache = cacheSavings(t);
  const graph = graphSavings(usage.context);
  const fill = fillFor(usage);

  return (
    <div className="flex flex-col">
      <div className="flex h-[32px] items-center gap-2 border-b px-3" style={{ borderColor: "var(--vb-line)" }}>
        <span className="text-[12px] font-medium" style={{ color: "var(--vb-text-hi)" }}>
          Usage
        </span>
        <span className="flex-1" />
        <ScopeSwitch />
      </div>

      <div className="flex flex-col px-3 py-2">
        <Row label="Input" value={formatTok(t.input)} hint={share(t.input, prompt)} />
        <Row label="Cache read" value={formatTok(t.cacheRead)} hint={share(t.cacheRead, prompt)} />
        {t.cacheWrite > 0 && <Row label="Cache write" value={formatTok(t.cacheWrite)} hint={share(t.cacheWrite, prompt)} />}
        <Row label="Output" value={formatTok(t.output)} />
        <Row label="Total" value={formatTok(totalTokens(t))} strong />
      </div>

      <div className="flex flex-col border-t px-3 py-2" style={{ borderColor: "var(--vb-line)" }}>
        <Row label="Cost" value={formatUsd(t.costUsd)} strong />
        <Row label="Without caching" value={formatUsd(t.uncachedUsd)} />
        {cache.usd > 0 && <Row label="Cache saved" value={formatUsd(cache.usd)} hint={`${cache.percent}%`} />}
        {graph.tokens > 0 && (
          <Row label="Graph retrieval saved" value={`${formatTok(graph.tokens)} tok`} hint={`${graph.percent}%`} />
        )}
        {usage.context.deduped > 0 && <Row label="Dedupe avoided" value={`${formatTok(usage.context.deduped)} tok`} />}
      </div>

      {fill && usage.lastContext && (
        <div className="flex flex-col gap-1 border-t px-3 py-2" style={{ borderColor: "var(--vb-line)" }}>
          <div className="flex items-center gap-2 text-[12px]">
            <span style={{ color: "var(--vb-text-dim)" }}>Context window</span>
            <span className="flex-1" />
            <span className="font-mono text-[11.5px] tabular-nums" style={{ color: "var(--vb-text)" }}>
              {formatTok(fill.used)} / {formatTok(fill.window)}
            </span>
          </div>
          <ContextMeter fill={fill} width={294} height={4} />
          <span className="text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            Last call on {usageModelLabel(usage.lastContext.model)} · {formatPercent(fill.ratio)} full
          </span>
        </div>
      )}

      {usage.byModel.length > 0 && (
        <div className="flex flex-col border-t px-3 py-2" style={{ borderColor: "var(--vb-line)" }}>
          <span className="vb-label pb-1">By model</span>
          {usage.byModel.slice(0, 4).map((row) => (
            <Row key={row.key} label={row.label} value={formatUsd(row.costUsd)} hint={`${formatTok(totalTokens(row))} tok`} />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 border-t px-3 py-1.5" style={{ borderColor: "var(--vb-line)" }}>
        <span className="min-w-0 truncate text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {SCOPE_LABEL[scope]} · {usage.runs} run{usage.runs === 1 ? "" : "s"}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="vb-btn vb-btn-ghost"
          onClick={() => {
            onClose();
            const store = useViberon.getState();
            store.setAppMode("ide");
            store.setBottomPanel("ledger");
          }}
        >
          Open usage panel
        </button>
      </div>
    </div>
  );
}


/* ------------------------------- timeline --------------------------------- */

const SEGMENTS: { key: keyof UsageTotals; label: string; color: string }[] = [
  { key: "cacheRead", label: "Cache read", color: "var(--vb-line-strong)" },
  { key: "cacheWrite", label: "Cache write", color: "var(--vb-text-faint)" },
  { key: "input", label: "Input", color: "var(--vb-text-dim)" },
  { key: "output", label: "Output", color: "var(--vb-accent)" },
];

export function TimelineLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
      {SEGMENTS.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="inline-block size-2 rounded-[1px]" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Stacked bars, one per model call (run scope) or per run (wider scopes).
 * Plain SVG: the chart is small and must follow the theme tokens exactly.
 */
export function TimelineChart({ bars, height = 96 }: { bars: UsageBar[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const max = Math.max(1, ...bars.map((b) => totalTokens(b)));
  const axisW = 36;
  const plotW = Math.max(0, width - axisW);
  const gap = bars.length > 60 ? 1 : 2;
  const barW = bars.length ? Math.max(1, Math.min(bars.length < 12 ? 24 : 16, plotW / bars.length - gap)) : 0;
  const top = 8;
  const plotH = height - 14 - top;
  const hovered = hover !== null ? bars[hover] : null;

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} className="block" role="img" aria-label="Tokens per call">
          {[0, 0.5, 1].map((f) => {
            const y = Math.round(top + plotH - f * plotH) + 0.5;
            return (
              <g key={f}>
                <line x1={axisW} x2={width} y1={y} y2={y} stroke="var(--vb-line-faint)" strokeWidth={1} />
                <text
                  x={axisW - 6}
                  y={y + 3}
                  textAnchor="end"
                  fontSize={10}
                  fontFamily="var(--font-mono)"
                  fill="var(--vb-text-faint)"
                >
                  {f === 0 ? "0" : formatTok(max * f)}
                </text>
              </g>
            );
          })}
          {bars.map((bar, i) => {
            const x = axisW + i * (barW + gap) + gap / 2;
            let y = top + plotH;
            const dim = hover !== null && hover !== i;
            return (
              <g key={i} opacity={dim ? 0.45 : 1}>
                {SEGMENTS.map((s) => {
                  const v = bar[s.key] as number;
                  if (!(v > 0)) return null;
                  const h = Math.max(0.5, (v / max) * plotH);
                  y -= h;
                  return <rect key={s.key} x={x} y={y} width={barW} height={h} fill={s.color} />;
                })}
                <rect
                  x={x - gap / 2}
                  y={0}
                  width={barW + gap}
                  height={plotH + top}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((cur) => (cur === i ? null : cur))}
                />
              </g>
            );
          })}
          <text x={axisW} y={height - 2} fontSize={10} fontFamily="var(--font-mono)" fill="var(--vb-text-faint)">
            {bars.length ? timeLabel(bars[0].at) : ""}
          </text>
          <text
            x={width}
            y={height - 2}
            textAnchor="end"
            fontSize={10}
            fontFamily="var(--font-mono)"
            fill="var(--vb-text-faint)"
          >
            {bars.length > 1 ? timeLabel(bars[bars.length - 1].at) : ""}
          </text>
        </svg>
      )}
      {hovered && hover !== null && wrapRef.current && (
        <BarTooltip bar={hovered} anchor={wrapRef.current.getBoundingClientRect()} x={axisW + hover * (barW + gap) + barW / 2} />
      )}
    </div>
  );
}

function timeLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Fixed-position so the panel's scroll container cannot clip it; flips
 * below the chart when there is no room above.
 */
function BarTooltip({ bar, anchor, x }: { bar: UsageBar; anchor: DOMRect; x: number }) {
  const width = 220;
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const left = Math.min(Math.max(8, anchor.left + x - width / 2), vw - width - 8);
  const above = anchor.top > 190;
  return (
    <div
      className="vb-pop pointer-events-none fixed z-50 px-2.5 py-2"
      style={{
        left,
        width,
        top: above ? anchor.top - 6 : anchor.bottom + 6,
        transform: above ? "translateY(-100%)" : undefined,
      }}
    >
      <div className="truncate text-[11.5px]" style={{ color: "var(--vb-text-hi)" }} title={bar.label}>
        {bar.label || "Call"}
      </div>
      <div className="pb-1 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
        {timeLabel(bar.at)}
        {bar.model ? ` · ${usageModelLabel(bar.model)}` : ""}
      </div>
      {[...SEGMENTS].reverse().map((s) =>
        (bar[s.key] as number) > 0 ? (
          <div key={s.key} className="flex items-center gap-1.5 text-[11px]">
            <span className="inline-block size-2 rounded-[1px]" style={{ background: s.color }} />
            <span style={{ color: "var(--vb-text-dim)" }}>{s.label}</span>
            <span className="flex-1" />
            <span className="font-mono tabular-nums" style={{ color: "var(--vb-text)" }}>
              {formatTok(bar[s.key] as number)}
            </span>
          </div>
        ) : null,
      )}
      <div className="mt-1 flex items-center border-t pt-1 text-[11px]" style={{ borderColor: "var(--vb-line)" }}>
        <span style={{ color: "var(--vb-text-dim)" }}>Cost</span>
        <span className="flex-1" />
        <span className="font-mono tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
          {formatUsd(bar.costUsd)}
        </span>
      </div>
    </div>
  );
}

/* ---------------------------- per-message line ---------------------------- */

/** "24.1k in · 1.9k out · 14.4k cached · $0.041" under an assistant reply. */
export function MessageUsage({ message }: { message: ChatMessage }) {
  const receipt = useViberon((s) =>
    s.conversationRuns.find((r) => r.messageId === message.id || (message.runId && r.id === message.runId)),
  );
  const totals = useMemo<UsageTotals | null>(() => {
    if (receipt?.usage) return receipt.usage.totals;
    if (receipt) {
      return {
        input: receipt.tokensIn,
        output: receipt.tokensOut,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: receipt.costUsd,
        uncachedUsd: receipt.costUsd,
      };
    }
    return null;
  }, [receipt]);
  // A live run has no receipt yet; its header carries the running total.
  if (!totals || totalTokens(totals) === 0) return null;
  const prompt = totals.input + totals.cacheWrite;
  return <UsageLine totals={{ ...totals, input: prompt }} />;
}

export function UsageLine({ totals }: { totals: UsageTotals }) {
  const parts = [`${formatTok(totals.input)} in`, `${formatTok(totals.output)} out`];
  if (totals.cacheRead > 0) parts.push(`${formatTok(totals.cacheRead)} cached`);
  return (
    <div
      className="font-mono text-[10.5px] tabular-nums"
      style={{ color: "var(--vb-text-faint)" }}
      title="Tokens and cost for the run that produced this reply"
    >
      {parts.join(" · ")} · {formatUsd(totals.costUsd)}
    </div>
  );
}

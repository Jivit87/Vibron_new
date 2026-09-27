/**
 * Token usage model for the client.
 *
 * One shape, `UsageSummary`, describes usage at every scope the UI offers:
 * a single run, a conversation (its runs, persisted with the thread), and
 * the session (every run since the app started). A run's summary is derived
 * from its `RunState`; wider scopes are merges of run summaries. Everything
 * here is pure so the aggregation is unit-tested without React or storage.
 *
 * Token vocabulary, matching the providers:
 *   input       uncached prompt tokens, billed at the full input rate
 *   cacheRead   prompt tokens served from the provider cache (~10% price)
 *   cacheWrite  prompt tokens written to the cache (~125% price)
 *   output      completion tokens
 */

import { MODELS } from "@/lib/ai/models";
import type { LedgerSnapshot } from "@/lib/context/ledger";
import type { RunState } from "@/lib/client/run-reducer";

/** One model call's usage, from a `turn_usage` event. */
export interface TurnUsageRecord {
  agentId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  uncachedUsd: number;
  contextTokens: number;
  at: number;
}

/**
 * Usage the run reducer does not keep: per-call records and cache writes.
 * Held by the usage store (`store/usage.ts`), keyed by run id.
 */
export interface RunUsageExtra {
  turns: TurnUsageRecord[];
  cacheWrite: number;
}

export type UsageScope = "run" | "conversation" | "session";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  /** What the same traffic would have cost with no prompt caching. */
  uncachedUsd: number;
}

/** One bar in the timeline: a model call (run scope) or a whole run. */
export interface UsageBar extends UsageTotals {
  at: number;
  label: string;
  model?: string;
  /** Prompt + reply size of the call, for the context-window meter. */
  contextTokens?: number;
}

/** A breakdown row (by model, or by agent). */
export interface UsageRow extends UsageTotals {
  key: string;
  label: string;
  /** Role for agent rows; provider-ish detail for model rows. */
  detail?: string;
  calls: number;
}

export interface UsageSourceRow {
  source: string;
  tokens: number;
  dedupedTokens: number;
  count: number;
}

/** Context delivered from a file (key = path) or a graph node (key = id). */
export interface ContextStat {
  key: string;
  sentTokens: number;
  dedupedTokens: number;
  reads: number;
}

export interface UsageSummary {
  runs: number;
  totals: UsageTotals;
  byModel: UsageRow[];
  byAgent: UsageRow[];
  bySource: UsageSourceRow[];
  files: ContextStat[];
  nodes: ContextStat[];
  /** Ledger accounting: what went in, what dedupe held back, the naive baseline. */
  context: { sent: number; deduped: number; baseline: number; saved: number };
  timeline: UsageBar[];
  /** Size of the most recent call's context, and the model it ran on. */
  lastContext?: { model: string; tokens: number };
  startedAt?: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  costUsd: 0,
  uncachedUsd: 0,
};

export function emptySummary(): UsageSummary {
  return {
    runs: 0,
    totals: { ...EMPTY_TOTALS },
    byModel: [],
    byAgent: [],
    bySource: [],
    files: [],
    nodes: [],
    context: { sent: 0, deduped: 0, baseline: 0, saved: 0 },
    timeline: [],
  };
}

/* ------------------------------ arithmetic -------------------------------- */

export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
    uncachedUsd: a.uncachedUsd + b.uncachedUsd,
  };
}

function subTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
    uncachedUsd: Math.max(0, a.uncachedUsd - b.uncachedUsd),
  };
}

function pickTotals(t: UsageTotals): UsageTotals {
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    costUsd: t.costUsd,
    uncachedUsd: t.uncachedUsd,
  };
}

/** Every prompt token, cached or not. */
export function promptTokens(t: UsageTotals): number {
  return t.input + t.cacheRead + t.cacheWrite;
}

export function totalTokens(t: UsageTotals): number {
  return promptTokens(t) + t.output;
}

function isEmpty(t: UsageTotals): boolean {
  return totalTokens(t) === 0 && t.costUsd === 0;
}

function turnTotals(turn: TurnUsageRecord): UsageTotals {
  return {
    input: turn.inputTokens,
    output: turn.outputTokens,
    cacheRead: turn.cacheReadTokens,
    cacheWrite: turn.cacheWriteTokens,
    costUsd: turn.costUsd,
    uncachedUsd: turn.uncachedUsd,
  };
}

/** Field-wise max: live turns can run ahead of the last `ledger` total. */
function maxTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    input: Math.max(a.input, b.input),
    output: Math.max(a.output, b.output),
    cacheRead: Math.max(a.cacheRead, b.cacheRead),
    cacheWrite: Math.max(a.cacheWrite, b.cacheWrite),
    costUsd: Math.max(a.costUsd, b.costUsd),
    uncachedUsd: Math.max(a.uncachedUsd, b.uncachedUsd),
  };
}

/* ------------------------------- per run ---------------------------------- */

/** The run's authoritative totals, from the latest `ledger` event. */
export function runTotals(run: RunState, extra?: RunUsageExtra): UsageTotals {
  const cached = run.tokensCached ?? 0;
  const fromLedger: UsageTotals = {
    input: Math.max(0, (run.tokensIn ?? 0) - cached),
    output: run.tokensOut ?? 0,
    cacheRead: cached,
    cacheWrite: extra?.cacheWrite ?? 0,
    costUsd: run.costUsd ?? 0,
    uncachedUsd: Math.max(run.uncachedUsd ?? 0, run.costUsd ?? 0),
  };
  const fromTurns = (extra?.turns ?? []).reduce(
    (sum, turn) => addTotals(sum, turnTotals(turn)),
    { ...EMPTY_TOTALS },
  );
  return maxTotals(fromLedger, fromTurns);
}

function upsertRow(
  rows: Map<string, UsageRow>,
  key: string,
  label: string,
  totals: UsageTotals,
  calls: number,
  detail?: string,
): void {
  const row = rows.get(key);
  if (row) {
    Object.assign(row, addTotals(row, totals));
    row.calls += calls;
    if (!row.detail && detail) row.detail = detail;
  } else {
    rows.set(key, { key, label, detail, calls, ...pickTotals(totals) });
  }
}

function byCost(a: UsageRow, b: UsageRow): number {
  return b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a);
}

export function modelLabel(id: string): string {
  if (!id || id === "auto") return "Auto";
  return MODELS.find((m) => m.id === id)?.label ?? id.replace(/^(openai|gemini|nvidia):/, "");
}

/** Ledger attribution, tolerant of producers that predate it. */
function contextFromLedger(ledger: LedgerSnapshot | undefined): Pick<
  UsageSummary,
  "bySource" | "files" | "nodes" | "context"
> {
  if (!ledger) {
    return { bySource: [], files: [], nodes: [], context: { sent: 0, deduped: 0, baseline: 0, saved: 0 } };
  }
  let bySource: UsageSourceRow[] = ledger.sources?.map((s) => ({ ...s })) ?? [];
  let files: ContextStat[] =
    ledger.files?.map((f) => ({
      key: f.path,
      sentTokens: f.sentTokens,
      dedupedTokens: f.dedupedTokens,
      reads: f.reads,
    })) ?? [];
  let nodes: ContextStat[] =
    ledger.nodes?.map((n) => ({
      key: n.id,
      sentTokens: n.sentTokens,
      dedupedTokens: n.dedupedTokens,
      reads: n.reads,
    })) ?? [];

  // Older snapshots: rebuild what we can from the (capped) event list.
  if (!ledger.sources || !ledger.files || !ledger.nodes) {
    const sources = new Map<string, UsageSourceRow>();
    const fileMap = new Map<string, ContextStat>();
    const nodeMap = new Map<string, ContextStat>();
    const spread = (map: Map<string, ContextStat>, keys: string[], tokens: number, deduped: boolean) => {
      const share = tokens / keys.length;
      for (const key of keys) {
        const stat = map.get(key) ?? { key, sentTokens: 0, dedupedTokens: 0, reads: 0 };
        stat.reads += 1;
        if (deduped) stat.dedupedTokens += share;
        else stat.sentTokens += share;
        map.set(key, stat);
      }
    };
    for (const event of ledger.events ?? []) {
      const row = sources.get(event.source) ?? { source: event.source, tokens: 0, dedupedTokens: 0, count: 0 };
      row.count += 1;
      if (event.deduped) row.dedupedTokens += event.tokens;
      else row.tokens += event.tokens;
      sources.set(event.source, row);
      const paths = event.paths?.length ? event.paths : event.source === "read_file" ? [event.label] : [];
      if (paths.length) spread(fileMap, paths, event.tokens, event.deduped);
      if (event.nodeIds?.length) spread(nodeMap, event.nodeIds, event.tokens, event.deduped);
    }
    const round = (s: ContextStat) => ({ ...s, sentTokens: Math.round(s.sentTokens), dedupedTokens: Math.round(s.dedupedTokens) });
    if (!ledger.sources) bySource = [...sources.values()].sort((a, b) => b.tokens - a.tokens);
    if (!ledger.files) files = sortStats([...fileMap.values()].map(round));
    if (!ledger.nodes) nodes = sortStats([...nodeMap.values()].map(round));
  }

  return {
    bySource,
    files,
    nodes,
    context: {
      sent: ledger.sentTokens,
      deduped: ledger.dedupedTokens,
      baseline: ledger.baselineTokens,
      saved: ledger.savedTokens,
    },
  };
}

function sortStats(stats: ContextStat[]): ContextStat[] {
  return stats.sort(
    (a, b) => b.sentTokens - a.sentTokens || b.dedupedTokens - a.dedupedTokens || b.reads - a.reads,
  );
}

/**
 * Summarize one run. Per-call records give the model / agent breakdown and
 * the timeline; whatever the ledger total holds beyond them (planning and
 * routing calls, which do not emit `turn_usage`) lands on the run's model
 * and an "Orchestrator" row, so every breakdown adds up to the total.
 */
export function summarizeRun(run: RunState, extra?: RunUsageExtra): UsageSummary {
  const totals = runTotals(run, extra);
  const turns = extra?.turns ?? [];
  const lanes = new Map(run.agents.map((lane) => [lane.id, lane] as const));

  const models = new Map<string, UsageRow>();
  const agents = new Map<string, UsageRow>();
  let covered = { ...EMPTY_TOTALS };

  if (turns.length > 0) {
    for (const turn of turns) {
      const t = turnTotals(turn);
      covered = addTotals(covered, t);
      upsertRow(models, turn.model, modelLabel(turn.model), t, 1);
      const lane = lanes.get(turn.agentId);
      upsertRow(agents, turn.agentId, lane?.title || turn.agentId, t, 1, lane?.role);
    }
  } else {
    // No per-call records: fall back to per-agent totals from `agent_done`.
    for (const lane of run.agents) {
      if (lane.tokensIn === 0 && lane.tokensOut === 0 && lane.cost === 0) continue;
      const t: UsageTotals = {
        ...EMPTY_TOTALS,
        input: lane.tokensIn,
        output: lane.tokensOut,
        costUsd: lane.cost,
        uncachedUsd: lane.cost,
      };
      covered = addTotals(covered, t);
      upsertRow(models, lane.model, modelLabel(lane.model), t, 0);
      upsertRow(agents, lane.id, lane.title || lane.id, t, 0, lane.role);
    }
  }

  const rest = subTotals(totals, covered);
  if (!isEmpty(rest)) {
    upsertRow(models, run.model || "auto", modelLabel(run.model), rest, 0);
    upsertRow(agents, "orchestrator", "Orchestrator", rest, 0, "planning");
  }

  const timeline: UsageBar[] = turns.map((turn, index) => {
    const lane = lanes.get(turn.agentId);
    return {
      ...turnTotals(turn),
      at: turn.at,
      label: `${lane?.title || turn.agentId} · call ${index + 1}`,
      model: turn.model,
      contextTokens: turn.contextTokens,
    };
  });
  if (timeline.length === 0 && !isEmpty(totals)) {
    timeline.push({ ...totals, at: run.startedAt, label: run.prompt || "Run", model: run.model });
  }

  const last = turns.at(-1);
  return {
    runs: 1,
    totals,
    byModel: [...models.values()].sort(byCost),
    byAgent: [...agents.values()].sort(byCost),
    ...contextFromLedger(run.ledger),
    timeline,
    lastContext: last ? { model: last.model, tokens: last.contextTokens } : undefined,
    startedAt: run.startedAt,
  };
}

/** Cap list sizes so a summary is cheap to persist with its conversation. */
export const PERSIST_LIMITS = { files: 30, nodes: 40, timeline: 48, rows: 12 } as const;

export function compactSummary(summary: UsageSummary): UsageSummary {
  return {
    ...summary,
    byModel: summary.byModel.slice(0, PERSIST_LIMITS.rows),
    byAgent: summary.byAgent.slice(0, PERSIST_LIMITS.rows),
    files: summary.files.slice(0, PERSIST_LIMITS.files),
    nodes: summary.nodes.slice(0, PERSIST_LIMITS.nodes),
    timeline: summary.timeline.slice(-PERSIST_LIMITS.timeline),
  };
}

/** Defensive read of a persisted summary; null when it is not one. */
export function normalizeSummary(raw: unknown): UsageSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<UsageSummary>;
  if (!r.totals || typeof r.totals !== "object") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const totals = (t: Partial<UsageTotals> | undefined): UsageTotals => ({
    input: num(t?.input),
    output: num(t?.output),
    cacheRead: num(t?.cacheRead),
    cacheWrite: num(t?.cacheWrite),
    costUsd: num(t?.costUsd),
    uncachedUsd: num(t?.uncachedUsd),
  });
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
  const rows = (v: unknown): UsageRow[] =>
    arr<UsageRow>(v)
      .filter((row) => row && typeof row.key === "string")
      .map((row) => ({
        key: row.key,
        label: typeof row.label === "string" ? row.label : row.key,
        detail: typeof row.detail === "string" ? row.detail : undefined,
        calls: num(row.calls),
        ...totals(row),
      }));
  const stats = (v: unknown): ContextStat[] =>
    arr<ContextStat>(v)
      .filter((s) => s && typeof s.key === "string")
      .map((s) => ({ key: s.key, sentTokens: num(s.sentTokens), dedupedTokens: num(s.dedupedTokens), reads: num(s.reads) }));
  const ctx = (r.context ?? {}) as Partial<UsageSummary["context"]>;
  return {
    runs: Math.max(1, num(r.runs)),
    totals: totals(r.totals),
    byModel: rows(r.byModel),
    byAgent: rows(r.byAgent),
    bySource: arr<UsageSourceRow>(r.bySource)
      .filter((s) => s && typeof s.source === "string")
      .map((s) => ({ source: s.source, tokens: num(s.tokens), dedupedTokens: num(s.dedupedTokens), count: num(s.count) })),
    files: stats(r.files),
    nodes: stats(r.nodes),
    context: { sent: num(ctx.sent), deduped: num(ctx.deduped), baseline: num(ctx.baseline), saved: num(ctx.saved) },
    timeline: arr<UsageBar>(r.timeline)
      .filter((b) => b && typeof b.at === "number")
      .map((b) => ({
        ...totals(b),
        at: b.at,
        label: typeof b.label === "string" ? b.label : "",
        model: typeof b.model === "string" ? b.model : undefined,
        contextTokens: typeof b.contextTokens === "number" ? b.contextTokens : undefined,
      })),
    lastContext:
      r.lastContext && typeof r.lastContext.model === "string"
        ? { model: r.lastContext.model, tokens: num(r.lastContext.tokens) }
        : undefined,
    startedAt: typeof r.startedAt === "number" ? r.startedAt : undefined,
  };
}

/** What a run receipt without a stored summary can still tell us. */
export function legacySummary(run: {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  startedAt: number;
  prompt: string;
}): UsageSummary {
  const totals: UsageTotals = {
    ...EMPTY_TOTALS,
    input: run.tokensIn || 0,
    output: run.tokensOut || 0,
    costUsd: run.costUsd || 0,
    uncachedUsd: run.costUsd || 0,
  };
  return {
    ...emptySummary(),
    runs: 1,
    totals,
    timeline: isEmpty(totals) ? [] : [{ ...totals, at: run.startedAt, label: run.prompt }],
    startedAt: run.startedAt,
  };
}

/* ------------------------------- merging ---------------------------------- */

function mergeStats(lists: ContextStat[][]): ContextStat[] {
  const map = new Map<string, ContextStat>();
  for (const list of lists) {
    for (const stat of list) {
      const cur = map.get(stat.key);
      if (cur) {
        cur.sentTokens += stat.sentTokens;
        cur.dedupedTokens += stat.dedupedTokens;
        cur.reads += stat.reads;
      } else {
        map.set(stat.key, { ...stat });
      }
    }
  }
  return sortStats([...map.values()]);
}

/**
 * Merge run summaries into one scope. Models merge by id; agents merge by
 * role (agent ids are per run and mean nothing across runs); the timeline
 * becomes one bar per run, labelled with its prompt.
 */
export function mergeSummaries(
  items: { summary: UsageSummary; label: string; at: number }[],
): UsageSummary {
  const out = emptySummary();
  const models = new Map<string, UsageRow>();
  const agents = new Map<string, UsageRow>();
  const sources = new Map<string, UsageSourceRow>();

  for (const { summary, label, at } of items) {
    out.runs += summary.runs;
    out.totals = addTotals(out.totals, summary.totals);
    for (const row of summary.byModel) upsertRow(models, row.key, row.label, row, row.calls, row.detail);
    for (const row of summary.byAgent) {
      const role = row.detail || row.key;
      upsertRow(agents, role, role === "planning" ? "Orchestrator" : role, row, row.calls, role);
    }
    for (const row of summary.bySource) {
      const cur = sources.get(row.source);
      if (cur) {
        cur.tokens += row.tokens;
        cur.dedupedTokens += row.dedupedTokens;
        cur.count += row.count;
      } else {
        sources.set(row.source, { ...row });
      }
    }
    out.context.sent += summary.context.sent;
    out.context.deduped += summary.context.deduped;
    out.context.baseline += summary.context.baseline;
    out.context.saved += summary.context.saved;
    if (!isEmpty(summary.totals)) {
      const lastModel = summary.lastContext?.model ?? summary.byModel[0]?.key;
      out.timeline.push({ ...pickTotals(summary.totals), at, label, model: lastModel });
    }
    if (summary.lastContext) out.lastContext = summary.lastContext;
    if (out.startedAt === undefined || (summary.startedAt ?? at) < out.startedAt) {
      out.startedAt = summary.startedAt ?? at;
    }
  }

  out.byModel = [...models.values()].sort(byCost);
  out.byAgent = [...agents.values()].sort(byCost);
  out.bySource = [...sources.values()].sort((a, b) => b.tokens - a.tokens);
  out.files = mergeStats(items.map((i) => i.summary.files));
  out.nodes = mergeStats(items.map((i) => i.summary.nodes));
  out.timeline.sort((a, b) => a.at - b.at);
  return out;
}

/* ------------------------------ derived math ------------------------------ */

export interface ContextFill {
  used: number;
  window: number;
  /** 0..1, clamped. */
  ratio: number;
  level: "ok" | "warn" | "high";
}

/**
 * A model's context window, from the static catalog. Read-only on purpose:
 * `getModel` can register env-configured models, which is server business.
 */
export function contextWindowOf(modelId: string): number | undefined {
  const known = MODELS.find((m) => m.id === modelId)?.contextWindow;
  if (known) return known;
  if (modelId.startsWith("gemini:")) return 1_000_000;
  if (modelId.startsWith("nvidia:") || modelId.startsWith("openai:")) return 128_000;
  return undefined;
}

/** How full the model's context window was on the most recent call. */
export function contextFill(tokens: number, modelId: string | undefined): ContextFill | null {
  if (!modelId || !(tokens > 0)) return null;
  const window = contextWindowOf(modelId);
  if (!window || window <= 0) return null;
  const ratio = Math.min(1, Math.max(0, tokens / window));
  return { used: tokens, window, ratio, level: ratio >= 0.85 ? "high" : ratio >= 0.6 ? "warn" : "ok" };
}

/** Share of prompt tokens served from the provider cache, 0..1. */
export function cacheHitRate(t: UsageTotals): number {
  const prompt = promptTokens(t);
  return prompt > 0 ? t.cacheRead / prompt : 0;
}

/** Dollars prompt caching saved, and as a share of the uncached price. */
export function cacheSavings(t: UsageTotals): { usd: number; percent: number } {
  const usd = Math.max(0, t.uncachedUsd - t.costUsd);
  return { usd, percent: t.uncachedUsd > 0 ? Math.round((usd / t.uncachedUsd) * 100) : 0 };
}

/** Graph retrieval: tokens not sent versus reading every touched file whole. */
export function graphSavings(c: UsageSummary["context"]): { tokens: number; percent: number } {
  const tokens = Math.max(0, c.baseline - c.sent);
  return { tokens, percent: c.baseline > 0 ? Math.round((tokens / c.baseline) * 100) : 0 };
}

/* ------------------------------- formatting ------------------------------- */

/** 950 → "950", 12_400 → "12.4k", 124_000 → "124k", 1_240_000 → "1.24M". */
export function formatTok(n: number): string {
  const v = Math.max(0, Math.round(n || 0));
  if (v < 1000) return String(v);
  if (v < 100_000) return `${trimZero((v / 1000).toFixed(1))}k`;
  if (v < 1_000_000) return `${Math.round(v / 1000)}k`;
  if (v < 100_000_000) return `${trimZero((v / 1_000_000).toFixed(2))}M`;
  return `${Math.round(v / 1_000_000)}M`;
}

function trimZero(s: string): string {
  return s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/** $0 · $0.0042 · $0.03 · $1.25 · $12.40 */
export function formatUsd(usd: number): string {
  const v = Math.max(0, usd || 0);
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 100) return `$${v.toFixed(2)}`;
  return `$${Math.round(v)}`;
}

/** 0.6234 → "62%", 0.004 → "<1%". */
export function formatPercent(ratio: number): string {
  if (!(ratio > 0)) return "0%";
  if (ratio < 0.01) return "<1%";
  return `${Math.round(ratio * 100)}%`;
}

/** The compact status-bar line: "12.4k tok · $0.03". */
export function usageLine(t: UsageTotals): string {
  return `${formatTok(totalTokens(t))} tok · ${formatUsd(t.costUsd)}`;
}

/* -------------------------------- scopes ---------------------------------- */

/** The receipt fields scope selection needs (a `StoredRun`, structurally). */
export interface UsageReceipt {
  id: string;
  prompt: string;
  startedAt: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  usage?: UsageSummary;
}

export function receiptSummary(receipt: UsageReceipt): UsageSummary {
  return receipt.usage ?? legacySummary(receipt);
}

function receiptItems(receipts: UsageReceipt[]) {
  return receipts.map((r) => ({ summary: receiptSummary(r), label: r.prompt, at: r.startedAt }));
}

/**
 * Usage for a scope.
 *
 *   run           the live (or last finished) run; after a reload, the
 *                 conversation's most recent receipt
 *   conversation  the thread's receipts, plus the live run until it lands
 *   session       every receipt since app start, plus the live run
 */
export function scopeUsage(input: {
  scope: UsageScope;
  run: RunState | null;
  conversationRuns: UsageReceipt[];
  sessionRuns: UsageReceipt[];
  /** Per-call usage of the live run, from the usage store. */
  extra?: RunUsageExtra;
}): UsageSummary {
  const { scope, run, conversationRuns, sessionRuns, extra } = input;
  const live = (receipts: UsageReceipt[]) =>
    run && !receipts.some((r) => r.id === run.id)
      ? [{ summary: summarizeRun(run, extra), label: run.prompt, at: run.startedAt }]
      : [];

  if (scope === "run") {
    if (run) return summarizeRun(run, extra);
    const last = conversationRuns.at(-1);
    return last ? receiptSummary(last) : emptySummary();
  }
  const receipts = scope === "conversation" ? conversationRuns : sessionRuns;
  const items = [...receiptItems(receipts), ...live(receipts)];
  return items.length ? mergeSummaries(items) : emptySummary();
}

/**
 * The context ledger.
 *
 * Two jobs:
 *
 *  1. **Never send the same bytes twice.** Every chunk of context handed to
 *     a model is hashed and recorded. If a later tool call would return the
 *     identical chunk — the same graph slice, the same file window, the same
 *     symbol index — the engine returns a one-line pointer instead
 *     ("already in context above"). In a long agent run this is where most
 *     of the savings come from: agents re-request the same file constantly.
 *
 *  2. **Account honestly.** Track what was actually sent, what was skipped,
 *     and what a naive "dump every file" approach would have cost, so the
 *     savings number in the UI is a real measurement rather than a guess.
 */

import { createHash } from "node:crypto";

import { countTokens } from "@/lib/tokens";

export interface LedgerEvent {
  at: number;
  /** What produced this chunk: `graph_slice`, `read_file`, `skeleton`, … */
  source: string;
  /** Short human label, e.g. the path or query. */
  label: string;
  tokens: number;
  /** True when the chunk was suppressed because it was already delivered. */
  deduped: boolean;
  /** Workspace files this chunk was drawn from (attribution for the usage UI). */
  paths?: string[];
  /** Graph node ids this chunk covers (graph slices, symbol lookups). */
  nodeIds?: string[];
  /**
   * True for context that is delivered without going through dedupe (symbol
   * outlines, grep hits, `view`). Attributed per file, but not part of
   * `sentTokens` — that stays the dedupe-accounted total.
   */
  untracked?: boolean;
}

/** Where a chunk came from, passed to `offer` / `record`. */
export interface LedgerAttribution {
  paths?: string[];
  nodeIds?: string[];
}

/** Context delivered from one file across the run. */
export interface LedgerFileStat {
  path: string;
  /** Tokens placed into prompts, split evenly across a chunk's files. */
  sentTokens: number;
  /** Tokens a repeat request would have cost, suppressed by dedupe. */
  dedupedTokens: number;
  /** Chunks that drew on this file (deduped ones included). */
  reads: number;
}

/** Context delivered for one graph node across the run. */
export interface LedgerNodeStat {
  id: string;
  sentTokens: number;
  dedupedTokens: number;
  reads: number;
}

/** Per-tool rollup. */
export interface LedgerSourceStat {
  source: string;
  tokens: number;
  dedupedTokens: number;
  count: number;
}

export interface LedgerSnapshot {
  /** Tokens actually placed into a prompt. */
  sentTokens: number;
  /** Tokens avoided by dedupe (chunks we refused to repeat). */
  dedupedTokens: number;
  /**
   * Tokens a naive agent would have sent — the full text of every file it
   * touched, every time it touched it.
   */
  baselineTokens: number;
  /** baseline - sent, floored at zero. */
  savedTokens: number;
  savedPercent: number;
  events: LedgerEvent[];
  /**
   * Per-file attribution over the whole run (not capped like `events`),
   * hottest first. Optional: older producers and fixtures omit it.
   */
  files?: LedgerFileStat[];
  /** Per-graph-node attribution, hottest first. */
  nodes?: LedgerNodeStat[];
  /** Per-source rollup (`graph_slice`, `read_file`, …). */
  sources?: LedgerSourceStat[];
}

/** Caps on the attribution lists a snapshot carries over the wire. */
const MAX_FILE_STATS = 200;
const MAX_NODE_STATS = 400;

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Accounting shared by a ledger and every fork of it, so the run-level
 * snapshot adds up the whole team while dedupe stays per agent.
 */
interface LedgerTotals {
  naiveReads: { path: string; tokens: number }[];
  events: LedgerEvent[];
  sentTokens: number;
  dedupedTokens: number;
  files: Map<string, LedgerFileStat>;
  nodes: Map<string, LedgerNodeStat>;
  sources: Map<string, LedgerSourceStat>;
}

function emptyTotals(): LedgerTotals {
  return {
    naiveReads: [],
    events: [],
    sentTokens: 0,
    dedupedTokens: 0,
    files: new Map(),
    nodes: new Map(),
    sources: new Map(),
  };
}

function uniq(list: string[] | undefined): string[] {
  if (!list || list.length === 0) return [];
  return [...new Set(list.filter((v) => typeof v === "string" && v.length > 0))];
}

/** Fold one chunk into the per-file / per-node / per-source rollups. */
function attribute(
  totals: LedgerTotals,
  source: string,
  tokens: number,
  deduped: boolean,
  paths: string[],
  nodeIds: string[],
): void {
  const src = totals.sources.get(source) ?? { source, tokens: 0, dedupedTokens: 0, count: 0 };
  src.count += 1;
  if (deduped) src.dedupedTokens += tokens;
  else src.tokens += tokens;
  totals.sources.set(source, src);

  if (paths.length > 0) {
    const share = tokens / paths.length;
    for (const path of paths) {
      const stat = totals.files.get(path) ?? { path, sentTokens: 0, dedupedTokens: 0, reads: 0 };
      stat.reads += 1;
      if (deduped) stat.dedupedTokens += share;
      else stat.sentTokens += share;
      totals.files.set(path, stat);
    }
  }
  if (nodeIds.length > 0) {
    const share = tokens / nodeIds.length;
    for (const id of nodeIds) {
      const stat = totals.nodes.get(id) ?? { id, sentTokens: 0, dedupedTokens: 0, reads: 0 };
      stat.reads += 1;
      if (deduped) stat.dedupedTokens += share;
      else stat.sentTokens += share;
      totals.nodes.set(id, stat);
    }
  }
}

function pushEvent(totals: LedgerTotals, event: LedgerEvent): void {
  totals.events.push(event);
  if (totals.events.length > 500) totals.events.splice(0, totals.events.length - 500);
}

function hottest<T extends { sentTokens: number; dedupedTokens: number; reads: number }>(
  stats: Iterable<T>,
  cap: number,
): T[] {
  return [...stats]
    .sort(
      (a, b) =>
        b.sentTokens - a.sentTokens || b.dedupedTokens - a.dedupedTokens || b.reads - a.reads,
    )
    .slice(0, cap)
    .map((stat) => ({
      ...stat,
      sentTokens: Math.round(stat.sentTokens),
      dedupedTokens: Math.round(stat.dedupedTokens),
    }));
}

export class ContextLedger {
  /** hash → tokens, for every chunk already delivered to *this* agent. */
  private delivered = new Map<string, number>();
  private totals: LedgerTotals;
  /** Set on forks; the root ledger belongs to the run. */
  readonly agentId: string | null;

  constructor(totals?: LedgerTotals, agentId: string | null = null) {
    this.agentId = agentId;
    this.totals = totals ?? emptyTotals();
  }

  /**
   * A ledger for one agent. Dedupe must be per agent: a pointer saying
   * "already in context above" is a lie to an agent whose transcript never
   * contained that chunk. Token accounting still rolls up into this ledger.
   */
  fork(agentId: string): ContextLedger {
    return new ContextLedger(this.totals, agentId);
  }

  /**
   * Offer a chunk of context. Returns the text to actually use — either the
   * chunk itself, or a short pointer when it has already been delivered.
   */
  offer(
    source: string,
    label: string,
    text: string,
    attribution: LedgerAttribution = {},
  ): { text: string; deduped: boolean; tokens: number } {
    const key = hash(text);
    const tokens = countTokens(text);
    const seen = this.delivered.has(key);

    const totals = this.totals;
    const paths = uniq(attribution.paths);
    const nodeIds = uniq(attribution.nodeIds);
    pushEvent(totals, {
      at: Date.now(),
      source,
      label,
      tokens,
      deduped: seen,
      ...(paths.length ? { paths } : {}),
      ...(nodeIds.length ? { nodeIds } : {}),
    });
    attribute(totals, source, tokens, seen, paths, nodeIds);

    if (seen) {
      totals.dedupedTokens += tokens;
      return {
        text: `[already in context — ${label} was returned earlier in this run, unchanged. Scroll up rather than re-reading.]`,
        deduped: true,
        tokens: 0,
      };
    }

    this.delivered.set(key, tokens);
    totals.sentTokens += tokens;
    return { text, deduped: false, tokens };
  }

  /**
   * Note context that reaches the model without passing through dedupe
   * (symbol outlines, grep hits, `view`). It is attributed to its files and
   * nodes so the usage UI can show where tokens went, but it does not move
   * `sentTokens` / `dedupedTokens`, which keep their original meaning.
   */
  record(
    source: string,
    label: string,
    text: string,
    attribution: LedgerAttribution = {},
  ): number {
    const tokens = countTokens(text);
    const paths = uniq(attribution.paths);
    const nodeIds = uniq(attribution.nodeIds);
    pushEvent(this.totals, {
      at: Date.now(),
      source,
      label,
      tokens,
      deduped: false,
      untracked: true,
      ...(paths.length ? { paths } : {}),
      ...(nodeIds.length ? { nodeIds } : {}),
    });
    attribute(this.totals, source, tokens, false, paths, nodeIds);
    return tokens;
  }

  /**
   * Record what the naive alternative would have cost. Called whenever the
   * engine answers a question *about* a file without sending the file.
   */
  chargeBaseline(path: string, fullTokens: number): void {
    this.totals.naiveReads.push({ path, tokens: fullTokens });
  }

  /** Forget a chunk so a genuinely changed file can be re-delivered. */
  invalidate(text: string): void {
    this.delivered.delete(hash(text));
  }

  /** Drop every cached chunk mentioning a path — used after an edit. */
  invalidatePath(path: string): void {
    for (const event of this.totals.events) {
      if (event.label.includes(path) || event.paths?.includes(path)) {
        // We cannot reverse the hash, so clear wholesale: correctness first.
        this.delivered.clear();
        return;
      }
    }
  }

  snapshot(): LedgerSnapshot {
    const { naiveReads, sentTokens, dedupedTokens, events, files, nodes, sources } = this.totals;
    const baselineTokens = naiveReads.reduce((sum, r) => sum + r.tokens, 0);
    const savedTokens = Math.max(0, baselineTokens - sentTokens);
    return {
      sentTokens,
      dedupedTokens,
      baselineTokens,
      savedTokens,
      savedPercent:
        baselineTokens > 0 ? Math.round((savedTokens / baselineTokens) * 100) : 0,
      events: [...events],
      files: hottest(files.values(), MAX_FILE_STATS),
      nodes: hottest(nodes.values(), MAX_NODE_STATS),
      sources: [...sources.values()].sort((a, b) => b.tokens - a.tokens),
    };
  }
}

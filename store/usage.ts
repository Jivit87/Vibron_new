"use client";

/**
 * Usage slice.
 *
 * Kept apart from the main store on purpose: the run reducer stays about
 * the run, and usage-only state lives here.
 *
 *   live      per-call usage (`turn_usage`) and cache writes, keyed by the
 *             client run id, for the few most recent runs
 *   session   receipts of runs observed live since the app started
 *   scope     shared by the usage panel, the status popover and the heatmap
 *   graphHeat the code graph's token heatmap layer
 *
 * The session list fills itself: when a receipt for a run this slice saw
 * live lands in the conversation, it is appended. Receipts loaded from
 * storage (switching threads) were not seen live, so they never count.
 */

import { create } from "zustand";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { StoredRun } from "@/lib/client/conversations";
import type { RunUsageExtra, TurnUsageRecord, UsageScope } from "@/lib/client/usage";
import { useViberon } from "@/store/viberon";

/** Bound on per-call records kept per run, and on runs kept live. */
export const MAX_TURNS = 400;
const MAX_LIVE_RUNS = 12;
const MAX_SESSION_RUNS = 500;

interface UsageState {
  live: Record<string, RunUsageExtra>;
  sessionRuns: StoredRun[];
  scope: UsageScope;
  graphHeat: boolean;
  /** Live usage panel in the run view is expanded. */
  liveOpen: boolean;
  /** Fold one orchestration event for the run with this client id. */
  ingest: (runId: string | undefined, event: OrchestrationEvent) => void;
  setScope: (scope: UsageScope) => void;
  setGraphHeat: (on: boolean) => void;
  setLiveOpen: (open: boolean) => void;
}

/** Pure: the per-run extra after one event. */
export function reduceUsageExtra(extra: RunUsageExtra | undefined, event: OrchestrationEvent): RunUsageExtra | undefined {
  if (event.type === "turn_usage") {
    const record: TurnUsageRecord = {
      agentId: event.agentId,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      costUsd: event.costUsd,
      uncachedUsd: event.uncachedUsd,
      contextTokens: event.contextTokens,
      at: event.at,
    };
    const turns = [...(extra?.turns ?? []), record];
    if (turns.length > MAX_TURNS) turns.splice(0, turns.length - MAX_TURNS);
    return { turns, cacheWrite: extra?.cacheWrite ?? 0 };
  }
  if (event.type === "ledger" && typeof event.tokensCacheWrite === "number") {
    return { turns: extra?.turns ?? [], cacheWrite: event.tokensCacheWrite };
  }
  return extra;
}

let subscribed = false;

/** Append receipts of live-observed runs to the session, once each. */
function watchReceipts(): void {
  if (subscribed) return;
  subscribed = true;
  useViberon.subscribe((state, prev) => {
    if (state.conversationRuns === prev.conversationRuns) return;
    const usage = useUsageStore.getState();
    const known = new Set(usage.sessionRuns.map((r) => r.id));
    const fresh = state.conversationRuns.filter((r) => usage.live[r.id] && !known.has(r.id));
    if (fresh.length === 0) return;
    useUsageStore.setState({
      sessionRuns: [...usage.sessionRuns, ...fresh].slice(-MAX_SESSION_RUNS),
    });
  });
}

export const useUsageStore = create<UsageState>((set) => ({
  live: {},
  sessionRuns: [],
  scope: "run",
  graphHeat: false,
  liveOpen: true,

  ingest: (runId, event) => {
    if (!runId) return;
    watchReceipts();
    set((state) => {
      const current = state.live[runId];
      // Every run seen live gets an entry, so its receipt counts for the session.
      const next = reduceUsageExtra(current, event) ?? current ?? { turns: [], cacheWrite: 0 };
      if (next === current) return state;
      const live = { ...state.live, [runId]: next };
      const ids = Object.keys(live);
      if (ids.length > MAX_LIVE_RUNS) {
        for (const id of ids.slice(0, ids.length - MAX_LIVE_RUNS)) delete live[id];
      }
      return { live };
    });
  },

  setScope: (scope) => set({ scope }),
  setGraphHeat: (graphHeat) => set({ graphHeat }),
  setLiveOpen: (liveOpen) => set({ liveOpen }),
}));

/** Per-call usage for a run, if it ran in this session. */
export function runUsageExtra(runId: string): RunUsageExtra | undefined {
  return useUsageStore.getState().live[runId];
}

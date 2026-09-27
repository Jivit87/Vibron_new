"use client";

/**
 * Problems + diagnostics state (client).
 *
 * `problems` come from running the workspace's checkers (tsc, ESLint) on the
 * server. `diagnostics` is the editor-side feed — Monaco markers keyed by
 * workspace path — which the Problems panel merges in. It lives here as its
 * own slice so nothing in the main store has to change to support it.
 */

import { create } from "zustand";

import { isMockMode, MOCK_PROBLEMS } from "@/lib/client/mock-run";
import type { CheckerRun, Problem } from "@/lib/client/workspace-types";

export interface EditorDiagnostic {
  line: number;
  col: number;
  severity: "error" | "warning" | "info";
  message: string;
  source?: string;
}

export interface RevealRequest {
  path: string;
  line: number;
  col: number;
  /** Changes on every request so re-revealing the same spot still fires. */
  nonce: number;
}

interface ProblemsState {
  problems: Problem[];
  checkers: CheckerRun[];
  running: boolean;
  /** A run was requested while one was in flight. */
  rerunQueued: boolean;
  virtual: boolean;
  lastRunAt: number | null;
  error: string | null;
  /** The problems API is not available on this server (404). */
  unavailable: boolean;
  /** Re-run checkers after saves. */
  autoRun: boolean;

  diagnostics: Record<string, EditorDiagnostic[]>;
  setDiagnostics: (path: string, list: EditorDiagnostic[]) => void;

  reveal: RevealRequest | null;
  requestReveal: (path: string, line: number, col: number) => void;
  clearReveal: () => void;

  setAutoRun: (on: boolean) => void;
  /** Read the server's last cached result without running checkers. */
  load: (repoKey: string) => Promise<void>;
  /** `tests`: also run the workspace's test suite; failing tests list like other problems. */
  runChecks: (repoKey: string, options?: { tests?: boolean }) => Promise<void>;
  /** The last run included tests. */
  testsRan: boolean;
  /** Debounced run, used by the save hook. */
  scheduleRun: (repoKey: string, delayMs?: number) => void;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let revealNonce = 0;

export const useProblems = create<ProblemsState>((set, get) => ({
  problems: [],
  checkers: [],
  running: false,
  testsRan: false,
  rerunQueued: false,
  virtual: false,
  lastRunAt: null,
  error: null,
  unavailable: false,
  autoRun: true,

  diagnostics: {},
  setDiagnostics: (path, list) =>
    set((state) => {
      const next = { ...state.diagnostics };
      if (list.length === 0) delete next[path];
      else next[path] = list;
      return { diagnostics: next };
    }),

  reveal: null,
  requestReveal: (path, line, col) => {
    revealNonce += 1;
    set({ reveal: { path, line, col, nonce: revealNonce } });
  },
  clearReveal: () => set({ reveal: null }),

  setAutoRun: (autoRun) => set({ autoRun }),

  load: async (repoKey) => {
    if (!repoKey) return;
    if (isMockMode()) {
      set({
        virtual: false,
        problems: MOCK_PROBLEMS.problems,
        checkers: MOCK_PROBLEMS.checkers,
        lastRunAt: MOCK_PROBLEMS.finishedAt,
        error: null,
      });
      return;
    }
    try {
      const response = await fetch(`/api/problems?repoKey=${encodeURIComponent(repoKey)}`);
      if (response.status === 404) {
        set({ unavailable: true });
        return;
      }
      if (!response.ok) return;
      const body = (await response.json()) as {
        virtual?: boolean;
        problems?: Problem[];
        checkers?: CheckerRun[];
        finishedAt?: number | null;
      };
      set({
        virtual: Boolean(body.virtual),
        problems: body.problems ?? [],
        checkers: body.checkers ?? [],
        lastRunAt: body.finishedAt ?? null,
      });
    } catch {
      // Offline or server restarting; the panel shows its empty state.
    }
  },

  runChecks: async (repoKey, options = {}) => {
    if (!repoKey) return;
    if (isMockMode()) {
      set({ running: true });
      await new Promise((r) => setTimeout(r, 600));
      set({
        problems: MOCK_PROBLEMS.problems,
        checkers: MOCK_PROBLEMS.checkers,
        running: false,
        lastRunAt: Date.now(),
      });
      return;
    }
    if (get().running) {
      set({ rerunQueued: true });
      return;
    }
    set({ running: true, error: null });
    try {
      const response = await fetch("/api/problems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoKey, ...(options.tests ? { tests: true } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        virtual?: boolean;
        problems?: Problem[];
        checkers?: CheckerRun[];
        error?: string;
      };
      if (response.status === 404) {
        set({ unavailable: true });
        return;
      }
      if (!response.ok) {
        set({ error: body.error ?? "Checks failed" });
        return;
      }
      set({
        virtual: Boolean(body.virtual),
        problems: body.problems ?? [],
        checkers: body.checkers ?? [],
        lastRunAt: Date.now(),
        testsRan: Boolean(options.tests),
      });
    } catch {
      set({ error: "Network error" });
    } finally {
      const queued = get().rerunQueued;
      set({ running: false, rerunQueued: false });
      if (queued) void get().runChecks(repoKey);
    }
  },

  scheduleRun: (repoKey, delayMs = 1500) => {
    const state = get();
    // Auto-run only once the user has opted in by running checks at least
    // once — a cold `tsc` on every keystroke-save is not free.
    if (!state.autoRun || state.virtual || state.lastRunAt === null) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void get().runChecks(repoKey);
    }, delayMs);
  },
}));

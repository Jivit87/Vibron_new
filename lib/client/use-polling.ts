"use client";

/**
 * Poll while the page is visible. A hidden window (another app in front, a
 * minimised Electron window, a background tab) stops polling entirely and
 * refreshes once when it becomes visible again, so idle panels cost no
 * requests (and no GitHub rate limit).
 */

import { useEffect, useRef } from "react";

export function usePolling(tick: () => void | Promise<void>, intervalMs: number, enabled = true): void {
  const latest = useRef(tick);
  useEffect(() => {
    latest.current = tick;
  }, [tick]);

  useEffect(() => {
    if (!enabled || !(intervalMs > 0)) return;
    let timer: number | null = null;
    const hidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";
    const start = () => {
      if (timer === null) timer = window.setInterval(() => void latest.current(), intervalMs);
    };
    const stop = () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (hidden()) stop();
      else {
        void latest.current();
        start();
      }
    };
    if (!hidden()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, enabled]);
}

/**
 * What one poll saw: something `changed` (poll again soon), the `same` as
 * last time (back off), or `done` (checks completed: stop polling).
 */
export type PollOutcome = "changed" | "same" | "done";

export interface BackoffOptions {
  tick: () => PollOutcome | Promise<PollOutcome>;
  /** First delay, and the delay after any change. */
  baseMs: number;
  /** Cap on the delay while nothing changes. */
  maxMs: number;
  factor?: number;
  /** The page's visibility; null/absent outside a browser. */
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> | null;
}

/** The delay after a poll: back to `baseMs` on a change, else `factor`× up to `maxMs`. */
export function nextBackoffDelay(current: number, outcome: Exclude<PollOutcome, "done">, o: Pick<BackoffOptions, "baseMs" | "maxMs" | "factor">): number {
  if (outcome === "changed") return o.baseMs;
  return Math.min(o.maxMs, Math.max(o.baseMs, Math.round(current * (o.factor ?? 2))));
}

/**
 * Poll with exponential backoff while nothing changes, paused while the page
 * is hidden (one poll when it shows again), stopped for good on `done`.
 * Returns a stop function.
 */
export function startBackoffPolling(o: BackoffOptions): () => void {
  const doc = o.doc === undefined ? (typeof document !== "undefined" ? document : null) : o.doc;
  let delay = o.baseMs;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight = false;
  const hidden = () => doc?.visibilityState === "hidden";
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    stopped = true;
    clear();
    doc?.removeEventListener("visibilitychange", onVisibility);
  };
  const schedule = () => {
    clear();
    if (!stopped && !hidden()) timer = setTimeout(() => void run(), delay);
  };
  async function run(): Promise<void> {
    if (stopped || inFlight) return;
    if (hidden()) return; // paused; visibilitychange resumes
    inFlight = true;
    let outcome: PollOutcome;
    try {
      outcome = await o.tick();
    } catch {
      outcome = "same";
    } finally {
      inFlight = false;
    }
    if (stopped) return;
    if (outcome === "done") {
      stop();
      return;
    }
    delay = nextBackoffDelay(delay, outcome, o);
    schedule();
  }
  function onVisibility() {
    if (stopped) return;
    if (hidden()) {
      clear();
    } else {
      // Back from hidden: check now, from the base delay.
      delay = o.baseMs;
      clear();
      void run();
    }
  }
  doc?.addEventListener("visibilitychange", onVisibility);
  schedule();
  return stop;
}

/** A stable signature of a list, so an unchanged poll result skips a re-render. */
export function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

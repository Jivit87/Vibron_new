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

/** A stable signature of a list, so an unchanged poll result skips a re-render. */
export function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nextBackoffDelay, startBackoffPolling, type PollOutcome } from "@/lib/client/use-polling";

function fakeDoc() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const set = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    for (const fn of listeners) fn();
  };
  return { doc: doc as unknown as Document, set, listeners };
}

describe("CI polling backoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("doubles the delay while nothing changes, resets on a change, caps at max", () => {
    const o = { baseMs: 100, maxMs: 500 };
    expect(nextBackoffDelay(100, "same", o)).toBe(200);
    expect(nextBackoffDelay(400, "same", o)).toBe(500);
    expect(nextBackoffDelay(500, "same", o)).toBe(500);
    expect(nextBackoffDelay(400, "changed", o)).toBe(100);
  });

  it("backs off, pauses while hidden, resumes with one poll, and stops when checks complete", async () => {
    const { doc, set, listeners } = fakeDoc();
    const outcomes: PollOutcome[] = ["same", "same", "same", "changed", "done"];
    const at: number[] = [];
    const start = Date.now();
    const tick = vi.fn(async () => {
      at.push(Date.now() - start);
      return outcomes.shift() ?? "same";
    });
    startBackoffPolling({ tick, baseMs: 100, maxMs: 1_000, doc });

    await vi.advanceTimersByTimeAsync(100); // 1st poll at 100 → same, next in 200
    await vi.advanceTimersByTimeAsync(200); // 2nd at 300 → same, next in 400
    expect(at).toEqual([100, 300]);

    set("hidden");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(tick).toHaveBeenCalledTimes(2); // nothing while hidden

    set("visible"); // one poll right away (3rd → same), then base*2
    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(200); // 4th → changed, next in base
    await vi.advanceTimersByTimeAsync(100); // 5th → done
    expect(tick).toHaveBeenCalledTimes(5);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(5); // stopped for good
    expect(listeners.size).toBe(0);
  });

  it("the returned stop cancels a pending poll", async () => {
    const tick = vi.fn(async (): Promise<PollOutcome> => "same");
    const stop = startBackoffPolling({ tick, baseMs: 100, maxMs: 1_000, doc: null });
    stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).not.toHaveBeenCalled();
  });
});

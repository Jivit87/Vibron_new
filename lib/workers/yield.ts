/**
 * Cooperative time slicing for CPU-heavy loops on the server thread
 * (scanning, parsing, token counting over thousands of files).
 *
 * `const tick = timeSlicer(); for (...) { await tick(signal); work(); }`
 * returns at once while the current slice lasts and yields to the event loop
 * (`setImmediate`, so pending I/O — a Stop request — runs first) once it has
 * used `sliceMs`. An aborted signal throws at the next tick, so long loops
 * stop within one slice of a cancel.
 */

import { performance } from "node:perf_hooks";

export const DEFAULT_SLICE_MS = 8;

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function timeSlicer(sliceMs = DEFAULT_SLICE_MS): (signal?: AbortSignal) => Promise<void> {
  let start = performance.now();
  return async (signal) => {
    signal?.throwIfAborted();
    if (performance.now() - start < sliceMs) return;
    await yieldToEventLoop();
    signal?.throwIfAborted();
    start = performance.now();
  };
}

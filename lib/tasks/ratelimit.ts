/**
 * One rate limiter shared by every issue solve in a batch.
 *
 * It is a semaphore (bounds how many solves run at once, same number as
 * today's `VIBERON_ISSUE_CONCURRENCY` / `BATCH_CONCURRENCY`) plus a shared
 * backoff: when solves in the batch start seeing 429/529 bursts (the harness
 * already emits `agent_retry` for those; see `lib/agents/runner.ts`), every
 * *new* start in the whole batch is delayed together instead of each issue
 * retrying independently and piling more load on the same provider limit.
 * A clean run decays the shared delay back down.
 */

export interface RateLimiterOptions {
  /** Backoff after the first burst signal. Default 2s. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 30s. */
  maxDelayMs?: number;
}

export class RateLimiter {
  private running = 0;
  private readonly queue: Array<() => void> = [];
  private readonly base: number;
  private readonly max: number;
  /** Wall-clock time before which no new solve may start (shared across the batch). */
  private notBefore = 0;

  constructor(
    private concurrency: number,
    options: RateLimiterOptions = {},
  ) {
    this.base = Math.max(0, options.baseDelayMs ?? 2_000);
    this.max = Math.max(this.base, options.maxDelayMs ?? 30_000);
  }

  /** How long the shared backoff currently delays a new start, in ms (0 = none). */
  get delayMs(): number {
    return Math.max(0, this.notBefore - Date.now());
  }

  get inFlight(): number {
    return this.running;
  }

  /** Wait for a free slot (respecting the shared backoff), run `fn`, then free the slot. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | null = null;
      const cleanup = () => {
        if (onAbort) signal?.removeEventListener("abort", onAbort);
      };
      const attempt = () => {
        if (signal?.aborted) {
          cleanup();
          reject(new Error("aborted"));
          return;
        }
        if (this.running >= this.concurrency) {
          this.queue.push(attempt);
          return;
        }
        const wait = this.notBefore - Date.now();
        if (wait > 0) {
          setTimeout(attempt, wait);
          return;
        }
        this.running += 1;
        cleanup();
        resolve();
      };
      if (signal) {
        onAbort = () => {
          cleanup();
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      attempt();
    });
  }

  private release(): void {
    this.running -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** A 429/529 burst: every new start in the batch backs off together, exponentially, capped. */
  reportRateLimited(): void {
    const current = Math.max(0, this.notBefore - Date.now());
    const delay = Math.min(this.max, Math.max(this.base, current * 2));
    this.notBefore = Date.now() + delay;
  }

  /** A clean run: decay the shared backoff so one stray retry does not throttle the rest of the batch forever. */
  reportSuccess(): void {
    const current = this.notBefore - Date.now();
    if (current > 0) this.notBefore = Date.now() + Math.floor(current / 2);
    else this.notBefore = 0;
  }
}

/**
 * An in-process mutex per key: `withLock(key, fn)` runs `fn` only after every
 * earlier holder of `key` has finished, so read → decide → write sequences
 * (queue dedupe, the flaky re-run ledger) cannot interleave. Kept on
 * globalThis so dev hot reloads share one set of locks.
 */

const LOCKS = ((globalThis as { __viberonLocks?: Map<string, Promise<void>> }).__viberonLocks ??= new Map());

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = LOCKS.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  LOCKS.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (LOCKS.get(key) === tail) LOCKS.delete(key);
  }
}

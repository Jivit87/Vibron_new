import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";

export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
  }
}

/**
 * `countTokens` memoized by content: tokenizing is far slower than hashing,
 * and a workspace (and every issue worktree of it) re-counts the same files.
 */
const tokenCache = new Map<string, number>();
const MAX_CACHED = 200_000;

export function countTokensCached(text: string): number {
  if (text.length < 256) return countTokens(text);
  const key = createHash("sha1").update(text).digest("base64");
  const hit = tokenCache.get(key);
  if (hit !== undefined) return hit;
  const count = countTokens(text);
  if (tokenCache.size >= MAX_CACHED) tokenCache.clear();
  tokenCache.set(key, count);
  return count;
}

/**
 * DeepSeek endpoint facts and key ownership probing.
 *
 * DeepSeek keys and classic OpenAI keys share one shape, `sk-` + 32 hex, so a
 * lone `AI_API_KEY` of that shape cannot be routed by its prefix. Both
 * vendors list models with the key (`GET /models`), so we ask each once and
 * remember the answer for the life of the process. Unknown (offline, both
 * refuse) keeps the historical default: the OpenAI-compatible adapter.
 */

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const PROBE_TIMEOUT_MS = 8_000;

export function deepseekBaseUrl(): string {
  return (process.env.DEEPSEEK_BASE_URL || DEEPSEEK_BASE_URL).replace(/\/+$/, "");
}

/** `sk-` + 32 hex: issued by both DeepSeek and (older) OpenAI accounts. */
export function isAmbiguousSkKey(key: string | null | undefined): boolean {
  return Boolean(key && /^sk-[0-9a-f]{32}$/i.test(key.trim()));
}

export type SkKeyOwner = "openai" | "deepseek" | null;

const probes = new Map<string, Promise<SkKeyOwner>>();

async function listsModels(url: string, key: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Which vendor accepts this ambiguous key; probed once per key, both vendors in parallel. */
export function probeSkKeyOwner(key: string): Promise<SkKeyOwner> {
  let probe = probes.get(key);
  if (!probe) {
    probe = Promise.all([
      listsModels(`${deepseekBaseUrl()}/models`, key),
      listsModels(OPENAI_MODELS_URL, key),
    ]).then(([deepseek, openai]) => (deepseek ? "deepseek" : openai ? "openai" : null));
    probes.set(key, probe);
  }
  return probe;
}

export const deepseekTesting = {
  reset(): void {
    probes.clear();
  },
};

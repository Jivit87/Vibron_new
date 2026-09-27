/**
 * Server-side credential storage.
 *
 * Keys never reach the browser. The settings UI writes a key through
 * `PUT /api/settings/keys` and only ever reads back a masked fingerprint
 * (`sk-ant-…4f21`) plus a boolean. Resolution order per provider:
 *
 *   1. A key saved through the settings UI (persisted in the local store).
 *   2. The corresponding environment variable.
 *
 * The store is the same disk-backed map the rest of the app uses, which in
 * a packaged Electron build lives under the OS user-data directory rather
 * than inside the app bundle.
 */

import type { ProviderId } from "@/lib/ai/types";
import { isAmbiguousSkKey, probeSkKeyOwner } from "@/lib/ai/deepseek";
import { detectProvider } from "@/lib/ai/provider-config";

const KEY_PREFIX = "credential:";

/** Env var consulted when no key has been saved through the UI. */
const ENV_VAR: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  gemini: "GEMINI_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  // The Claude CLI uses the machine's `claude` login, never a key.
  "claude-cli": "",
};

/** Providers that take an API key (everything but the Claude CLI). */
export const KEY_PROVIDERS: ProviderId[] = ["anthropic", "groq", "openai", "nvidia", "gemini", "deepseek"];

/**
 * The evaluation's single credential, `AI_API_KEY`, routed by its prefix:
 * `sk-ant-` feeds the Anthropic adapter, `gsk_` Groq (unless a base URL
 * names another endpoint), and anything else the OpenAI-compatible adapter.
 * An `sk-` + 32 hex key is DeepSeek's or OpenAI's: with no base URL naming
 * the endpoint, one probe of each vendor's `/models` decides (cached).
 */
async function genericEnvKey(provider: ProviderId): Promise<string | null> {
  const key = (process.env.AI_API_KEY ?? "").trim();
  if (!key || provider === "claude-cli") return null;
  const detected = detectProvider(key);
  const baseUrl = (process.env.AI_BASE_URL ?? "").trim();
  const groqNative = detected === "groq" && !baseUrl;
  if (provider === "anthropic") return detected === "anthropic" ? key : null;
  if (provider === "groq") return groqNative ? key : null;
  if (provider === "nvidia") return detected === "nvidia" ? key : null;
  if (provider === "gemini") return detected === "gemini" ? key : null;
  const namedDeepseek =
    (process.env.AI_PROVIDER ?? "").trim().toLowerCase() === "deepseek" || /api\.deepseek\.com/i.test(baseUrl);
  const owner = !baseUrl && isAmbiguousSkKey(key) ? await probeSkKeyOwner(key) : null;
  if (provider === "deepseek") return detected === "openai" && (namedDeepseek || owner === "deepseek") ? key : null;
  return detected === "anthropic" || groqNative || owner === "deepseek" ? null : key;
}

async function envKey(provider: ProviderId): Promise<string | null> {
  const name = ENV_VAR[provider];
  const direct = name ? process.env[name]?.trim() : undefined;
  return direct || genericEnvKey(provider);
}

type StoreModule = typeof import("@/lib/store");

let storePromise: Promise<StoreModule> | null = null;

/**
 * The store pulls in `node:fs`, so it must not be imported at module scope
 * from anything that might be bundled for the browser. Load it lazily.
 */
async function store(): Promise<StoreModule> {
  if (!storePromise) storePromise = import("@/lib/store");
  return storePromise;
}

/**
 * Process-level cache so a hot request path does not hit the disk store on
 * every single agent turn. Invalidated whenever a key is written.
 */
const cache = new Map<ProviderId, string | null>();

export async function getApiKey(provider: ProviderId): Promise<string | null> {
  if (cache.has(provider)) return cache.get(provider) ?? null;
  if (provider === "claude-cli") return null;

  let saved: string | null = null;
  try {
    const { getValueRaw } = await store();
    saved = await getValueRaw<string>(KEY_PREFIX + provider);
  } catch {
    // Store unavailable (e.g. read-only fs) — fall through to env.
  }

  const env = await envKey(provider);
  const key = (saved && saved.trim()) || env || null;
  cache.set(provider, key);
  return key;
}

export async function setApiKey(
  provider: ProviderId,
  key: string | null,
): Promise<void> {
  const { setValueRaw } = await store();
  await setValueRaw(KEY_PREFIX + provider, key && key.trim() ? key.trim() : null);
  cache.delete(provider);
}

export function invalidateCredentialCache(): void {
  cache.clear();
}

/** `sk-ant-api03-abc…9f21` — enough to recognise, not enough to use. */
export function maskKey(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export interface CredentialStatus {
  provider: ProviderId;
  configured: boolean;
  /** Masked fingerprint, or null when nothing is configured. */
  masked: string | null;
  /** True when the key comes from the environment rather than the UI. */
  fromEnv: boolean;
  envVar: string;
}

export async function credentialStatus(
  provider: ProviderId,
): Promise<CredentialStatus> {
  let saved: string | null = null;
  try {
    const { getValueRaw } = await store();
    saved = await getValueRaw<string>(KEY_PREFIX + provider);
  } catch {
    saved = null;
  }
  const env = await envKey(provider);
  const key = (saved && saved.trim()) || env || null;
  return {
    provider,
    configured: Boolean(key),
    masked: key ? maskKey(key) : null,
    fromEnv: Boolean(!saved?.trim() && env),
    envVar: ENV_VAR[provider],
  };
}

export async function allCredentialStatus(): Promise<CredentialStatus[]> {
  return Promise.all(
    KEY_PROVIDERS.map(credentialStatus),
  );
}

/**
 * Reader for `GET /api/settings/keys`.
 *
 * The route is extended in parallel with the UI (DeepSeek, the Claude CLI),
 * so this reads tolerantly: unknown providers and malformed rows are dropped,
 * and the Claude subscription row is found either as a `claude-cli` provider
 * entry or as a top-level `claudeCli` object. When neither is present the
 * Settings page simply leaves that row out.
 */

export const KEY_PROVIDERS = ["anthropic", "deepseek", "groq", "gemini", "nvidia", "openai"] as const;
export type KeyProviderId = (typeof KEY_PROVIDERS)[number];

export interface KeyProviderStatus {
  provider: KeyProviderId;
  configured: boolean;
  masked: string | null;
  fromEnv: boolean;
  envVar: string;
}

/** The logged-in `claude` CLI: read-only, nothing to enter. */
export interface ClaudeCliStatus {
  configured: boolean;
  /** Version, account or path, when the route reports one. */
  detail?: string;
}

export interface ProviderStatusBody {
  keys: KeyProviderStatus[];
  cli: ClaudeCliStatus | null;
}

const DEFAULT_ENV: Record<KeyProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  openai: "OPENAI_API_KEY",
};

function isCliId(value: unknown): boolean {
  return typeof value === "string" && /^claude[-_ ]?cli$|^claudecli$/i.test(value.trim());
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCli(raw: unknown): ClaudeCliStatus | null {
  if (typeof raw === "boolean") return { configured: raw };
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const flag = [r.configured, r.loggedIn, r.available, r.ok].find((v): v is boolean => typeof v === "boolean");
  return {
    configured: flag ?? false,
    detail: str(r.masked) ?? str(r.detail) ?? str(r.account) ?? str(r.version),
  };
}

export function normalizeProviderStatus(body: unknown): ProviderStatusBody {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = Array.isArray(body) ? body : Array.isArray(b.providers) ? b.providers : [];
  const keys: KeyProviderStatus[] = [];
  let cli: ClaudeCliStatus | null = null;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const id = typeof r.provider === "string" ? r.provider.trim().toLowerCase() : "";
    if (isCliId(id)) {
      cli = readCli(r);
      continue;
    }
    if (!(KEY_PROVIDERS as readonly string[]).includes(id)) continue;
    if (keys.some((k) => k.provider === id)) continue;
    const provider = id as KeyProviderId;
    keys.push({
      provider,
      configured: r.configured === true,
      masked: str(r.masked) ?? null,
      fromEnv: r.fromEnv === true,
      envVar: str(r.envVar) ?? DEFAULT_ENV[provider],
    });
  }
  if (!cli) cli = readCli(b.claudeCli ?? b["claude-cli"] ?? b.claude_cli);
  return { keys, cli };
}

/** Whether anything can run a model: a key, or the logged-in CLI. */
export function anyProviderReady(status: ProviderStatusBody): boolean {
  return status.keys.some((k) => k.configured) || status.cli?.configured === true;
}

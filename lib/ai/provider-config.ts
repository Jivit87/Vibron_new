/**
 * Provider detection from the environment (ported from Pramana `config.py`).
 *
 * Evaluation hands the harness one credential, `AI_API_KEY`, and possibly
 * `AI_BASE_URL` / `AI_MODEL`. The key's prefix identifies most vendors
 * unambiguously, so the right wire protocol, base URL and default model can
 * be chosen with no further configuration.
 */

export type DetectedProvider =
  | "anthropic"
  | "openai"
  | "gemini"
  | "openrouter"
  | "groq"
  | "xai"
  | "deepseek"
  | "mistral"
  | "together"
  | "fireworks"
  | "cerebras"
  | "nvidia"
  | "huggingface"
  | "ollama"
  | "azure"
  | "openai-compatible";

/** Wire protocol, base URL and default model per provider. */
export const PROVIDER_TABLE: Record<
  DetectedProvider,
  { kind: "anthropic" | "openai"; baseUrl: string; model: string }
> = {
  anthropic: { kind: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5" },
  openai: { kind: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-mini" },
  gemini: {
    kind: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
  },
  openrouter: { kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-oss-120b" },
  groq: { kind: "openai", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  xai: { kind: "openai", baseUrl: "https://api.x.ai/v1", model: "grok-code-fast-1" },
  deepseek: { kind: "openai", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  mistral: { kind: "openai", baseUrl: "https://api.mistral.ai/v1", model: "devstral-medium-latest" },
  together: { kind: "openai", baseUrl: "https://api.together.xyz/v1", model: "openai/gpt-oss-120b" },
  fireworks: {
    kind: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    model: "accounts/fireworks/models/gpt-oss-120b",
  },
  cerebras: { kind: "openai", baseUrl: "https://api.cerebras.ai/v1", model: "gpt-oss-120b" },
  nvidia: { kind: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", model: "openai/gpt-oss-120b" },
  huggingface: { kind: "openai", baseUrl: "https://router.huggingface.co/v1", model: "openai/gpt-oss-120b" },
  ollama: { kind: "openai", baseUrl: "http://localhost:11434/v1", model: "gpt-oss:120b-cloud" },
  azure: { kind: "openai", baseUrl: "", model: "" },
  "openai-compatible": { kind: "openai", baseUrl: "", model: "" },
};

/** Key prefixes that identify a provider. Order matters: longest/most specific first. */
export const KEY_PREFIXES: [string, DetectedProvider][] = [
  ["sk-ant-", "anthropic"],
  ["sk-or-", "openrouter"],
  ["AIza", "gemini"],
  ["gsk_", "groq"],
  ["xai-", "xai"],
  ["nvapi-", "nvidia"],
  ["csk-", "cerebras"],
  ["hf_", "huggingface"],
  ["fw_", "fireworks"],
  ["tgp_", "together"],
  ["sk-", "openai"],
];

export function detectProvider(key: string | null | undefined): DetectedProvider | null {
  if (!key) return null;
  for (const [prefix, name] of KEY_PREFIXES) {
    if (key.startsWith(prefix)) return name;
  }
  return null;
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

export function isAzureUrl(url: string): boolean {
  return /\.azure\.com|azure-api\.net/i.test(url);
}

export interface OpenAiCompatConfig {
  provider: DetectedProvider;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  azure: boolean;
  apiVersion: string;
}

/**
 * Resolve the OpenAI-compatible endpoint from the environment:
 * `AI_PROVIDER` > key prefix > `AI_BASE_URL` shape. Returns null when the
 * environment names an Anthropic key (served by the Anthropic adapter).
 */
export function resolveOpenAiCompatEnv(): OpenAiCompatConfig {
  const key = env("AI_API_KEY") || env("OPENAI_API_KEY") || null;
  const baseUrl = env("AI_BASE_URL") || env("VIBERON_OPENAI_BASE_URL");
  const explicit = env("AI_PROVIDER").toLowerCase() as DetectedProvider | "";
  const requestedModel = env("AI_MODEL") || env("VIBERON_MODEL");
  let provider: DetectedProvider;
  if (explicit && explicit in PROVIDER_TABLE) provider = explicit;
  else if (baseUrl) {
    const detected = detectProvider(key);
    provider = isAzureUrl(baseUrl)
      ? "azure"
      : /^https?:\/\/api\.deepseek\.com(?::\d+)?(?:\/|$)/i.test(baseUrl)
        ? "deepseek"
      : detected && detected !== "anthropic"
        ? detected
        : "openai-compatible";
  } else {
    const detected = detectProvider(key);
    provider = detected === "openai" && /^deepseek(?:[-/]|$)/i.test(requestedModel)
      ? "deepseek"
      : detected && detected !== "anthropic" ? detected : "openai";
  }
  const spec = PROVIDER_TABLE[provider];
  const url = (baseUrl || spec.baseUrl || PROVIDER_TABLE.openai.baseUrl).replace(/\/+$/, "");
  const azure = provider === "azure" || isAzureUrl(url);
  return {
    provider,
    baseUrl: url,
    model: requestedModel || spec.model,
    apiKey: key,
    azure,
    apiVersion: env("AI_API_VERSION") || (azure ? "2024-10-21" : ""),
  };
}

/** Context window from the environment, for models registered at runtime. */
export function envContextWindow(): number {
  const n = Number(env("VIBERON_CONTEXT_WINDOW") || env("AI_CONTEXT_WINDOW"));
  return Number.isFinite(n) && n > 1000 ? n : 128_000;
}

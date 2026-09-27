/**
 * Provider registry + the one entry point the rest of the app calls.
 *
 * `runTurn` dispatches on the model's declared provider and enriches the
 * result with cost accounting, so callers never touch a vendor SDK.
 */

import { anthropicProvider } from "@/lib/ai/anthropic";
import { groqProvider } from "@/lib/ai/groq";
import { claudeCliProvider, claudeCliReady } from "@/lib/ai/claude-cli";
import { deepseekProvider, geminiProvider, nvidiaProvider, openaiCompatProvider } from "@/lib/ai/openai-compat";
import { getApiKey } from "@/lib/ai/credentials";
import { geminiCatalog, geminiModelUsable } from "@/lib/ai/gemini-catalog";
import { ModelUnavailableError, nvidiaCatalog, nvidiaModelUsable } from "@/lib/ai/nvidia-catalog";
import { runTurnWithRetry, type RetryOptions } from "@/lib/ai/retry";
import {
  MODELS,
  defaultEffort,
  estimateCost,
  estimateUncachedCost,
  getModel,
  ensureModel,
  envModelId,
  registerModel,
  type ModelSpec,
} from "@/lib/ai/models";
import {
  MissingCredentialError,
  type AiProvider,
  type AiTurnHandlers,
  type AiTurnRequest,
  type AiTurnResult,
  type ProviderId,
} from "@/lib/ai/types";

const PROVIDERS: Record<ProviderId, AiProvider> = {
  anthropic: anthropicProvider,
  groq: groqProvider,
  openai: openaiCompatProvider,
  nvidia: nvidiaProvider,
  gemini: geminiProvider,
  deepseek: deepseekProvider,
  "claude-cli": claudeCliProvider,
};

/** A provider can serve turns: a key, or (Claude CLI) a logged-in `claude` binary. */
async function providerReady(provider: ProviderId): Promise<boolean> {
  if (provider === "claude-cli") return claudeCliReady();
  // A keyless OpenAI-compatible endpoint (Ollama, vLLM) is named by its base URL alone.
  if (provider === "openai" && process.env.AI_BASE_URL?.trim()) return true;
  return Boolean(await getApiKey(provider));
}

/**
 * Test seam: route every turn through one scripted provider and treat every
 * model as available. There are no API keys in CI, so this is how the
 * runner, orchestrator, and compaction are exercised end to end.
 */
let override: { provider: AiProvider; retry?: RetryOptions } | null = null;

export function setProviderOverride(
  provider: AiProvider | null,
  retry?: RetryOptions,
): void {
  override = provider ? { provider, retry } : null;
}

/**
 * Fail fast when the model's provider has no credential, so an autonomous
 * run reports a setup error instead of spending attempts on a model that
 * can never answer. A test override always counts as ready.
 */
export async function ensureModelReady(model: string): Promise<void> {
  if (override) return;
  const spec = getModel(model);
  if (!spec) throw new Error(`Unknown model: ${model}`);
  if (!(await providerReady(spec.provider))) throw new MissingCredentialError(spec.provider);
}

export interface EnrichedTurnResult extends AiTurnResult {
  model: string;
  /** USD actually billed for this turn, cache pricing included. */
  cost: number;
  /** USD this turn would have cost with no prompt cache. */
  uncachedCost: number;
}

export async function runTurn(
  request: AiTurnRequest,
  handlers?: AiTurnHandlers,
): Promise<EnrichedTurnResult> {
  // A model already known to be retired/unavailable is swapped before the
  // call, so a long run does not pay a failing request on every turn.
  let model = await usableModel(request.model);
  for (let hop = 0; ; hop += 1) {
    try {
      return await runTurnOnce({ ...request, model }, handlers);
    } catch (error) {
      if (!(error instanceof ModelUnavailableError) || hop >= 8) throw error;
      const next = await usableModel(model);
      if (next === model) throw error;
      model = next;
    }
  }
}

/**
 * `model`, or the next usable model of its provider, or, when every model of
 * that provider is gone for this key (e.g. a free tier with no quota), the
 * best model of another configured provider. Models that already failed are
 * excluded by the live catalogs.
 */
async function usableModel(model: string): Promise<string> {
  const next = await usableCatalogModel(model);
  if (next !== model) return next;
  const spec = getModel(model);
  const usable = spec ? await catalogCheck(spec.provider) : null;
  if (!usable || usable(model)) return model;
  return resolveModel("auto", { agenticOnly: true }).catch(() => model);
}

/**
 * Providers whose model list comes from the key's live catalog: a model is
 * usable only when the catalog lists it (or the catalog is unreadable) and
 * it has not already answered "gone" / "not for this key" in this process.
 */
type CatalogCheck = (model: string) => boolean;

async function catalogCheck(provider: ProviderId): Promise<CatalogCheck | null> {
  if (override) return null;
  if (provider === "nvidia") {
    const ids = await nvidiaCatalog(await getApiKey("nvidia"));
    return (model) => nvidiaModelUsable(model.replace(/^nvidia:/, ""), ids);
  }
  if (provider === "gemini") {
    const models = await geminiCatalog(await getApiKey("gemini"));
    return (model) => geminiModelUsable(model.replace(/^gemini:/, ""), models);
  }
  return null;
}

/**
 * `model` itself when it is usable (or its provider has no live catalog);
 * otherwise the first usable model of the same provider and kind, in
 * preference order. Returns `model` unchanged when there is nothing better
 * to offer, so the caller surfaces the original error.
 */
async function usableCatalogModel(model: string): Promise<string> {
  const spec = getModel(model);
  if (!spec) return model;
  const usable = await catalogCheck(spec.provider);
  if (!usable || usable(model)) return model;
  const candidates = MODELS.filter(
    (m) => m.provider === spec.provider && m.id !== model && (!spec.agentic || m.agentic),
  );
  return candidates.find((m) => usable(m.id))?.id ?? model;
}

async function runTurnOnce(
  request: AiTurnRequest,
  handlers?: AiTurnHandlers,
): Promise<EnrichedTurnResult> {
  const spec = getModel(request.model);
  if (!spec) throw new Error(`Unknown model: ${request.model}`);

  const provider = override?.provider ?? PROVIDERS[spec.provider];
  const effort = request.effort ?? defaultEffort(spec);
  // Transient failures (429, 529, 5xx, dropped sockets) are retried here
  // with backoff, so every caller gets the same resilience for free. The
  // SDK clients have their own retries disabled to keep this the one place
  // that decides.
  const result = await runTurnWithRetry(
    provider,
    { ...request, effort },
    handlers,
    override?.retry,
  );

  return {
    ...result,
    model: request.model,
    cost: result.costUsd ?? estimateCost(request.model, result.usage),
    uncachedCost: estimateUncachedCost(request.model, result.usage),
  };
}

/**
 * Which models can actually run right now. The UI uses this to grey out
 * models whose provider has no key, instead of failing at request time.
 */
export async function availableModels(): Promise<
  { spec: ModelSpec; available: boolean }[]
> {
  // The model the environment names (AI_MODEL) joins the catalog on demand.
  const envId = envModelId();
  if (envId) ensureModel(envId);
  const keys = await Promise.all(
    (Object.keys(PROVIDERS) as ProviderId[]).map(
      async (id) => [id, override !== null || (await providerReady(id))] as const,
    ),
  );
  const configured = new Map(keys);
  // The Claude CLI (a subscription login) serves automatic picks only when no
  // API-key provider can: a configured key means the user chose that
  // provider. Naming a CLI model explicitly still works (resolveModel).
  if (keys.some(([id, ready]) => ready && id !== "claude-cli")) configured.set("claude-cli", false);
  // NVIDIA and Gemini retire models and list ones a key cannot call, so
  // their models are only "available" when the live catalog includes them.
  // Reading Gemini's catalog also registers its current models.
  const checks = new Map<ProviderId, CatalogCheck | null>();
  for (const provider of ["nvidia", "gemini"] as ProviderId[]) {
    if (configured.get(provider)) checks.set(provider, await catalogCheck(provider));
  }
  return MODELS.map((spec) => {
    const check = checks.get(spec.provider);
    return {
      spec,
      available: (configured.get(spec.provider) ?? false) && (!check || check(spec.id)),
    };
  });
}

const PROVIDER_PREFERENCE: ProviderId[] = ["anthropic", "deepseek", "gemini", "nvidia", "openai", "groq", "claude-cli"];

/**
 * Best available model at or above a tier, preferring Anthropic because its
 * tool-loop reliability is what the orchestrator depends on. Falls back
 * down the tiers so the app still works with only a Groq key configured.
 */
export async function resolveModel(
  preferred: string | "auto",
  opts: { agenticOnly?: boolean } = {},
): Promise<string> {
  if (getModel(preferred)?.provider === "claude-cli" && (override !== null || (await claudeCliReady()))) return preferred;
  const models = await availableModels();
  const usable = models.filter(
    ({ spec, available }) => available && (!opts.agenticOnly || spec.agentic),
  );
  if (usable.length === 0) {
    // Distinguish "no credentials at all" from "the configured provider has
    // no model good enough for this job" — they need different fixes.
    const anyConfigured = models.some((m) => m.available);
    throw new Error(
      anyConfigured
        ? "No configured model is reliable enough for agentic tool loops. Add an Anthropic key in Settings → Providers, or pick a different model."
        : "No API key configured. Add one in Settings → Providers to start building.",
    );
  }

  if (preferred !== "auto") {
    const match = usable.find((m) => m.spec.id === preferred);
    if (match) return match.spec.id;
  }

  // An explicitly configured model (AI_MODEL) wins "auto": evaluation runs
  // name the one model everyone must use. A bare id also matches a
  // provider-prefixed one (AI_MODEL=deepseek-v4-flash → deepseek:deepseek-v4-flash).
  const envId = envModelId();
  const envMatch = envId
    ? (usable.find((m) => m.spec.id === envId) ?? usable.find((m) => m.spec.id.endsWith(`:${envId}`)))
    : undefined;
  if (envMatch) return envMatch.spec.id;

  const rank: Record<string, number> = { frontier: 0, balanced: 1, fast: 2 };
  usable.sort((a, b) => {
    const tier = rank[a.spec.tier] - rank[b.spec.tier];
    if (tier !== 0) return tier;
    // Tie-break by provider: Anthropic for tool-loop reliability, then
    // Gemini, then NVIDIA (large models, generous limits), then any OpenAI-compatible
    // endpoint, and Groq last because its free tier's tokens-per-minute cap
    // stalls long agent runs.
    return PROVIDER_PREFERENCE.indexOf(a.spec.provider) - PROVIDER_PREFERENCE.indexOf(b.spec.provider);
  });
  return usable[0].spec.id;
}

export { MODELS, getModel, ensureModel, registerModel, envModelId, estimateCost, estimateUncachedCost };
export type { ModelSpec };
export * from "@/lib/ai/types";
export { classifyProviderError } from "@/lib/ai/retry";

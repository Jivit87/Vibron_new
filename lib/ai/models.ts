/**
 * The model catalog.
 *
 * Every model the IDE can drive, annotated with the facts the orchestrator
 * needs to route work: which provider serves it, how capable it is, how
 * fast, what it costs, and which API quirks apply.
 *
 * Capability tiers drive automatic routing — the orchestrator picks the
 * cheapest model whose tier clears the bar for a given specialist role, so
 * a "rename this variable everywhere" subtask does not burn Opus tokens.
 */

import type { AiEffort, ProviderId } from "@/lib/ai/types";

export type ModelTier = "frontier" | "balanced" | "fast";

export interface ModelSpec {
  id: string;
  provider: ProviderId;
  label: string;
  blurb: string;
  tier: ModelTier;
  /** Context window in tokens. */
  contextWindow: number;
  /** Max output tokens the model will accept. */
  maxOutput: number;
  /**
   * What we actually reserve per request.
   *
   * This matters more than it looks: Groq bills the *reserved* completion
   * budget against the account's tokens-per-minute cap, so asking for the
   * theoretical maximum makes every request fail on a small tier. Reserve
   * enough for a real answer and no more. A turn cut off at this cap is
   * retried once at `maxOutput` by the runner, so a low default only costs
   * extra when a turn genuinely needs the room.
   */
  defaultMaxOutput: number;
  /** USD per million input / output tokens. Used for the cost ledger. */
  pricing: { input: number; output: number };
  /** Supports `output_config.effort`. */
  supportsEffort: boolean;
  /** Supports adaptive thinking with a summarized display. */
  supportsThinking: boolean;
  /** Supports server-side prompt caching. */
  supportsCaching: boolean;
  /** Reliable enough at multi-step tool loops to drive the orchestrator. */
  agentic: boolean;
}

export const MODELS: ModelSpec[] = [
  {
    // Thinking is always on (it cannot be disabled) and effort defaults to
    // "medium" on the API; frontier-tier `defaultEffort` sends "high".
    id: "claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
    blurb: "Newest Opus: strongest agentic coding at a lower price than Opus 5. Runs at high effort.",
    tier: "frontier",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    defaultMaxOutput: 64_000,
    pricing: { input: 4, output: 20 },
    supportsEffort: true,
    supportsThinking: true,
    supportsCaching: true,
    agentic: true,
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    blurb: "Deepest reasoning and long-horizon agentic coding. The default driver.",
    tier: "frontier",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    defaultMaxOutput: 64_000,
    pricing: { input: 5, output: 25 },
    supportsEffort: true,
    supportsThinking: true,
    supportsCaching: true,
    agentic: true,
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    label: "Claude Sonnet 5",
    blurb: "Near-Opus coding quality at a fraction of the cost. Great specialist default.",
    tier: "balanced",
    contextWindow: 1_000_000,
    maxOutput: 128_000,
    defaultMaxOutput: 64_000,
    pricing: { input: 3, output: 15 },
    supportsEffort: true,
    supportsThinking: true,
    supportsCaching: true,
    agentic: true,
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    label: "Claude Haiku 4.5",
    blurb: "Fast and cheap. Good for mechanical edits, summaries, and indexing.",
    tier: "fast",
    contextWindow: 200_000,
    maxOutput: 64_000,
    defaultMaxOutput: 32_000,
    pricing: { input: 1, output: 5 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: true,
    agentic: true,
  },
  {
    id: "openai/gpt-oss-120b",
    provider: "groq",
    label: "GPT-OSS 120B",
    blurb: "Open-weights reasoner on Groq. Very fast, no key cost beyond Groq's.",
    tier: "balanced",
    contextWindow: 128_000,
    maxOutput: 32_000,
    defaultMaxOutput: 4_096,
    pricing: { input: 0.15, output: 0.75 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic: true,
  },
  {
    id: "llama-3.3-70b-versatile",
    provider: "groq",
    label: "Llama 3.3 70B",
    blurb: "Solid general model on Groq. Fast, cheap, weaker at long tool loops.",
    tier: "balanced",
    contextWindow: 128_000,
    maxOutput: 32_000,
    defaultMaxOutput: 4_096,
    pricing: { input: 0.59, output: 0.79 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic: false,
  },
  {
    id: "llama-3.1-8b-instant",
    provider: "groq",
    label: "Llama 3.1 8B",
    blurb: "Fastest option. Use for classification and tiny mechanical steps only.",
    tier: "fast",
    contextWindow: 128_000,
    maxOutput: 8_000,
    defaultMaxOutput: 2_048,
    pricing: { input: 0.05, output: 0.08 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic: false,
  },
];

/**
 * NVIDIA API Catalog (build.nvidia.com), served over the OpenAI-compatible
 * protocol. Ids carry an `nvidia:` prefix so they never collide with the
 * same open-weights model hosted elsewhere; the adapter strips it on the
 * wire. Any other catalog model works as `nvidia:<catalog id>`.
 */
function nvidiaModel(
  wire: string,
  label: string,
  blurb: string,
  tier: ModelTier,
  contextWindow: number,
  agentic: boolean,
): ModelSpec {
  return {
    id: `nvidia:${wire}`,
    provider: "nvidia",
    label,
    blurb,
    tier,
    contextWindow,
    maxOutput: 32_000,
    defaultMaxOutput: 16_000,
    // Catalog usage is credit-based rather than metered per token.
    pricing: { input: 0, output: 0 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic,
  };
}

// Verified against a live key (2026-09-27): each answers a tool call.
// Order is the preference for "auto" and for falling back when a model is
// retired; availability itself comes from the live catalog.
const NVIDIA_MODELS: ModelSpec[] = [
  nvidiaModel(
    "nvidia/nemotron-3-ultra-550b-a55b",
    "Nemotron 3 Ultra 550B (NVIDIA)",
    "NVIDIA's flagship open model. Fast, reliable tool calls; the NVIDIA default for agent runs.",
    "balanced",
    131_072,
    true,
  ),
  nvidiaModel(
    "moonshotai/kimi-k3",
    "Kimi K3 (NVIDIA)",
    "Agentic model tuned for long coding tasks and tool use. Slower per turn.",
    "balanced",
    131_072,
    true,
  ),
  nvidiaModel(
    "nvidia/nemotron-3-super-120b-a12b",
    "Nemotron 3 Super 120B (NVIDIA)",
    "Smaller, very fast Nemotron with solid tool calls.",
    "balanced",
    131_072,
    true,
  ),
  nvidiaModel(
    "deepseek-ai/deepseek-v4.1-flash",
    "DeepSeek V4.1 Flash (NVIDIA)",
    "Strong coder with hybrid thinking; high latency on the shared endpoint.",
    "balanced",
    131_072,
    true,
  ),
  nvidiaModel(
    "z-ai/glm-5.3-flash",
    "GLM 5.3 Flash (NVIDIA)",
    "Coding-oriented model from Z.ai.",
    "balanced",
    131_072,
    true,
  ),
  nvidiaModel(
    "openai/gpt-oss-20b",
    "GPT-OSS 20B (NVIDIA)",
    "Small, fast model for mechanical subtasks.",
    "fast",
    131_072,
    false,
  ),
];

MODELS.push(...NVIDIA_MODELS);

const BY_ID = new Map(MODELS.map((m) => [m.id, m] as const));

/** Add (or replace) a model at runtime, e.g. one named by `AI_MODEL`. */
export function registerModel(spec: ModelSpec): ModelSpec {
  const index = MODELS.findIndex((m) => m.id === spec.id);
  if (index === -1) MODELS.push(spec);
  else MODELS[index] = spec;
  BY_ID.set(spec.id, spec);
  return spec;
}

/** The model named by the environment (`AI_MODEL` / `VIBERON_MODEL`), if any. */
export function envModelId(): string | null {
  const id = (process.env.AI_MODEL || process.env.VIBERON_MODEL || "").trim();
  return id || null;
}

/**
 * Resolve a model id, registering an OpenAI-compatible spec on the fly for
 * `openai:<id>` and for the id the environment names. Unknown ids stay
 * unknown, so typos still fail loudly.
 */
export function ensureModel(id: string): ModelSpec | undefined {
  const known = BY_ID.get(id);
  if (known) return known;
  if (id.startsWith("gemini:") && id.length > "gemini:".length) {
    const wire = id.slice("gemini:".length);
    return registerModel({
      id,
      provider: "gemini",
      label: `${wire} (Gemini)`,
      blurb: "Gemini model.",
      tier: "balanced",
      contextWindow: 1_000_000,
      maxOutput: 65_536,
      defaultMaxOutput: 32_000,
      pricing: { input: 0, output: 0 },
      supportsEffort: false,
      supportsThinking: false,
      supportsCaching: false,
      agentic: true,
    });
  }
  if (id.startsWith("nvidia:") && id.length > "nvidia:".length) {
    return registerModel(
      nvidiaModel(id.slice("nvidia:".length), id.slice("nvidia:".length), "NVIDIA API Catalog model.", "balanced", 128_000, true),
    );
  }
  const envId = envModelId();
  if (!id.startsWith("openai:") && id !== envId) return undefined;
  const window = Number(process.env.VIBERON_CONTEXT_WINDOW || process.env.AI_CONTEXT_WINDOW);
  return registerModel({
    id,
    provider: "openai",
    label: id.replace(/^openai:/, ""),
    blurb: "OpenAI-compatible endpoint configured from the environment.",
    tier: "balanced",
    contextWindow: Number.isFinite(window) && window > 1000 ? window : 128_000,
    maxOutput: 32_000,
    defaultMaxOutput: 8_192,
    pricing: { input: 0, output: 0 },
    supportsEffort: false,
    supportsThinking: false,
    supportsCaching: false,
    agentic: true,
  });
}

export function getModel(id: string): ModelSpec | undefined {
  return BY_ID.get(id) ?? ensureModel(id);
}

/** `VIBERON_MAX_OUTPUT`: the output ceiling of an OpenAI-compatible endpoint, when set. */
function envMaxOutput(): number | undefined {
  const n = Number(process.env.VIBERON_MAX_OUTPUT);
  return Number.isFinite(n) && n >= 256 ? Math.floor(n) : undefined;
}

/**
 * The output cap a request gets: its own `maxTokens`, else the model default,
 * never above the model's ceiling. For OpenAI-compatible endpoints
 * `VIBERON_MAX_OUTPUT` replaces both (the endpoint's limit is unknown to us).
 */
export function outputCap(spec: ModelSpec | undefined, requested?: number): number {
  const env = spec?.provider === "openai" ? envMaxOutput() : undefined;
  return Math.min(requested ?? env ?? spec?.defaultMaxOutput ?? 8_192, maxOutputCap(spec));
}

/** The largest output a request to this model may reserve. */
export function maxOutputCap(spec: ModelSpec | undefined): number {
  return (spec?.provider === "openai" ? envMaxOutput() : undefined) ?? spec?.maxOutput ?? 32_000;
}

export function modelsForProvider(provider: ProviderId): ModelSpec[] {
  return MODELS.filter((m) => m.provider === provider);
}

/**
 * Cost of a turn in USD. Cache reads bill at ~0.1x input, cache writes at
 * ~1.25x, which is what makes the cached project-memory prefix such a large
 * saving — we surface the delta in the token ledger.
 */
export function estimateCost(
  modelId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): number {
  const spec = BY_ID.get(modelId);
  if (!spec) return 0;
  const inRate = spec.pricing.input / 1_000_000;
  const outRate = spec.pricing.output / 1_000_000;
  return (
    usage.inputTokens * inRate +
    usage.cacheReadTokens * inRate * 0.1 +
    usage.cacheWriteTokens * inRate * 1.25 +
    usage.outputTokens * outRate
  );
}

/**
 * What a turn *would* have cost if every cached token had been sent fresh.
 * The gap between this and `estimateCost` is the caching win.
 */
export function estimateUncachedCost(
  modelId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
): number {
  const spec = BY_ID.get(modelId);
  if (!spec) return 0;
  const inRate = spec.pricing.input / 1_000_000;
  const outRate = spec.pricing.output / 1_000_000;
  const allInput =
    usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return allInput * inRate + usage.outputTokens * outRate;
}

/** Default effort per tier — tuned for agentic coding. */
export function defaultEffort(spec: ModelSpec): AiEffort | undefined {
  if (!spec.supportsEffort) return undefined;
  return spec.tier === "frontier" ? "high" : "medium";
}

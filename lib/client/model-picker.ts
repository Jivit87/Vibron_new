/**
 * Pure logic behind the model picker: filtering, grouping and formatting.
 * Kept out of the component so it can be unit-tested without a DOM.
 */

export interface ModelOption {
  id: string;
  label: string;
  blurb: string;
  tier: string;
  provider: string;
  available: boolean;
  agentic: boolean;
  contextWindow?: number;
  pricing?: { input: number; output: number };
}

const PROVIDERS: { id: string; label: string }[] = [
  { id: "anthropic", label: "Anthropic" },
  { id: "claude-cli", label: "Claude subscription (CLI)" },
  { id: "gemini", label: "Google Gemini" },
  { id: "nvidia", label: "NVIDIA" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "openai", label: "OpenAI-compatible" },
  { id: "groq", label: "Groq" },
];

export const AUTO: ModelOption = {
  id: "auto",
  label: "Auto",
  blurb: "Picks the strongest model you have a key for, per role.",
  tier: "",
  provider: "",
  available: true,
  agentic: true,
};

export function formatContext(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`;
  return `${Math.round(tokens / 1000)}k`;
}

export function formatPrice(pricing: ModelOption["pricing"]): string {
  if (!pricing || (pricing.input === 0 && pricing.output === 0)) return "Billed by provider plan";
  return `$${pricing.input} / $${pricing.output} per MTok`;
}

/** Case-insensitive match on every word of the query, across label, id, provider and blurb. */
export function matchesModel(model: ModelOption, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const provider = PROVIDERS.find((p) => p.id === model.provider)?.label ?? model.provider;
  const haystack = `${model.label} ${model.id} ${provider} ${model.blurb} ${model.tier}`.toLowerCase();
  return words.every((w) => haystack.includes(w));
}

interface Group {
  id: string;
  label: string;
  configured: boolean;
  models: ModelOption[];
}

/** Providers in preference order; ones without a key sink to the bottom. */
export function groupModels(models: ModelOption[], query: string): Group[] {
  const known = new Set(PROVIDERS.map((p) => p.id));
  const extra = [...new Set(models.map((m) => m.provider))]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id }));
  const groups = [...PROVIDERS, ...extra]
    .map((p) => {
      const all = models.filter((m) => m.provider === p.id);
      return {
        id: p.id,
        label: p.label,
        configured: all.some((m) => m.available),
        models: all.filter((m) => matchesModel(m, query)),
      };
    })
    .filter((g) => g.models.length > 0);
  return [...groups.filter((g) => g.configured), ...groups.filter((g) => !g.configured)];
}

/** Inside a provider group the "(Gemini)" / "(NVIDIA)" suffix only repeats the heading. */
export function displayLabel(model: ModelOption): string {
  return model.label.replace(/\s*\((Gemini|NVIDIA|Groq)\)$/, "");
}

/** What an unconfigured provider group offers: the CLI logs in, the rest take a key. */
export function setupAction(providerId: string): string {
  return providerId === "claude-cli" ? "Log in with claude" : "Add key";
}

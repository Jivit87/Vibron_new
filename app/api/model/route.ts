/**
 * GET /api/model[?model=<id>] → 200 { ok, model, label, provider, baseUrl, keySource, contextWindow, tier }
 *                              | 200 { ok: false, error }
 *   Which provider, endpoint and model a run would use right now (Pramana
 *   Studio's `/api/model`): the "auto" pick, or `model` when given and usable.
 *   Tiny on purpose, so the UI can show it on every load without pulling the
 *   whole /api/models catalog. Never returns a key, only where it came from.
 */

import { getModel, resolveModel, type ModelSpec } from "@/lib/ai";
import { credentialStatus } from "@/lib/ai/credentials";
import { PROVIDER_TABLE, resolveOpenAiCompatEnv, type DetectedProvider } from "@/lib/ai/provider-config";

export const runtime = "nodejs";

const strip = (url: string) => url.replace(/\/+$/, "");

function endpointFor(spec: ModelSpec): string {
  const env = process.env;
  switch (spec.provider) {
    case "claude-cli":
      return "";
    case "anthropic":
      return strip(env.ANTHROPIC_BASE_URL || PROVIDER_TABLE.anthropic.baseUrl);
    case "deepseek":
      return strip(env.DEEPSEEK_BASE_URL || "https://api.deepseek.com");
    case "gemini":
      return strip(env.GEMINI_BASE_URL || PROVIDER_TABLE.gemini.baseUrl);
    case "openai":
      return env.AI_API_KEY || env.OPENAI_API_KEY || env.AI_BASE_URL
        ? resolveOpenAiCompatEnv().baseUrl
        : PROVIDER_TABLE.openai.baseUrl;
    default:
      return PROVIDER_TABLE[spec.provider as DetectedProvider]?.baseUrl ?? "";
  }
}

async function keySourceFor(spec: ModelSpec): Promise<string> {
  if (spec.provider === "claude-cli") return "your logged-in Claude Code (no key needed)";
  try {
    const status = await credentialStatus(spec.provider);
    if (!status.configured) return "not configured";
    return status.fromEnv ? status.envVar : "a key saved in Settings";
  } catch {
    return "unknown";
  }
}

export async function GET(request: Request) {
  const wanted = new URL(request.url).searchParams.get("model")?.trim() || "auto";
  let id: string;
  try {
    id = await resolveModel(wanted);
  } catch (error) {
    return Response.json({ ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
  }
  const spec = getModel(id);
  if (!spec) return Response.json({ ok: false, error: `unknown model ${id}` });
  return Response.json({
    ok: true,
    model: spec.id,
    label: spec.label,
    provider: spec.provider,
    baseUrl: endpointFor(spec),
    keySource: await keySourceFor(spec),
    contextWindow: spec.contextWindow,
    tier: spec.tier,
    requested: wanted,
  });
}

/**
 * Provider credential management.
 *
 *   GET    /api/settings/keys  → configured status per provider (masked only)
 *   PUT    /api/settings/keys  → save a key, after verifying it works
 *   DELETE /api/settings/keys?provider=…
 *
 * Raw keys are never returned to the browser — only a masked fingerprint and
 * a boolean. Saving verifies the key with a minimal live request first, so a
 * typo surfaces immediately instead of at the start of an expensive run.
 */

import { claudeCliReady } from "@/lib/ai/claude-cli";
import { allCredentialStatus, KEY_PROVIDERS, setApiKey } from "@/lib/ai/credentials";
import { deepseekBaseUrl } from "@/lib/ai/deepseek";
import type { ProviderId } from "@/lib/ai/types";
import { geminiApiRoot } from "@/lib/ai/gemini-catalog";
import { nvidiaBaseUrl } from "@/lib/ai/nvidia-catalog";
import { resolveOpenAiCompatEnv } from "@/lib/ai/provider-config";

export const runtime = "nodejs";

/** Providers that take a key here; the Claude CLI row is read-only (its login lives in `claude`). */
const PROVIDERS = KEY_PROVIDERS;

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.includes(value as ProviderId);
}

/** Every key row, plus a read-only "Claude subscription (CLI)" row. */
async function providerRows() {
  const [keys, cli] = await Promise.all([allCredentialStatus(), claudeCliReady()]);
  return [
    ...keys,
    {
      provider: "claude-cli" as const,
      label: "Claude subscription (CLI)",
      readOnly: true,
      configured: cli,
      masked: null,
      fromEnv: false,
      envVar: "",
    },
  ];
}

export async function GET() {
  return Response.json({ providers: await providerRows() });
}

function modelsEndpoint(provider: ProviderId): { label: string; url: string } {
  if (provider === "nvidia") {
    return { label: "NVIDIA", url: `${nvidiaBaseUrl()}/models` };
  }
  if (provider === "deepseek") {
    return { label: "DeepSeek", url: `${deepseekBaseUrl()}/models` };
  }
  if (provider === "openai") {
    return { label: "The endpoint", url: `${resolveOpenAiCompatEnv().baseUrl}/models` };
  }
  return { label: "Groq", url: "https://api.groq.com/openai/v1/models" };
}

/** Smallest possible live call that proves the credential is valid. */
async function verifyKey(
  provider: ProviderId,
  key: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (provider === "anthropic") {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (response.ok) return { ok: true };
      // max_tokens:1 stops immediately; that is a success, not a failure.
      if (response.status === 400) {
        const body = (await response.json().catch(() => null)) as {
          error?: { type?: string; message?: string };
        } | null;
        const type = body?.error?.type ?? "";
        if (!/auth|permission|api.?key/i.test(type + (body?.error?.message ?? ""))) {
          return { ok: true };
        }
        return { ok: false, error: body?.error?.message ?? "Invalid request" };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: "Key rejected — check it and try again." };
      }
      return { ok: false, error: `Anthropic returned ${response.status}.` };
    }

    if (provider === "gemini") {
      // Gemini takes its key in a header, not as a bearer token.
      const response = await fetch(`${geminiApiRoot()}/models?pageSize=1`, {
        headers: { "x-goog-api-key": key },
      });
      if (response.ok) return { ok: true };
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return { ok: false, error: "Key rejected — check it and try again." };
      }
      return { ok: false, error: `Gemini returned ${response.status}.` };
    }

    // Groq, NVIDIA, DeepSeek and OpenAI-compatible endpoints all list models with the key.
    const { label, url } = modelsEndpoint(provider);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "Key rejected — check it and try again." };
    }
    return { ok: false, error: `${label} returned ${response.status}.` };
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the provider: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function PUT(request: Request) {
  let body: { provider?: unknown; key?: unknown; skipVerify?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  if (!isProvider(body.provider)) {
    return Response.json(
      { error: `provider must be one of: ${PROVIDERS.join(", ")}` },
      { status: 400 },
    );
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  if (body.skipVerify !== true) {
    const verdict = await verifyKey(body.provider, key);
    if (verdict.ok === false) {
      return Response.json({ error: verdict.error }, { status: 400 });
    }
  }

  await setApiKey(body.provider, key);
  return Response.json({ ok: true, providers: await providerRows() });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const provider = url.searchParams.get("provider");
  if (!isProvider(provider)) {
    return Response.json({ error: "Unknown provider" }, { status: 400 });
  }
  await setApiKey(provider, null);
  return Response.json({ ok: true, providers: await providerRows() });
}

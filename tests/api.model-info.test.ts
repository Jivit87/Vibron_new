/** GET /api/model: which provider, endpoint and model a run would use (Pramana Studio's /api/model). */

import { afterEach, describe, expect, it, vi } from "vitest";

const resolveModel = vi.fn<(preferred: string) => Promise<string>>();

vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), resolveModel: (p: string) => resolveModel(p) }));
vi.mock("@/lib/ai/credentials", () => ({
  credentialStatus: async (provider: string) => ({
    provider,
    configured: provider !== "groq",
    masked: "sk-ant-…abcd",
    fromEnv: provider === "anthropic",
    envVar: `${provider.toUpperCase()}_API_KEY`,
  }),
}));

const { GET } = await import("@/app/api/model/route");
const { MODELS } = await import("@/lib/ai");

afterEach(() => {
  resolveModel.mockReset();
  vi.unstubAllEnvs();
});

describe("GET /api/model", () => {
  it("describes the auto pick: provider, endpoint, model and key source, never the key", async () => {
    const spec = MODELS.find((m) => m.provider === "anthropic")!;
    resolveModel.mockResolvedValue(spec.id);
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.com/");
    const body = (await (await GET(new Request("http://x/api/model"))).json()) as Record<string, unknown>;
    expect(resolveModel).toHaveBeenCalledWith("auto");
    expect(body).toMatchObject({
      ok: true,
      model: spec.id,
      provider: "anthropic",
      baseUrl: "https://proxy.example.com",
      keySource: "ANTHROPIC_API_KEY",
      requested: "auto",
    });
    expect(JSON.stringify(body)).not.toContain("abcd");
  });

  it("honours ?model= and reports a Claude CLI model with no endpoint", async () => {
    const spec = MODELS.find((m) => m.provider === "claude-cli")!;
    resolveModel.mockResolvedValue(spec.id);
    const body = (await (await GET(new Request(`http://x/api/model?model=${encodeURIComponent(spec.id)}`))).json()) as Record<string, unknown>;
    expect(resolveModel).toHaveBeenCalledWith(spec.id);
    expect(body).toMatchObject({ ok: true, provider: "claude-cli", baseUrl: "" });
    expect(String(body.keySource)).toContain("Claude Code");
  });

  it("returns ok:false with the reason when nothing is configured", async () => {
    resolveModel.mockRejectedValue(new Error("No API key configured."));
    const body = (await (await GET(new Request("http://x/api/model"))).json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, error: "No API key configured." });
  });
});

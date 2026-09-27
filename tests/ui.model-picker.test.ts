import { describe, expect, it } from "vitest";

import { formatContext, groupModels, matchesModel, type ModelOption } from "@/lib/client/model-picker";

function model(partial: Partial<ModelOption> & Pick<ModelOption, "id" | "provider">): ModelOption {
  return { label: partial.id, blurb: "", tier: "balanced", available: true, agentic: true, ...partial };
}

const MODELS: ModelOption[] = [
  model({ id: "claude-opus-5-5", provider: "anthropic", label: "Claude Opus 5.5", available: false, contextWindow: 1_000_000 }),
  model({ id: "gemini:gemini-3.8-flash", provider: "gemini", label: "Gemini 3.8 Flash (Gemini)", contextWindow: 1_048_576 }),
  model({ id: "nvidia:nvidia/nemotron-3-ultra-550b-a55b", provider: "nvidia", label: "Nemotron 3 Ultra 550B (NVIDIA)", contextWindow: 131_072 }),
  model({ id: "llama-3.1-8b-instant", provider: "groq", label: "Llama 3.1 8B", agentic: false }),
];

describe("model picker", () => {
  it("matches every query word across label, id and provider name", () => {
    expect(matchesModel(MODELS[1], "flash gemini")).toBe(true);
    expect(matchesModel(MODELS[1], "google 3.8")).toBe(true);
    expect(matchesModel(MODELS[2], "nemotron ultra")).toBe(true);
    expect(matchesModel(MODELS[2], "nemotron flash")).toBe(false);
  });

  it("groups by provider and sinks providers without a key to the bottom", () => {
    const groups = groupModels(MODELS, "");
    expect(groups.map((g) => g.id)).toEqual(["gemini", "nvidia", "groq", "anthropic"]);
    expect(groups.at(-1)?.configured).toBe(false);
  });

  it("drops groups with no matches", () => {
    expect(groupModels(MODELS, "nemotron").map((g) => g.id)).toEqual(["nvidia"]);
    expect(groupModels(MODELS, "zzz")).toEqual([]);
  });

  it("formats context windows compactly", () => {
    expect(formatContext(1_000_000)).toBe("1M");
    expect(formatContext(1_048_576)).toBe("1M");
    expect(formatContext(131_072)).toBe("131k");
    expect(formatContext(undefined)).toBe("");
  });
});

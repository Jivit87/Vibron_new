import { describe, expect, it } from "vitest";

import { tokenRate, type TurnUsageRecord } from "@/lib/client/usage";

const turn = (at: number, tokens: number): TurnUsageRecord => ({
  agentId: "a",
  model: "m",
  inputTokens: tokens,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  uncachedUsd: 0,
  contextTokens: 0,
  at,
});

describe("tokenRate", () => {
  it("is zero with no recent calls", () => {
    expect(tokenRate([], 100_000)).toBe(0);
    expect(tokenRate([turn(0, 5000)], 100_000)).toBe(0);
  });
  it("spreads tokens over the span since the first recent call", () => {
    expect(tokenRate([turn(70_000, 3000), turn(100_000, 3000)], 100_000)).toBe(12_000);
  });
  it("floors the span so a single burst is not absurd", () => {
    expect(tokenRate([turn(100_000, 1000)], 100_000)).toBe(6000);
  });
});

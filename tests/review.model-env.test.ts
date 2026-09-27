/**
 * Hackathon rule (docs/HACKATHON_MAKEFILE_COMPLIANCE.md §4): an evaluation
 * names ONE model via AI_MODEL, and every call, side calls included, must
 * use it. reviewModel() is how criteria, the reviewer and the blind writer
 * choose theirs.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { invalidateCredentialCache } from "@/lib/ai/credentials";
import { reviewModel } from "@/lib/review";
import { resetMemoryStoreForTests } from "@/lib/store";

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateCredentialCache();
});

describe("side-call model under AI_MODEL", () => {
  it("uses the evaluator's model instead of the cheapest one", async () => {
    resetMemoryStoreForTests();
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    invalidateCredentialCache();
    expect(await reviewModel()).toBe("claude-haiku-4-5");
    vi.stubEnv("AI_MODEL", "claude-opus-5");
    expect(await reviewModel()).toBe("claude-opus-5");
    // An explicit choice still wins.
    expect(await reviewModel("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});

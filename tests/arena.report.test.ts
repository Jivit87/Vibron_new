import { describe, expect, it } from "vitest";

import { parseArenaJsonl, summarizeArena } from "@/eval/arena";

describe("arena report", () => {
  it("uses the latest successful retry and ranks on the common task set", () => {
    const rows = parseArenaJsonl([
      { harness: "alpha", instance_id: "one", resolved: false, error: "setup failed", tokens: 0 },
      { harness: "alpha", instance_id: "one", resolved: true, tokens: 100, harness_seconds: 20 },
      { harness: "alpha", instance_id: "two", resolved: false, tokens: 50, harness_seconds: 10 },
      { harness: "alpha", instance_id: "extra", resolved: true, tokens: 1, harness_seconds: 1 },
      { harness: "beta", instance_id: "one", resolved: true, tokens: 200, harness_seconds: 10 },
      { harness: "beta", instance_id: "two", resolved: false, tokens: 50, harness_seconds: 10 },
    ].map((row) => JSON.stringify(row)).join("\n"));
    const report = summarizeArena(rows);
    expect(report.commonTasks).toEqual(["one", "two"]);
    expect(report.harnesses.map((h) => h.harness)).toEqual(["alpha", "beta"]);
    expect(report.harnesses[0]).toMatchObject({ resolved: 1, total: 2, available: 3, meanTokens: 75 });
    expect(report.harnesses[1]).toMatchObject({ resolved: 1, total: 2, available: 2, meanTokens: 125 });
  });

  it("uses time after correctness and tokens, and rejects malformed input", () => {
    const report = summarizeArena(parseArenaJsonl([
      { harness: "slow", instance_id: "one", resolved: true, input: 60, output: 40, harness_seconds: 12 },
      { harness: "fast", instance_id: "one", resolved: true, input: 60, output: 40, harness_seconds: 5 },
    ].map((row) => JSON.stringify(row)).join("\n")));
    expect(report.harnesses.map((h) => h.harness)).toEqual(["fast", "slow"]);
    expect(() => parseArenaJsonl('{"harness":"x"}')).toThrow(/line 1/);
  });

  it("does not reward missing usage telemetry as zero cost", () => {
    const report = summarizeArena(parseArenaJsonl([
      { harness: "unknown", instance_id: "one", resolved: true },
      { harness: "measured", instance_id: "one", resolved: true, tokens: 100, harness_seconds: 3 },
    ].map((row) => JSON.stringify(row)).join("\n")));
    expect(report.harnesses.map((h) => h.harness)).toEqual(["measured", "unknown"]);
    expect(report.harnesses[1].meanTokens).toBeNull();
  });
});

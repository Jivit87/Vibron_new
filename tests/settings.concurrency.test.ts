import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { MAX_CONCURRENCY } from "@/lib/limits";

/**
 * There is no jsdom/React Testing Library setup in this repo (vitest runs
 * in the `node` environment), so this checks the actual source the browser
 * ships rather than rendering it: the "Parallel specialists" NumberInput
 * must key its ceiling off the shared constant, not a hardcoded 6.
 */
describe("Settings — parallel specialists ceiling", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../components/vibe/SettingsPage.tsx"),
    "utf8",
  );

  it("shares the same ceiling constant as the store and the API route", () => {
    expect(MAX_CONCURRENCY).toBe(10);
    expect(source).toContain('import { MAX_CONCURRENCY } from "@/lib/limits"');
  });

  it("wires the NumberInput's max to that constant, not a hardcoded 6", () => {
    const match = source.match(/label="Parallel specialists"[\s\S]*?<NumberInput([^/]*)\/>/);
    expect(match, "could not find the Parallel specialists row").toBeTruthy();
    const inputProps = match![1];
    expect(inputProps).toContain("max={MAX_CONCURRENCY}");
    expect(inputProps).not.toMatch(/max=\{6\}/);
  });
});

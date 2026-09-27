/**
 * Token budget regression tests.
 *
 * Each scenario runs `solveTask` for real on an `eval/tasks` fixture against
 * the scripted fake provider (see `scripts/bench-tokens.ts`, which prints the
 * full per-turn table, and `docs/TOKENS.md`). The assertions compare token
 * COUNTS, call counts and ratios of what the harness sends the model: never
 * wall-clock, so they are stable under load and vitest's 30 s timeout.
 *
 * THRESHOLDS: each constant below is the value measured on main when this
 * file was written, plus ~10% headroom. They are ceilings only. When a change
 * makes the harness cheaper, run `pnpm exec tsx scripts/bench-tokens.ts`,
 * and TIGHTEN the matching constant (keep ~10% headroom) so the win cannot
 * silently regress. Raising one needs a reason in the commit message.
 */

import { afterEach, describe, expect, it } from "vitest";

import { BENCH_MAX_TURNS, runScenario, SCENARIOS, type ScenarioResult } from "../scripts/bench-tokens";
import { uninstallFakeProvider } from "./helpers/fake-provider";

// --- Budgets (measured on main 2026-09-27; headroom in parentheses) --------

/** truncate-fix: 5 solver calls + 1 reviewer; measured 17,111 input tokens (19,001 before the token diet). */
const FIX_SMALL_MAX_INPUT = 19_000; // (+11%)
/** semver-fix: same shape, a bigger rewrite; measured 21,436 (23,371 before). */
const FIX_LARGE_MAX_INPUT = 23_600; // (+10%)
/** A scripted 5-turn fix must not trigger extra model calls (measured 6: 5 solver + 1 review). */
const FIX_MAX_CALLS = 6;
/**
 * never-edits: the model only reads/greps. Before the give-up rules: 63 calls
 * (2 attempts x 30 turns + criteria + writer), 290,166 input tokens. Now the
 * attempt ends with no source edit by turn 12 and attempt 2 is skipped:
 * measured 12 calls, 38,314 tokens.
 */
const NEVER_EDITS_MAX_CALLS = 14; // (+2 calls)
const NEVER_EDITS_MAX_INPUT = 42_000; // (+10%)
/** System prompt + tool schemas re-sent on every solver call; measured 1,248 + 964. */
const SOLVER_FIXED_MAX_PER_CALL = 2_450; // (+10%)
/**
 * Share of input tokens that is new vs the same agent's previous request
 * (i.e. not servable from a prompt cache). Measured 11.3% over the now-short
 * 12-call loop (6% over the old 63-call loop: the fully fresh first call is a
 * bigger share of fewer calls). A prefix break would push this well up.
 */
const NEVER_EDITS_MAX_FRESH_RATIO = 0.13;

afterEach(() => uninstallFakeProvider());

const scenario = (name: string) => {
  const found = SCENARIOS.find((s) => s.name === name);
  if (!found) throw new Error(`no scenario ${name}`);
  return found;
};

function fixedPerSolverCall(result: ScenarioResult): number {
  const solver = result.rows.filter((r) => r.who === "solver");
  return Math.max(...solver.map((r) => r.system + r.tools));
}

describe("token budgets (scripted, no API keys)", () => {
  it("a small scripted fix stays under its input-token budget", async () => {
    const result = await runScenario(scenario("truncate-fix"));
    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["src/truncate.js"]);
    expect(result.totals.calls).toBeLessThanOrEqual(FIX_MAX_CALLS);
    expect(result.totals.total).toBeLessThanOrEqual(FIX_SMALL_MAX_INPUT);
    expect(fixedPerSolverCall(result)).toBeLessThanOrEqual(SOLVER_FIXED_MAX_PER_CALL);
  });

  it("a larger scripted fix stays under its input-token budget", async () => {
    const result = await runScenario(scenario("semver-fix"));
    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["src/semver.js"]);
    expect(result.totals.calls).toBeLessThanOrEqual(FIX_MAX_CALLS);
    expect(result.totals.total).toBeLessThanOrEqual(FIX_LARGE_MAX_INPUT);
  });

  it("a model that never edits is stopped within its call and token budget", async () => {
    const result = await runScenario(scenario("never-edits"));
    expect(result.status).not.toBe("resolved");
    expect(result.filesChanged).toEqual([]);
    expect(result.totals.calls).toBeLessThanOrEqual(NEVER_EDITS_MAX_CALLS);
    // Hard ceiling independent of the constant above: at most maxAttempts (2) full loops plus side calls.
    expect(result.rows.filter((r) => r.who === "solver").length).toBeLessThanOrEqual(2 * BENCH_MAX_TURNS);
    expect(result.totals.total).toBeLessThanOrEqual(NEVER_EDITS_MAX_INPUT);
    expect(result.totals.fresh / result.totals.total).toBeLessThanOrEqual(NEVER_EDITS_MAX_FRESH_RATIO);
    expect(fixedPerSolverCall(result)).toBeLessThanOrEqual(SOLVER_FIXED_MAX_PER_CALL);
  });
});

# Round 5: Pramana parity, Vibron's weak points, speed

The user's request: *everything Vibron needs, everything Pramana has that Vibron lacks, fix every weak point, then optimise so output is fast and the engine is strong.*

## Gap audit (checked in code, 2026-09-27)

Already in Vibron, ported earlier:
- the original-vs-patched gate, with stub and test-edit rejection;
- the tolerant editor, lint gate and oscillation detection;
- loop guards and the harness checkpoint;
- localization and issue snippets;
- two attempts plus lessons;
- the text tool protocol, reasoning pass-back and perturbing retries;
- evidence bundle, eval, bootstrap.

Missing from Vibron:

| # | Pramana has | Why it matters | Owner |
|---|---|---|---|
| 1 | Acceptance-criteria prediction (1 cheap call) | The maintainer's checklist up front; feeds the test writer and reviewer | A |
| 2 | Blind independent test writer (never sees the patch; runs on original vs patched; still failing → back to the agent once) | Evidence that does not come from the agent's own reading | A |
| 3 | Reviewer that predicts the maintainer's test and reads a wide-context diff (25 lines) for untouched sibling code | Catches incomplete fixes, Pramana's #1 unresolved pattern | A (merge into the existing reviewer, one reviewer only) |
| 4 | Claude CLI provider (`claude -p`, subscription, no API key) | Real runs without an API key, which unblocks measurement | B |
| 5 | DeepSeek support (the judges' model class): key probing (`sk-`+32 hex is ambiguous), catalog, reasoning pass-back on every tool turn | Correctness on the judged model | B |
| 6 | SWE-bench Verified runner graded by hidden tests (`bench/swebench`) | Evidence over claims: real resolve rates | B |
| 7 | Issue intake formats (`owner/repo#N`, a file, stdin) | CLI ergonomics for judges | B |

Vibron's own weak points:

| # | Weak point | Fix | Owner |
|---|---|---|---|
| W1 | Never run on a real model | #4, then a real eval | B, then planner |
| W2 | Serial setup phases | Index ∥ detect ∥ snapshot ∥ localize ∥ criteria ∥ baseline, all concurrent | A |
| W3 | The gate runs original, then patched | Run both sides concurrently (temp checkout vs work tree) | A |
| W4 | No per-phase timing in the result | `metrics.phaseMs` (setup, localize, criteria, loop, gate, testWriter, review, deliver) | A |
| W5 | Transcript pruning may break the prompt-cache prefix (Pramana's known DeepSeek issue) | Prove with a test that the prefix is byte-stable between compactions; prune only at compaction | A |
| W6 | `detectVerifyCommands` re-probes on every run (343 ms) | Cache per root, keyed on manifest mtimes | B |

## Speed rules
- Nothing the harness does may serialize behind a model call when it could run alongside it.
- The test writer and the reviewer run **concurrently** after an accept.
- Every added model call must be optional, and skipped when the budget is more than 75% spent.

## Ownership
- **A:** `lib/harness/**`, `lib/agents/**`, `lib/review/**`, `lib/tools/**`, `tests/harness.*`, `tests/review.*`.
- **B:**
  - `lib/ai/**` (except files A needs; A must not edit `lib/ai`);
  - `lib/verify/**`, `lib/headless/**`, `cli/**`, `eval/**`;
  - a new `bench/**` or `eval/swe/**`;
  - `app/api/settings/**`;
  - tests `ai.*`, `verify.*`, `cli.*`, `eval.*`, `swe.*`.
- **FE:** `components/**`, `lib/client/**`, `store/**`, `tests/ui.*`.

Merge order: A, B, FE. Every branch keeps tsc, eslint, vitest (30s timeout) and next build green.

## Contracts
- **New events** (additive in `lib/agents/events.ts`, A owns):
  - `{type:"criteria", items:string[]}`;
  - `{type:"independent_test", status:"written"|"ran"|"skipped"|"gave_up", command?, verdict?, seconds?}`;
  - `{type:"phase", name, ms}`, emitted when each phase ends.
- `SolveResult.metrics.phaseMs: Record<string, number>`.
- `SolveOptions.criteria?: boolean` (default true); `SolveOptions.independentTest?: boolean` (default true when verify is enabled).
- **Provider ids** (B):
  - `claude-cli:haiku|sonnet|opus`, used by `auto` only when no API provider is configured;
  - `deepseek:deepseek-v4-flash|deepseek-v4-pro`, with env `DEEPSEEK_API_KEY`.

# Where the tokens go

A 10-issue batch on an NVIDIA-hosted model measured **221 model calls,
1.28M input tokens and 172k output tokens**: about 22 calls and 128k input
tokens per issue, and roughly 7 input tokens for every output token. This page
explains where those input tokens come from, using a benchmark that runs the
real harness without API keys.

## The benchmark

```
pnpm exec tsx scripts/bench-tokens.ts              # every scenario, per-turn tables
pnpm exec tsx scripts/bench-tokens.ts never-edits  # one scenario
pnpm exec tsx scripts/bench-tokens.ts --json       # machine-readable
```

`scripts/bench-tokens.ts` copies an `eval/tasks` fixture to a temp git repo and
runs `solveTask` for real: snapshot, localize, baseline gate, verification
commands and the reviewer. It uses the same budget as a batch issue run
(`maxTurns: 30`, fast mode, `lib/tasks/runners.ts`). The model is the scripted
`FakeProvider` (`tests/helpers/fake-provider.ts`), which records every request.
Each request is split into what it sends again:

| column    | what it is                                                                 |
|-----------|----------------------------------------------------------------------------|
| `system`  | system prompt blocks                                                        |
| `tools`   | tool schemas (JSON), sent on every call                                     |
| `task`    | the first user message: the issue plus localized context                    |
| `history` | every later assistant turn (reasoning text + tool calls) and harness nudge  |
| `results` | every `tool_result` in the transcript                                       |
| `fresh`   | tokens that are not in the same agent's previous request. A prompt cache cannot serve these; everything else is a cache read. |

Counts use `countTokens` from `lib/tokens.ts` (gpt-tokenizer). Real
tokenizers differ by a few percent, but the proportions hold.

Scenarios:

- **truncate-fix** (`eval/tasks/truncate-regression`): grep, then read the source and test, then create a repro and edit, then run it, then `finish`.
- **semver-fix** (`eval/tasks/semver-js`): the same five turns with a larger rewrite.
- **never-edits** (truncate fixture): the model only reads, greps and lists, and never edits. This is the failure mode that dominates real batches.

## Measured on main (2026-09-27)

| scenario     | calls | input   | fresh  | output | system | tools  | task   | history | results |
|--------------|------:|--------:|-------:|-------:|-------:|-------:|-------:|--------:|--------:|
| truncate-fix |     6 |  19,001 |  5,697 |    436 |  6,760 |  4,820 |  4,998 |     794 |   1,629 |
| semver-fix   |     6 |  23,371 |  7,533 |  1,021 |  6,770 |  4,820 |  7,405 |   1,963 |   2,413 |
| never-edits  |    63 | 290,166 | 16,465 |  1,285 | 75,844 | 59,338 | 59,089 |  16,658 |  79,237 |

Per turn, truncate-fix:

```
call      who  system   tools    task  history  results    total   fresh
   1   solver    1248     964     889        0        0     3101    3101
   2   solver    1248     964     889       16       30     3147     109
   3   solver    1248     964     889       43      333     3477     484
   4   solver    1248     964     889      351      550     4002     643
   5   solver    1248     964     889      384      716     4201     271
   6 reviewer     520       0     573        0        0     1093    1093
 sum             6760    4820    5018      794     1629    19021    5701
```

## What this shows

1. **Failures cost 15 times as much as fixes.** A model that never edits
   runs two full attempts of `maxTurns` (2 × 30 solver calls). It then gets a
   criteria call and the blind test writer. That comes to 63 calls and 290k
   input tokens, against 6 calls and 19k for a fix. The `noEdit` nudge in
   `lib/harness/recovery.ts` fires once, halfway through, but nothing stops
   the run. The batch figure of about 22 calls per issue fits a mix of quick
   fixes and a few runs that loop like this. Stopping the loop early is the
   biggest lever: an attempt with no source edit after N explore turns
   should end, or skip the second attempt.

2. **The fixed prefix dominates short runs.** The system prompt (1.25k) and
   the tool schemas (0.96k) go out on every solver call. In a 5-turn fix they
   make up **61%** of all input tokens (`system` + `tools`). The first user
   message (the issue plus localized context, about 0.9k to 1.2k) adds
   another 26 to 32%. The model's own history and the tool results are only
   13 to 18%. To make a fix cheaper, shrink the prefix: trim the tool schemas
   (every tool has a long description), or send a smaller tool set in
   fast mode.

3. **Transcript growth is linear and cache-friendly.** In the 60-call loop,
   each solver request grows by about 100 to 300 tokens. Only **6%** of all
   input is `fresh`, because the runner keeps the transcript append-only
   (`tests/harness.cache.test.ts`). With Anthropic prompt caching, the other
   94% is billed at about 0.1x. **OpenAI-compatible providers such as
   NVIDIA, Groq and DeepSeek have no cache the harness controls**, so they
   bill the full 290k. That is why the NVIDIA batch was expensive: every
   turn resends the whole conversation at full price.

4. **Tool results are the next biggest cost in long runs** (27% of the
   never-edits loop), because the model reads the same file again. The
   second and later reads of an unchanged file could return a short "unchanged
   since your last read (N lines)" stub.

5. **Side calls are cheap.** The reviewer (about 1.1k to 1.7k tokens, no
   tools), the criteria call (0.35k) and the blind writer (about 1.5k per
   call) each cost less than one solver turn.

## Budget regression tests

`tests/tokens.budget.test.ts` runs the same three scenarios. It fails when:

| constant                      | ceiling | measured |
|-------------------------------|--------:|---------:|
| `FIX_SMALL_MAX_INPUT`         |  21,000 |   19,001 |
| `FIX_LARGE_MAX_INPUT`         |  26,000 |   23,371 |
| `FIX_MAX_CALLS`               |       6 |        6 |
| `NEVER_EDITS_MAX_CALLS`       |      66 |       63 |
| `NEVER_EDITS_MAX_INPUT`       | 320,000 |  290,166 |
| `SOLVER_FIXED_MAX_PER_CALL`   |   2,450 |    2,212 |
| `NEVER_EDITS_MAX_FRESH_RATIO` |    0.08 |     0.06 |

The tests compare token counts, call counts and ratios only, never wall
clock time. The whole file runs in about 2 seconds. When an improvement
lands, such as an early stop for runs that never edit, smaller tool schemas
or deduplicated reads, re-run the bench and **tighten the matching
constant**, keeping about 10% headroom. That way the saving cannot quietly
come back.

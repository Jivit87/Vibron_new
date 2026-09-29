# Porting Pramana → Viberon

Pramana is the Python harness this port draws from (`pramana/**`). This file maps each of its
modules to the Viberon file that owns the same behaviour, and says how far each port has got.
It follows the TypeScript tree as of this commit. Several ports were running in parallel
branches when it was written, so a row marked **missing** or **planned** may already be in
progress somewhere else. When a port lands, change its row in the same commit.

Legend: **ported**: same behaviour, idiomatic TS · **partial**: the core works, and the named piece
is still missing · **missing**: not in Viberon yet · **n/a**: not needed in Viberon (the reason is
given).

No part of the port shells out to Python. Python only runs as the *target* repo's
test runner.

## Token, context and speed mechanisms (the user goal)

Target: a small project stays under **100k tokens** for a whole task, and responses come back quickly.

| Mechanism (Pramana source) | Status | Viberon owner |
|---|---|---|
| Append-only transcript so the provider prompt cache hits (`agent/loop.py`) | ported | `lib/agents/runner.ts` (messages are only appended; `compactIfNeeded` defers pruning until it frees enough to be worth a cache miss) |
| Cache breakpoints on the stable prefix (`llm/anthropic.py`) | ported | `lib/ai/anthropic.ts` (`withMessageCacheBreakpoint`, system `cache_control`) |
| Stale file views elided immediately after an edit (`agent/context.py` `_elide`) | ported | `lib/harness/compact.ts` `pruneTranscript` (`staleViews` marker) |
| Old tool output elided before summarizing (`context.compact`) | ported | `lib/harness/compact.ts` `elideOldToolResults`, `COMPACT_THRESHOLD`, `PRUNE_*` |
| One batch compaction past the threshold (`context.compact`) | ported | `lib/harness/compact.ts` `summarizeHistory` (cheap `summaryModel`) |
| `compact_hard` on context overflow | partial | overflow is detected in `lib/ai/retry.ts` `classifyProviderError`. `lib/agents/runner.ts` then retries in compact mode (`compactSystemPrompt`, reduced tool set). Pramana's forced hard compaction of the *transcript* has no dedicated path yet |
| `shrink_initial`: shorten the task when the window is too small | partial | `lib/agents/runner.ts` compact mode shrinks the system prompt and the tools, but not the task text |
| `strip_private`: drop reasoning the next call must not see | ported | `lib/harness/compact.ts` `withoutStaleThinking` |
| Issue condensed once at intake (long logs and package lists, `repo/issue.py` `condense`/`_elide_lines`) | ported | `lib/text/condense.ts` `condenseIssueText`, applied once in `lib/harness/solve.ts` to every model-facing copy of the task (solver, fast path, criteria, reviewer, test writer). Localization and triage keep the full text. `result.json` `metrics.issueChars` records before/after |
| Zero-token localization (`repo/localize.py`) | ported | `lib/localize/index.ts` (`extractSignals`, BM25, traceback paths, test imports, `lessons`) |
| Zero-token issue-snippet repro (`repo/snippets.py`) | ported | `lib/localize/snippets.ts` |
| Harness checkpoint: proof re-run with no model tokens (`agent/loop.py`) | ported | `lib/harness/solve.ts` `SolveController.harnessCheckpoint` |
| Head+tail truncation and condensing of failure output (`tools/shell.py` `truncate`/`clean_output`, `verify.summarize_output`) | ported | `lib/verify/extract.ts` `condenseOutput`, `lib/terminal/output.ts` `trimHeadTail`, `lib/harness/gate.ts` `summarizeOutput` |
| Capped, grouped search results (`tools/search.py`) | ported | `lib/search/index.ts`, `lib/tools/navigate.ts` |
| Graph retrieval and repeat-read dedupe (Viberon only, not in Pramana) | Viberon only | `lib/context/engine.ts`, `lib/context/ledger.ts`, `lib/retrieval.ts` |
| Token counting (`context.estimate_tokens`) | ported | `lib/tokens.ts`, `lib/harness/compact.ts` `estimateTokens` |
| Second attempt, test writer and reviewer run only when the evidence calls for them | ported | `lib/harness/solve.ts` (`maxAttempts`, `writerOn`, `reviewOn`, `overBudget`) |
| **One-call fast path**: edits plus a failing test in a single reply (`agent/fastpath.py` `FastPath`) | **missing** | planned. In Viberon, "fast path" today means `effort: "medium"` plus lazy evidence layers in `lib/harness/solve.ts`, and the single-agent route in `lib/agents/orchestrator.ts`. Neither is Pramana's one-call edits+test round |
| Zero-token triage small/medium/large (`orchestrator.triage`) | **missing** | planned, next to the fast path in `lib/harness/` |
| Near-miss SEARCH apply (≥ 90 % similar, one region) (`fastpath.near_miss_apply`) | partial | the tolerant `str_replace` in `lib/tools/editor.ts` (`similarity`, `reindent`, unique match) covers the agent loop. The fast-path SEARCH/REPLACE reply parser (`parse_reply`, `_path_above`, verbatim-duplicate dedupe) is missing |
| Cut-off reply → one "final answer now" call (`fastpath.py`) | **missing** | planned with the fast path |
| Per-endpoint shared rate limiter (`openai_compat._Throttle`, `throttle_for`) | **missing** | today each call retries with backoff on its own (`lib/ai/retry.ts` `runTurnWithRetry`). Planned: a limiter keyed by endpoint in `lib/ai/`, shared by parallel issue tasks (`lib/tasks/index.ts`) |
| Per-run token, call and time report | ported | `result.json.metrics` (`lib/headless/run.ts`), `lib/agents/runner.ts` `AgentRunMetrics`, token ledger UI |

## Module-by-module

### `pramana/agent/`

| Pramana | Mechanism | Status | Viberon |
|---|---|---|---|
| `loop.py` `Attempt` | tool loop, budget, repeated-call keys (`_call_key`) | ported | `lib/agents/runner.ts` `runAgent` + `lib/harness/solve.ts` `SolveController` |
| `loop.py` guards | repeats, failed edits on one file, oscillation, no progress, full-suite runs, `python -c` probes, budget low | ported | `lib/harness/recovery.ts` `TrajectoryGuards`, `classifyFailure`, `NUDGES` |
| `loop.py` harness checkpoint | proof re-run, "submit now" | ported | `lib/harness/solve.ts` `harnessCheckpoint` |
| `loop.py` `FatalModelError` | endpoint that stops answering ends the run cleanly | ported | `lib/ai/retry.ts` + `lib/agents/runner.ts` `friendlyProviderError` |
| `orchestrator.py` `Orchestrator` | attempts, fresh context and lessons, `pick_best` | ported | `lib/harness/solve.ts` `solveTask`, `lessonsFrom`, `pickBest` |
| `orchestrator.py` `triage` | size the issue with zero tokens | **missing** | planned `lib/harness/` |
| `orchestrator.py` `touches_code` | a docs/config/CI-only or empty patch is never "verified" | ported | `lib/harness/fastpath.ts` `touchesCode` (a non-test source file must change), applied to the final status in `lib/harness/solve.ts`: such a patch ends `incomplete`, with the reason in `gate.reason`. Test-only patches count as not touching code too |
| `orchestrator.py` `TrajectoryRecorder` | `trajectory.jsonl` | ported | `lib/headless/run.ts` |
| `fastpath.py` | one-call fix, `gather_files`, `parse_reply`, `near_miss_apply`, retry with reason, escalate with lessons | **missing** | planned `lib/harness/` (fast path) |
| `context.py` | estimate, elide, compact, compact_hard, shrink_initial, strip_private | ported / partial | `lib/harness/compact.ts`, `lib/agents/runner.ts` (see the table above) |
| `prompts.py` `build_initial` | initial task message, overview, localization, lessons | ported | `lib/harness/solve.ts` `initialMessage`, `lib/agents/roles.ts` (solver role) |
| `verify.py` `Gate` | every check on the original and patched code; fixed / regression / pre-existing | ported | `lib/harness/gate.ts` `Gate`, `classifyCheck`, `renderChecks` |
| `verify.py` `related_test_commands` | related tests the agent cannot skip | ported | `lib/verify/related.ts` `relatedTestFiles`, `lib/verify/detect.ts` |
| `verify.py` `shadowed_dependencies` | reject dependency stubs | ported | `lib/harness/gate.ts` `shadowedDependencies` |
| `testwriter.py` | blind independent test writer | ported | `lib/harness/testwriter.ts` |
| `events.py` | event bus | ported | `lib/agents/events.ts` |
| (reviewer in `orchestrator.py`) | predict the maintainer's test, check the diff | ported | `lib/harness/solve.ts` review pass, `lib/harness/criteria.ts`, `lib/review/` |

### `pramana/llm/`

| Pramana | Mechanism | Status | Viberon |
|---|---|---|---|
| `base.py` | errors, `ToolCall`, `Usage`, `parse_json_args` | ported | `lib/ai/types.ts`, `lib/ai/textproto.ts` `parseJsonArgs` |
| `openai_compat.py` | parameter negotiation, dropping and remembering unsupported params, `reasoning_content` passback, Azure | ported | `lib/ai/openai-compat.ts` `negotiateParams`, `lib/ai/openai-messages.ts` |
| `openai_compat.py` retries that perturb the request on 5xx | partial | `lib/ai/retry.ts` retries and classifies errors. The request perturbation is not ported |
| `openai_compat.py` `_Throttle` | shared per-endpoint limiter | **missing** | planned `lib/ai/` |
| `anthropic.py` | native tools, prompt caching | ported | `lib/ai/anthropic.ts` |
| `textproto.py` | text tool protocol, hallucination truncation, XML/Hermes/JSON recovery | ported | `lib/ai/textproto.ts` |
| `claude_cli.py` | dev backend via the signed-in CLI | ported | `lib/ai/claude-cli.ts` |
| `mock.py` | offline model | ported | `lib/client/mock-run.ts` and test doubles |
| `config.py` provider detection from the key prefix | ported | `lib/ai/provider-config.ts`, `lib/ai/credentials.ts`, `lib/ai/models.ts` |

### `pramana/tools/`

| Pramana | Mechanism | Status | Viberon |
|---|---|---|---|
| `editor.py` | tolerant unique matching, re-indent, pasted line numbers, lint gate, oscillation, CRLF/BOM | ported | `lib/tools/editor.ts` (`strReplace`, `reindent`, `syntaxError`, `checkEdit`, `splitStyle`) |
| `search.py` | rg, then git grep, then fallback; find files | ported | `lib/search/index.ts`, `lib/tools/navigate.ts` |
| `shell.py` | denylist, env scrub, repo venv, python shim, process group, timeout, head+tail | ported | `lib/terminal/safety.ts` (`classifyCommand`, `scrubEnv`), `lib/verify/env.ts`, `lib/terminal/index.ts`, `lib/terminal/output.ts` |
| `__init__.py` schemas, aliases, argument tolerance, `compare` | ported | `lib/tools/registry.ts` (`canonicalizeCall`, `compareTool`, `condense`) |

### `pramana/repo/`

| Pramana | Mechanism | Status | Viberon |
|---|---|---|---|
| `workspace.py` | repo overview, test detection, env probe | ported | `lib/verify/detect.ts`, `lib/workspace/index.ts`, graph L0 in `lib/context/engine.ts` |
| `git.py` `GitTracker` | original vs patched, patch isolation | ported | `lib/harness/snapshot.ts` (`snapshot`, `diff`, `withOriginal`, `restore`) |
| `symbols.py` | symbol index | ported (tree-sitter/graph) | `lib/lang/extract/index.ts`, `lib/graph.ts` |
| `localize.py` | identifier split, BM25, path match, test detection | ported | `lib/localize/index.ts` |
| `snippets.py` | issue code run on the original | ported | `lib/localize/snippets.ts` |
| `issue.py` fetch/parse | GitHub issue fetch, `owner/repo#N` | ported | `lib/issues/index.ts`, `lib/github-api.ts` |
| `issue.py` `condense` | long logs elided once at intake | **missing** | planned (see the token table) |
| `bootstrap.py` | target env bootstrap | ported | `lib/workspace/bootstrap.ts` |

### `pramana/report/`, `ui/`, `web/`, CLI

| Pramana | Status | Viberon |
|---|---|---|
| `report/evidence.py` bundle (`report.md`, `patch.diff`, `evidence.json`) | ported | `lib/headless/run.ts`, `lib/headless/report.ts`, `lib/deliver/report.ts` |
| `report/evidence.py` `write_index` (run history index) | partial | the tasks list (`lib/tasks/index.ts`). There is no static HTML index |
| `ui/live.py` terminal live view | n/a | the IDE's run panel (`components/`) |
| `web/server.py` Studio: batches, parallel issues, Stop | ported | `lib/tasks/index.ts` `TaskQueue`, `lib/issues/index.ts` `fixIssues`, `app/api/issues/**`, `app/api/tasks/**` |
| `web/github.py` fork, PR body, PR create | ported | `lib/deliver/index.ts`, `lib/deliver/report.ts` |
| `cli.py` run/solve | ported | `Makefile`, `cli/`, `lib/headless/run.ts` |
| `cli.py` `doctor` (connectivity + native-tools probe) | **missing** | no Makefile target yet. The model list comes from `app/api/models/route.ts` |
| `bench.py` | ported | `app/api/eval/route.ts`, `eval/` |

## What to port next (by token/speed payoff)

1. **One-call fast path + triage** (`fastpath.py`). Pramana measured 10/10 verified in 6 min 52 s
   with 54 calls, against 8/10 in about 11.5 min with about 204 calls on the full pipeline. Owner: `lib/harness/`.
2. ~~**Issue condense at intake**~~ (ported).
3. **Shared per-endpoint limiter** (`_Throttle`). Parallel issue tasks back off once per burst of 429s
   instead of each retrying on its own. Owner: `lib/ai/`.
4. ~~**`touches_code` guard**~~ (ported).

Measure every one of these before and after the change with the token benchmark (`scripts/bench-tokens.ts`, which a parallel branch is adding) and with `result.json.metrics`.

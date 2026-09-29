# Viberon architecture

Viberon is an autonomous coding harness wrapped in a desktop IDE. Given a repository and an issue, it finds the cause, changes the code, **proves** the change with the repository's own checks, and leaves an evidence bundle a reviewer can audit. The same engine powers three front ends: the interactive IDE (Next.js + Electron), the headless CLI (`viberon run`), and the eval runner (`viberon eval`).

The design rule is: **the model proposes, the harness decides, and tests judge.**

Every mechanism below is justified by what the top SWE-bench Verified systems actually do (§0), and ported from **Pramana**, our Python reference harness. Pramana is proven on SWE-bench Verified (11/19 with gpt-oss-120b) and on 4/4 hidden-test tasks across three model families. We ported its mechanisms (submit gate, tolerant editor, trajectory guards, environment handling, evidence bundle, bench tasks) to TypeScript rather than shelling out to it. Viberon adds a persistent multi-language code graph and graph-anchored memory, which Pramana does not have.

## 0. Evidence: what the SWE-bench Verified leaders do

Source: `github.com/SWE-bench/experiments`, 182 Verified submissions ranked by resolve rate. Decisions in §13 cite these rows as **E1–E7**.

| Rank | System | % | Mechanism that matters |
|---|---|---|---|
| 1 | Sonar Foundation Agent | 79.2 | Three tools only: `bash`, `str_replace_editor`, `find_symbols` |
| 3 | TRAE + Doubao | 78.8 | 70.6 single attempt → 78.8 with candidates + regression-test filtering |
| 4 | OpenHands | 77.6 | Phased prompt: explore → **reproduce** → fix → verify → review |
| 6 | Atlassian Rovo Dev | 76.8 | The run cannot end until the harness accepts; outlines with relevant sections expanded |
| 7 | EPAM | 76.8 | Retry only when the first attempt has no proof |
| 13 | JoyCode | 74.6 | Reproduction test first; **lessons from past traces** |
| 18 | Anthropic tools scaffold | 73.2 | `bash` plus `str_replace`, nothing else |

In order of return per token: **E1** few, well-built tools; **E2** reproduce first, prove after; **E3** the harness decides "done"; **E4** regression filtering with the repo's own tests; **E5** retry with a fresh context only without proof; **E6** structural views over raw reads; **E7** lessons persist. We deliberately skip 30-candidate sampling and multi-model voting: the brief scores efficiency with one fixed model.

## 1. Components

| Layer | Where | Job |
|---|---|---|
| Intake | `lib/workspace/clone.ts`, `app/api/clone`, `app/api/issue`, `lib/github.ts` | Turn a URL, `owner/repo` or GitHub issue into an indexed local workspace, plus the issue text |
| Environment | `lib/verify/env.ts`, `lib/workspace/bootstrap.ts`, `lib/terminal` | Venv activation, `python`→`python3` shim, no API keys in child processes, closed stdin, process groups, optional bootstrap (venv + `pip install -e .`, `npm ci`) |
| Code graph | `lib/parser.ts`, `lib/lang/extract`, `lib/workspace/graph-index.ts` | Symbols with line ranges plus import/call edges for JS/TS, Python, Go, Rust and Java; persistent and incremental |
| Localization | `lib/localize` | Zero-token fault localization: traceback frames, paths and symbols in the issue, BM25, test imports, the issue's own code run on the original tree, and past-fix lessons |
| Memory | `lib/memory/graph.ts`, `lib/memory/vault.ts` (+ legacy `lib/memory/index.ts`) | Notes and past fixes anchored to graph nodes with staleness detection, rendered as a two-way Obsidian vault |
| Context engine | `lib/context/engine.ts`, `lib/retrieval.ts`, `lib/context/ledger.ts` | Progressive disclosure: skeleton → symbol index → graph slice → file window, with dedupe accounting |
| Agent loop | `lib/agents/runner.ts`, `lib/tools/registry.ts`, `lib/ai/*` | A single strong tool-using loop with a lean solver tool set; providers are Anthropic, Groq and OpenAI-compatible |
| Harness control | `lib/harness/{solve,gate,recovery,snapshot}.ts` | Verification gate, recovery and stuck detection, checkpoints, and a second attempt |
| Verification | `lib/verify` | Detects and runs the repo's own checks, parses per-test outcomes, condenses output, classifies original-vs-patched evidence |
| Headless + evidence | `cli/`, `bin/viberon`, `lib/headless` | `result.json`, `trajectory.jsonl`, `patch.diff`, `report.md`, and exit codes |
| Eval | `eval/` | Hidden-test tasks, runner, scorer, `results.md`; served by `GET /api/eval` |
| Review | `lib/review`, `app/api/review` | review / describe / improve over a compressed diff, style learning from past PR comments; also the solve loop's final reviewer |
| Deliver + CI | `lib/deliver`, `lib/github-api.ts`, `app/api/{deliver,ci}` | Branch → commit → push → draft PR, report on the issue, CI status with Fix CI and evidence-backed flaky re-runs |
| Issues | `lib/issues`, `app/api/issues`, `instrumentation.ts` | The origin's GitHub issues → isolated fix → draft PR; auto mode polls a trigger label |
| Task queue | `lib/tasks`, `app/api/tasks` | FIFO per repo with traceable states; the UI, CLI and local API all enqueue here |

## 2. The loop (one task)

```
issue ──► intake ──► index graph (cached) ──► detect checks ──► baseline run (original code)
                                                        │
      ┌──── localize (0 tokens): traceback, BM25, issue snippet run on the ORIGINAL, lessons
      ▼
  solver loop: reproduce → read slices → edit (tolerant editor + lint gate)
      │           ▲                                    │
      │           └── recovery hint / forced replan ◄──┤ guards: repeats, failed edits,
      │                                                │ oscillation, no-progress, budget
      ▼
  model calls finish ──► GATE: each check on original AND patched code → verdict
      │   reject (new failures / nothing ran after last edit)  ──► back to loop
      │   2 regressions in a row ──► roll back to best checkpoint
      ▼
  accept → diff (excludes .viberon/) → evidence bundle → run memory
```

- **Localization costs no tokens** (`localize(root, task, graph, {runSnippets})`, E2/E6). Code the issue quotes is extracted (fenced blocks, doctest sessions, JS) and run from `.viberon/scratch/` on the untouched tree with a scrubbed env and a timeout. Its traceback is both a free reproduction and the strongest localization signal. Past `fix` notes anchored near the candidates come back as `lessons` (E7).
- **"Done" is decided by the harness, not the model** (E3). The gate reruns the detected checks after the last edit and compares per-test outcomes with the baseline. A test that passed before and fails now is a regression, and the finish is rejected with the failing test ids and a condensed excerpt. `accept_unverified` applies only when the repo has no runnable checks.
- **Budget exhaustion is not failure theatre.** When the budget runs out, the best checkpoint is restored and the run reports `incomplete`.
- **Second attempt.** A second attempt starts with a fresh context plus "lessons", and only when attempt 1 ends without proof. The best attempt is kept (Pramana orchestrator).

Statuses and exit codes: `resolved` or `unverified` → 0, `failed` or `incomplete` → 1, `error` → 2.

## 3. Graph engine

**Extraction.** JS/TS use Babel with error recovery. Python, Go, Rust and Java use dependency-free extractors in `lib/lang/extract`:

- **Python** is indentation-based. It handles multi-line signatures and ignores `def` inside docstrings.
- **Go, Rust and Java** use a brace matcher that is aware of strings, runes, comments and raw strings. It ignores braces inside parentheses, such as Go's `interface{}` parameters.

Each file becomes a `FileExtract` holding:

- nodes (name, kind, line range, signature, snippet);
- unresolved imports;
- unresolved calls attributed to the innermost enclosing symbol.

**Linking.** `linkGraph` resolves imports per language and turns calls into edges:

- **JS/TS:** relative paths and tsconfig `paths`.
- **Python:** relative dots, `src/` layout, and `from pkg import submodule`.
- **Go:** `go.mod` module paths, plus implicit same-package visibility.
- **Rust:** `crate::`, `self::`, `super::`, nested `use {…}`, and `mod x;`.
- **Java:** fully-qualified imports, `.*`, and same-package visibility.

**Persistence and incrementality.** Previously every write rescanned and re-parsed the whole repo twice.

- Extracts are cached per content hash in `<root>/.viberon/graph.json`, and `.viberon/` is added to `.git/info/exclude`.
- On open, only files whose hash changed are re-parsed.
- On write, only that one file is re-parsed and the graph is re-linked from the cache. Linking is pure and cheap, so edges *into* the rewritten file stay correct.
- `tests/ws.write-cost.test.ts` asserts that a write in a 41-file workspace parses exactly one file.

The scanner skips VCS, build, cache and dependency directories and any virtualenv (detected by `pyvenv.cfg`). It is capped at 20k files.

## 4. Graph-anchored memory and the Obsidian vault

Memory lives in `lib/memory/graph.ts`. Every entry (fact, decision, convention, suggestion, `fix`, hand-written `note`) and every summary is anchored to node ids or paths. Each anchor records the content hash of the node's snippet or the file at write time.

- **Staleness.** When the anchored code changes, the entry becomes `stale` and is rendered "(may be outdated)", so a belief about code that has since moved on never persists silently.
  - A node whose id changed only because lines shifted is re-found by file and name. Editing a *neighbouring* function therefore does not invalidate it.
  - Editing the function itself does.
- **API** (synchronous, because prompts are built synchronously):
  - `getMemoryGraph`, `addEntry`, `removeEntry`, `summaryFor`, `setSummary`, `relevantEntries`
  - `recordFixNote`, `relevantLessons`, `vaultGraph`, `renderAnchoredEntries`
- **Relevance ranking.** Exact anchor first, then same file, then same directory. Stale entries rank at half weight.
- **Fix notes** (E7). After a solve, `recordFixNote(root, {issue, rootCause, files, verified})` writes one `fix` note anchored to the changed files. `localize` returns the relevant ones as `lessons`, so the next task on the same area sees what was fixed, why, and whether it was proven.
- **Obsidian vault** (`lib/memory/vault.ts`). `memory.json` is canonical; every write re-renders `.viberon/vault/`:
  - `index.md`;
  - `notes/<slug>.md`, one per entry, with frontmatter `{id, kind, anchors, stale, created, updated}`, the text, and `[[code/<path>]]` / `[[notes/<slug>]]` wikilinks;
  - `code/<path>.md` stubs for anchored files only, listing their symbols and linking back to the notes.

  It is **two-way**: note mtimes are pinned to the entry's `updated` time, so a note edited in Obsidian (newer mtime) is imported on the next read, and a new `.md` under `notes/` becomes a `note` entry (its `[[code/…]]` links become anchors). Opening `.viberon/vault` in Obsidian shows the same graph the app shows.
- **Routes.** `GET /api/memory?repoKey=` adds `entries: {id, kind, text, anchors, stale}[]` and `vault: {path, notes}`; `GET /api/memory/graph?repoKey=` returns `{nodes: {id, kind: "note"|"code", label, stale?}[], links: {source, target}[]}` with vault-path ids.
- **Storage.** Memory is stored in `.viberon/memory.json`, which is git-excluded and never appears in a diff.
  - The older store-backed `ProjectMemory` (edited in the UI) keeps working.
  - Its learned entries are imported into the graph memory on reindex.

## 5. Context and token strategy

- **Progressive disclosure** (`lib/context/engine.ts`) runs cheapest first:

  | Level | Content | Size |
  |---|---|---|
  | L0 | skeleton | ~300 tokens |
  | L1 | symbol index | 1–3k tokens |
  | L2 | graph slice: BFS from seeds, signatures and bodies | 1–4k tokens |
  | L3 | explicit line window | on demand |

  The graph replaces whole-file reads, and graph summaries plus anchored memory let a symbol be understood without opening its file.
- **Ledger dedupe.** Re-requested content collapses to a pointer, and the savings are measured (`contextSavedTokens`).
- **Prompt caching.** The stable system prefix and memory carry Anthropic `cache_control` breakpoints. The cache hit rate is reported per run.
- **Compaction.** Past 60% of the window, old tool results are elided first; the middle is summarized only if that is not enough.
- **Stale-view elision and pruning** (`lib/harness/compact.ts` `pruneTranscript`). After an edit, any earlier view of that file becomes a one-line marker. Old write payloads become a stub that gives path, line count and sha. Pruning waits until it frees enough to be worth a prompt-cache miss.
- **Zero-token harness work.** Localization and the issue-snippet run (`lib/localize/`) and the harness checkpoint (`lib/harness/solve.ts` `harnessCheckpoint`) spend no model tokens.
- **Overflow fallback** (`lib/agents/runner.ts`). A provider that says "too large" gets a compact system prompt and a smaller tool set. Pramana's hard compaction of the transcript and its task shortening (`compact_hard`, `shrink_initial`) are only partly ported.
- **Fast path.** *Today*: the first attempt runs at `effort: "medium"`. The blind test writer, the reviewer and attempt 2 run only on evidence (`lib/harness/solve.ts`). The single-agent route in `lib/agents/orchestrator.ts` skips team planning. *Planned* (Pramana `agent/fastpath.py`):
  - zero-token triage;
  - a one-call round for small and medium issues that returns edits plus a test that fails on the original code, judged by the same gate;
  - a near-miss SEARCH apply;
  - a "final answer now" call when a reply is cut off;
  - escalation to the full loop that carries the lessons learned.
- **Issue condensed at intake** (`lib/text/condense.ts`, Pramana `repo/issue.py`). Long logs, package lists and deep tracebacks in the issue are cut to start and end once, before any model sees them. Localization still reads the full text.
- **`touches_code`.** A patch that changes no non-test source file (docs, config, CI or tests only) never ends `resolved`, whatever the checks say.
- **Planned token saver.** A limiter shared per endpoint for parallel issue tasks (Pramana `_Throttle`).

  The module-by-module status is in [`docs/PORT-AI-HARNESS.md`](docs/PORT-AI-HARNESS.md).
- **Output hygiene** (`lib/verify/extract.ts`).
  - Failing command output is condensed to its explanatory blocks, plus the summary tail, instead of a blind 40/60 cut:
    - Python tracebacks through the exception line;
    - pytest `E` lines;
    - unittest `FAIL:` blocks;
    - TAP YAML diagnostics;
    - go `--- FAIL`, rust panics, jest `●` blocks.
  - Passing output keeps a short head and tail.
  - `runCommand({condense: true})` applies this to agent commands.

## 6. Tools

The solver gets a lean set:

- graph search and symbol outline, which include cached summaries and relevant memory;
- file window reads;
- a tolerant `str_replace` editor:
  - line-number paste;
  - whitespace and indent tolerance, applied only when the match is unique;
  - the most similar region shown on a miss;
  - CRLF and BOM preserved;
  - a lint gate: py/json/js/ts/toml must still parse;
- `run_command` (condensed, in the repo environment);
- `compare`, which runs a command on the original and on the current code;
- `finish`.

Tool-name aliases and argument tolerance come from Pramana. Repository content is framed as **untrusted data**: repo rules are conventions, not instructions, and `.mcp.json` is not loaded headless.

## 7. Verification (`lib/verify`)

**Detection order** (`detectVerifyCommands`):

1. **Python.** Use pytest when it is importable by the repo's own Python, run with `-q -rA -p no:cacheprovider`. Otherwise use `unittest discover -v`; `-t .` is added only when the start dir is a package, because Python ≥3.12 rejects a non-package top dir.
2. **package.json test script.** The runner comes from the lockfile (npm, pnpm or yarn). The framework comes from the script and dependencies (vitest, jest or `node --test`). A bare `*.test.js` repo gets `node --test`.
3. `go test -json ./...` and `cargo test`.
4. `mvn` / `gradle`.
5. `make test`.
6. **Fallbacks:** `tsc --noEmit`, a Python syntax check that writes no `.pyc`, `go build`, `cargo check`.

Tools that are not installed are skipped.

**Running.** `runVerification` runs the command with `bash -c` (non-login, so PATH order is ours) and the repo environment:

- venv first on PATH;
- a `python` shim when only `python3` exists;
- `PYTHONPATH` = repo (+`src/`);
- `PYTHONDONTWRITEBYTECODE`;
- scrubbed secrets.

Stdin is closed, the command runs in its own process group, the whole group is killed on timeout or abort, and capture is capped at 4 MB head+tail.

**Parsing.** Per-framework parsers turn output into `tests: Record<id, pass|fail|error|skip>` plus the runner's own totals:

- pytest `-rA`/`-v`, including collection errors;
- unittest `-v` in both 3.11+ and legacy formats;
- go `-json` and text;
- cargo;
- node TAP with nested suites, and the spec reporter;
- vitest and jest.

A non-zero exit with nothing attributable counts as an error, so a crash can never look green.

`relatedTestFiles` ranks tests for targeted runs. It uses name conventions, graph edges from test symbols into changed symbols, and import mentions.

**Evidence** (`runOnOriginalAndPatched(root, baseRef, command, {withOriginal, role})`, E2/E4). One check runs on the patched tree and, through an injected `withOriginal` (the harness snapshotter), on the original code, and the pair is classified:

| Original → patched | Verdict |
|---|---|
| fail → pass | `fixes` (the proof we want) |
| pass → pass | `passes` (no regression, not proof) |
| pass → fail, or any single test pass → fail | `regression` |
| fail → fail, agent's reproduction | `still_failing` |
| fail → fail, suite / related test | `pre_existing` |

## 8. Recovery

A regex table classifies failures: patch conflict, missing file, command not found, test failure, regression, timeout, schema error.

Stuck detection fires on any of:

- the same call 3 times in the last 8;
- the same error twice;
- 12 turns without an edit;
- oscillating edits.

The first stuck event appends a class-specific hint to the tool result. The second forces a replan. Two consecutive regressions roll back to the best checkpoint.

Checkpoints are git tree snapshots taken with a temporary index, or a shadow git dir for non-git repos, so the user's index and branches are never touched.

## 9. Providers

- Anthropic (with prompt caching) and Groq.
- An OpenAI-compatible adapter using `fetch`. It covers OpenAI, Gemini's compatibility endpoint, OpenRouter, vLLM and Ollama, configured by:
  - `VIBERON_OPENAI_BASE_URL`, `OPENAI_API_KEY`;
  - `VIBERON_MODEL=openai:<id>`, `VIBERON_CONTEXT_WINDOW`.
- The provider is detected from the key prefix.
- A text tool protocol fallback (XML / invoke / Hermes / JSON recovery) serves models without native tool calls.
- Parameters a provider rejects are remembered and dropped, and retries perturb the request.

## 10. Headless and evidence

Run a task with:

```
viberon run --repo <path> --task "<text|issue url>" [--worktree] [--out dir] [--test-cmd cmd] [--no-gate] [--max-turns n] [--timeout s] [--model id] [--json]
```

- **Launcher.** `bin/viberon` runs `tsx` with the repo's tsconfig from any cwd. `cli/main.ts` sets `VIBERON_STORE=memory` before any store module loads, so there is no dev-store file in the cwd and no Firestore.
- **`--worktree`** runs in a detached `git worktree` of HEAD. The original checkout is untouched and `patch.diff` applies to it cleanly.
- **Bundle.** The default location is `<repo>/.viberon/runs/<task-id>/`, which is git-excluded. It contains:

  | File | Contents |
  |---|---|
  | `result.json` | `SolveResult` + `schemaVersion`, `taskId`, `exitCode`, `repo`, `workRoot`, `model`, `task`, `verifyCommands` |
  | `trajectory.jsonl` | `{type:"meta"}`, then one `{type:"event", t, event}` per orchestration event, then `{type:"result"}` |
  | `patch.diff` | the change, git-apply-able |
  | `report.md` | verdict, cost, a baseline-vs-final evidence table, fixed and regressed tests, failure excerpt, recovery counters, tool usage, diffstat and diff (Pramana `report/evidence.py` style) |

- **Clone.** `viberon clone <url|owner/repo|issue-url> [--setup]` is the CLI form of `POST /api/clone`.

## 11. Efficiency metrics (per run, in `result.json.metrics`)

| Group | Metrics |
|---|---|
| Model usage | `modelCalls`, `toolCalls`, `toolCallsByName` |
| Tokens | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRate` |
| Cost | `costUsd` vs `uncachedCostUsd` |
| Context | `contextSentTokens` vs `contextSavedTokens` (graph retrieval + dedupe), `compactions` |
| Time | `verifyRuns`, `verifyMs`, `durationMs` |

The eval table aggregates pass rate, regressions, tokens, calls and time.

## 12. Evaluation

Tasks live in `eval/tasks/<name>/{repo/, issue.md, hidden_tests/, task.json}`:

| Task | Source | Tests |
|---|---|---|
| `config-merge`, `todo-json`, `semver-js`, `slugify` | Pramana's four bench tasks | hidden tests |
| `inventory-stacktrace` | Viberon | Python/unittest, stacktrace bug |
| `truncate-regression` | Viberon | JS/`node --test` regression trap: the naive fix breaks word-boundary behaviour covered only by the hidden tests |

The runner (`eval/run.ts`) works in four steps:

1. Copy the repo to a temp dir, then `git init` and commit.
2. Give Python tasks a shared cached venv with pytest, symlinked as `.venv`.
3. Run the **same** `runHeadless` path the CLI uses.
4. Copy the hidden tests in and run `test_cmd`.

A task is resolved **only if the hidden tests pass**. The table also reports "honest verdicts", meaning the harness's own claim matched the hidden tests.

Output goes to `eval/results/latest.json` and `results.md`, served by `GET /api/eval`.

## 12a. Ship loop: review, deliver, CI

A resolved fix can continue to a pull request: **solve → review → deliver → report → watch CI**. Every step that leaves the machine needs an explicit action (a click, `--deliver`, or `POST /api/tasks {deliver:true}`).

- **Review** (from PR-Agent). The diff is parsed and delete-only hunks are dropped. Hunks get line numbers so findings can cite them. Files are packed to a token budget, and whatever did not fit is listed rather than dropped silently.
  - `reviewDiff`, `describeDiff` and `improveDiff` make one structured call each, with one repair retry.
  - `improveDiff` adds a second, self-reflection call that scores every suggestion 0–10. A suggestion whose `existing` code is not in the diff is discarded before scoring.
  - Inside `solveTask`, an accepted fix is reviewed once. A `high` finding buys one extra pass, which is kept only if it still has strong evidence.
- **Review target.** `lib/review/target.ts` is the only definition. `working` and `{base}` include untracked files, because new files are most of a change.
- **Style learning** (from Open SWE's analyzer). Recent PR review comments become at most 8 `convention` notes in the vault, anchored to real paths; later reviews of those files include them.
- **Deliver** (from Open SWE and Jiffy).
  - The branch is `viberon/<slug>`, deduped against local and remote branches.
  - It refuses changes outside the fix's files, and changes to `.github/workflows/**` unless confirmed.
  - The token reaches git only through `http.extraheader` for github.com, and is redacted from any output.
  - An open PR is updated rather than duplicated. A failed push keeps the local branch and commit.
- **CI** (from Open SWE `/baby-sit`). Failed Actions jobs get their logs condensed by `lib/verify`'s failure extraction. **Fix CI** enqueues a fix task seeded with those failures. **Re-run** needs a written reason and is capped at 3 per head sha.
- **Queue** (from Jiffy). One running task per repo; tasks are persisted, and `running` becomes `failed (interrupted)` after a restart. Late subscribers get a replay of the task's events, then the live tail.

## 12b. Issues → fix → pull request

The top of the pipeline (`docs/PLAN-ISSUES.md`): **list issues → enqueue → isolated worktree → solve → deliver → report**.

- **Input:** an issue's title, body and up to 20 comments become the solver's task, inside an explicit untrusted `<issue>` frame.
- **Isolation:** every issue is fixed in a fresh detached worktree of `origin/<default>`, so one PR carries exactly one fix. The user's checkout, and any uncommitted work in it, is never touched. The worktree is removed afterwards, and the delivered branch stays.
- **Output:** only a `resolved` fix is delivered. The PR is titled "Fix #N: …", its body ends "Fixes owner/repo#N" so merging closes the issue, and the evidence is posted on the issue.
- **Auto mode:**
  - A single in-process poller, started from `instrumentation.ts` so it survives restarts, checks watched repos for open issues carrying a trigger label.
  - Only people with triage rights can label an issue, so the label is the maintainer's approval.
  - Issues already queued, delivered or closed are never re-queued.
- **Remote identity:** `configuredRemoteUrl()` reads `remote.origin.url`, not `get-url`, so `url.*.insteadOf` rewrites cannot make a GitHub repo unrecognisable.

## 13. Decisions and why

- **Single agent loop headless, with a lean tool set (E1).** The winners use two or three tools; the brief rewards correctness and efficiency. A strong single loop with an external gate is easier to make reliable and to explain. Multi-agent orchestration remains an IDE feature.
- **The harness decides "done" (E3), with the repo's own tests (E4).** The gate compares per-test outcomes on the original and patched code, not "exit code 0". Many real repos have pre-existing failures: requiring green would reject correct fixes, and ignoring tests would accept regressions.
- **Reproduce before editing, for free (E2).** Running the issue's own code on the original tree costs zero model tokens and hands the model a failing reproduction plus a traceback to localize from.
- **A second attempt only without proof (E5).** It starts from a fresh context plus lessons, and the attempt with the best evidence is kept.
- **Lessons persist, as notes a human can read and fix (E7).** Fix notes anchored to code, surfaced by `localize`, and editable in Obsidian: a wrong lesson is corrected in the vault, not by clearing memory.
- **Structural views over raw reads (E6).** Graph slices, outlines and cached summaries replace whole-file reads.
- **Regex/indent extractors instead of tree-sitter.** No native modules means nothing to compile for Electron or per platform. The graph needs line ranges and edges, not a full AST. Babel is kept for JS/TS, where it is already a dependency.
- **Extract/link split with a hash-keyed cache.** Parsing is the only expensive step. Caching it per file makes open O(changed files) and writes O(1 file), while re-linking keeps cross-file edges exact.
- **Memory anchored to code hashes.** Unanchored memory rots: agents confidently repeat facts about code that changed. Anchors make staleness mechanical and visible.
- **`.viberon/` for all harness state, excluded from git.** Evidence, graph, memory and the vault never pollute the patch under review.
- **`bash -c` with an explicit env for verification.** A login shell's profile can reorder PATH and pick the system Python over the repo venv. Verification must be deterministic.
- **Condense, don't truncate.** The traceback is usually in the middle of the log, and a blind head/tail cut drops exactly the line the model needs.
- **Ship-loop mechanisms, not platforms.** From Open SWE and Jiffy we took the deliver loop, the CI watch, the queue and branch naming. We did not take LangGraph, cloud sandboxes, Django, Celery or webhooks. A local desktop app cannot receive webhooks, and git worktrees already isolate runs.
- **One review call per tool, plus reflection (PR-Agent).** It is cheap enough to run on every accepted fix. The grounding check stops the classic failure of suggestions that edit code that does not exist.
- **Hidden tests decide eval results.** They are the judging setup of Round 1. Our own gate verdict is reported alongside, so over-claiming is visible.

## 14. Limits

- The regex extractors can miss exotic syntax: Python decorators spanning lines before `def` are not part of the range, and Java generics-heavy method headers may be skipped. Symbols are still found by text search.
- The bootstrap is best effort. A repo whose dependencies need system packages may still have no runnable tests, and then the run can end `unverified` at best.
- `--worktree` checks out HEAD, so uncommitted changes in the source checkout are not included.
- Task event buffers live in memory: after a restart a finished task keeps its state and result, but its event stream is not replayed.
- Delivery, issue comments and CI support GitHub only.

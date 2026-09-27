# Viberon build log

What is being built, where each piece comes from, and its current status. Updated at every merge.

Status: **built** = merged on main with tests green · **in progress** = an agent is building it · **planned** = specified, not started · **rejected** = evaluated and deliberately not taken.

## Sources studied

| Source | What it is | What we took |
|---|---|---|
| [github/github-mcp-server](https://github.com/github/github-mcp-server) | GitHub's official MCP server (Go) | Connected as a preset (hosted, Docker or binary), not vendored |
| [SWE-bench/experiments](https://github.com/SWE-bench/experiments) | Results and write-ups of 182 SWE-bench Verified systems | The design principles of the solve loop (table in `docs/PLAN-SOLVE.md`) |
| `Harness Hackathon/pramana` (local) | Our Python harness, proven on SWE-bench Verified | Mechanisms ported to TypeScript: submit gate, tolerant editor, guards, localization, two-attempt orchestration |
| [The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent) | Single-call PR review tools | review, describe and improve; diff compression; self-reflection scoring |
| [langchain-ai/open-swe](https://github.com/langchain-ai/open-swe) | Cloud "software factory" | The deliver loop (commit → PR), thread = branch, `/baby-sit` CI watch, review-style analyzer |
| [Jiffy-Agnet/gateway](https://github.com/Jiffy-Agnet/gateway) | Self-hosted issue → PR gateway | Task queue with states, branch naming, report comment on the issue, local task API |

## Components

### Integrations
| Component | Source | Files | Status |
|---|---|---|---|
| GitHub MCP preset (hosted/Docker/binary, verified token, toolsets, read-only, trust) | github-mcp-server | `lib/mcp/github*.ts`, `app/api/mcp/github`, `components/vibe/GithubMcpSettings.tsx` | **built**, live-tested (26 tools, `get_me` OK) |
| Stored GitHub token reused for clone and issue lookups (PR and CI in wave 2) | new wiring | `resolveGithubToken()` in `lib/github.ts`, `gitAuthEnv()` | **built** |

### Solve loop (wave 1, `docs/PLAN-SOLVE.md`)
| Component | Source | Files | Status |
|---|---|---|---|
| Git snapshots, `withOriginal` | Pramana `repo/git.py` | `lib/harness/snapshot.ts` | **built** (A, 0843c9d) |
| Tolerant str_replace editor + lint gate + oscillation | Pramana `tools/editor.py`; SWE-bench: Sonar, Anthropic | `lib/tools/editor.ts` | **built** (A, 0843c9d) |
| `compare` / `finish` tools; the harness decides "done" | Pramana `verify.py`; SWE-bench: Rovo Dev status tool | `lib/tools`, `lib/harness/gate.ts` | **built** (A, 0843c9d) |
| Loop guards (stuck, oscillation, budget) | Pramana `agent/loop.py` | `lib/harness/recovery.ts` | **built** (A, 0843c9d) |
| 7-tool solver, reproduce-first prompt, outline view | SWE-bench: OpenHands, Sonar, Rovo Dev | `lib/agents/roles.ts` | **built** (A, 0843c9d) |
| `solveTask`: 2 attempts, lessons, evidence-based selection | Pramana `orchestrator.py`; SWE-bench: EPAM, Rovo refine | `lib/harness/solve.ts` | **built** (A, 0843c9d) |
| Test detection, runners, parsers, failure extraction | Pramana `workspace.py`, `shell.py` | `lib/verify` | **built** (B) |
| Python in the code graph | new | `lib/lang`, `lib/parser.ts` | **built** (B) |
| Zero-token localization + issue snippets | Pramana `localize.py`, `snippets.py` | `lib/localize` | **built** (B) |
| Memory as a two-way Obsidian vault | new (Obsidian format) | `lib/memory`, `.viberon/vault/` | **built** (B) |
| Clone, issue and eval APIs; headless CLI; eval tasks | Pramana `bench/`, `cli.py` | `app/api/{clone,issue,eval}`, `cli/`, `eval/` | **built** (B) |
| Memory graph overlay, backlinks, Open in Obsidian, evidence tables | new | `components/**` | **built** (FE) |

### Ship loop (wave 2, `docs/PLAN-DELIVER.md`)
| Component | Source | Status |
|---|---|---|
| `review` / `describe` / `improve` + diff compression + self-reflection | PR-Agent | **built** (A) |
| Final reviewer inside the solve loop | Pramana layer 5 + PR-Agent review | **built** (A) |
| Deliver: branch → commit → push → draft PR; issue report comment | Open SWE, Jiffy | **built** (B) |
| CI watch: Fix CI / evidence-backed flaky re-run (max 3 per sha) | Open SWE `/baby-sit` | **built** (B) |
| Task queue with states + local `POST /api/tasks` | Jiffy | **built** (B) |
| Review-style learning → convention notes in the vault | Open SWE analyzer | **built** (A) |
| SCM review UI, Deliver bar, Tasks panel, CI strip | new | **built** (FE) |

### Rejected
| Idea | From | Why not |
|---|---|---|
| 30-candidate sampling + multi-model voting | TRAE, ACoder | The hackathon scores efficiency with one model; two evidence-ranked attempts get most of the gain |
| Cloud sandboxes, LangGraph, Slack/Linear | Open SWE | Viberon is local and single-user; git worktrees give isolation |
| Django/Celery/Redis, webhook edge Actions | Jiffy | A desktop app cannot receive webhooks; an in-process queue is enough |
| GitLab/Bitbucket/Azure providers, labels, changelog tools | PR-Agent | No user for them; they would be untested code |
| Shelling out to Pramana | — | One runtime (TypeScript); mechanisms are ported and tested |
| Old `wip/*` branches | earlier stopped agents | Superseded by main; left untouched pending the owner's decision |

## Change log
- **2026-09-26:**
  - GitHub MCP integration merged; round-3 FE merged.
  - Round 4 plan written from the SWE-bench evidence.
  - Wave 1 started (A, B, FE).
  - Wave 2 specified from PR-Agent, Open SWE and Jiffy.
- **2026-09-26 23:50:** Executor A round 4 merged (7-tool solver, gate, snapshots, localize event, attempt-2 rationale); 498 tests pass. FE round 4 (a213c79) and Executor B pending merge.
- **2026-09-27:**
  - Executor B merged. It builds on the other session's EXEC-B round 3 (`f93c179`: verify, multi-language graph, clone, CLI, eval) and adds the Obsidian vault, `lib/localize`, fix notes and the token reuse.
  - FE round 4 merged.
  - Integration fixes:
    - `solveTask` uses the real `lib/localize`, so the prompt gets snippet runs and past-fix lessons;
    - the Fix route writes fix notes to the vault;
    - one verdict system (the gate's `classifyCheck`), with the duplicate `lib/verify/evidence.ts` removed;
    - one `SettingRow`/`Switch` and one Integrations section.
  - Bugs found by a live headless run, and fixed:
    - the Python syntax-check fallback never ran because of shell quoting;
    - a missing API key produced two wasted attempts and "failed" instead of a setup error (exit 2).
  - Checks: `tsc` clean, `eslint .` clean (the lint config now ignores agent worktrees and eval fixture repos), 579 tests pass, `next build` green.
  - Not yet run end to end with a real model: no provider key is configured on this machine.
- **2026-09-27:** Shared GitHub REST client (`lib/github-api.ts`) on main. Wave 2 started: A review tools, B deliver/tasks/CI, FE review/deliver UI.
- **2026-09-27:** Wave-2 A merged: `lib/review` (compressDiff, reviewDiff/describeDiff/improveDiff with self-reflection and grounding checks, learnReviewStyle writing convention notes to the vault), `POST /api/review`, and the solve-loop reviewer (one extra pass on a high finding, kept only with strong evidence). Planner fix: the working-tree review now includes untracked files. 607 tests pass.
- **2026-09-27:** Wave-2 B merged: `lib/deliver` (branch, commit, push, PR with refusal rules), `reportOnIssue`, `ciStatus`, `ciFixTask`, `rerunFlaky` (max 3 per sha), `lib/tasks` queue plus routes, and CLI `--deliver`/`--review`/`viberon review`. B also fixed `lib/github-api.ts` crashing on empty 2xx bodies (job re-run). Planner consolidation: one review-target module shared by the route, tasks and the CLI. ARCHITECTURE.md gains §12a (ship loop). 636 tests pass; clean-checkout tsc and next build are green.
- **2026-09-27:** Wave-2 FE merged: SCM review/describe/improve (apply with staleness check), findings in DiffView, Deliver bar (workflow re-confirm, CI strip, Fix CI, re-run with a reason), Tasks panel attaching live runs, palette commands for PR review and style learning, quiet toolset checkboxes. A contract audit found 3 real UI↔server bugs, all fixed with `tests/contract.deliver.test.ts`: the outside-files refusal was never sent, the workflow confirm looped, and issue comments always 400ed. 665 tests pass; clean-checkout tsc and next build are green.
- **2026-09-27:** Merged the other session's engine branch (62f3aa4). It fixes a real bug: when the model hit its output cap mid tool call, the SDK dropped the unfinished string and `write_file` wrote an empty file while reporting success. Now:
  - a call cut off at the cap is retried once at the model's ceiling; if it is still cut off, it is dropped with a "write it in parts" hint, and cut-off text is continued up to 3 times;
  - new `append_file` and `multi_edit` (atomic, through the same lint gate) for the interactive roles only; the solver keeps its 7 tools;
  - old write payloads are pruned from context, and the latest gate verdict and finish input are protected;
  - Claude's default output cap is raised to 64k (streamed).
  Verified on merge: 681 tests pass, lint is clean, and clean-checkout tsc and next build are green.
- **2026-09-27:** Merged `nvidia-provider` (89c39ee, other session):
  - NVIDIA as a provider (Settings slot, key verification, 5 catalog models with the `nvidia:` prefix, routing to integrate.api.nvidia.com);
  - fixed the OpenAI-compatible Settings row, which could never be saved;
  - headless default model is now "auto".
  Planner additions: a test that an NVIDIA-only setup passes the solve preflight and that review picks an NVIDIA model; the flaky three-solve reviewer test gets a 20s timeout. 689 tests pass; clean-checkout tsc and build are green.
- **2026-09-27:** Merged `nvidia-live-catalog` (aa3fe97, other session). It was an urgent fix: all 5 curated NVIDIA models were dead for the user (410 Gone, or missing from the account catalog), so every run 404ed.
  - The live `/v1/models` catalog is now cached for 1h.
  - The curated list is replaced by models verified live to return tool calls (default: nemotron-3-ultra-550b).
  - 404/410 models are remembered and runs fall back automatically, at most 3 hops.
  - `auto` prefers Anthropic > NVIDIA > OpenAI-compatible > Groq.
  Planner checked: the fallback reports the model that actually answered, and its cost. 693 tests pass; tsc and eslint are clean.
- **2026-09-27:** Merged `gemini-provider` (0d336c3, other session): Google Gemini driven by the key's live model list. Planner fix: a daily-quota `ModelUnavailableError` keeps HTTP 429 and was retried with backoff sleeps before falling back; it is now fatal for that model, so the fallback is immediate. That also fixed a random 5s test timeout. 701 tests pass; clean build is green.
- **2026-09-27:** GitHub issues → fix → PR, requested by the user.
  - `lib/issues` lists issues, builds the task text (untrusted frame, 20 comments) and enqueues without duplicates.
  - Each fix runs in a fresh worktree of origin/<default> (one fix per PR; the user checkout is untouched).
  - The PR title is "Fix #N", the body says "Fixes owner/repo#N", and the evidence is commented on the issue.
  - Auto mode: a label-triggered poller (the label is the trust gate), started by `instrumentation.ts`.
  - Routes `/api/issues`, `/api/issues/fix`, `/api/issues/watch`; CLI `viberon issues`.
  - Found while testing: `git remote get-url` expands insteadOf and misreads the GitHub repo, so one `configuredRemoteUrl()` now serves deliver, issues and review. Rate-limit errors now suggest adding a token.
  - Verified: live listing of github/github-mcp-server issues; the offline end-to-end test (worktree, push, PR, comment, user checkout untouched) and the watcher test. 705 tests pass.
- **2026-09-27:** Issues panel merged: table with status, per-row and bulk "Fix → PR", an auto-fix row, live-run attach, and a palette command. Planner:
  - `no_token` error code, plus `tests/contract.issues.test.ts`;
  - suite `testTimeout` 30s: real-process tests flaked at 5s under load average 200+ caused by other sessions' browsers;
  - the clean build caught `instrumentation.ts` dragging Firestore into the edge bundle, fixed with Next's documented Node-only import.
  715 tests pass; tsc and eslint are clean; clean-checkout next build is green.
- **2026-09-27:** Merged `gemini-thought-signatures` (b3611c5, other session). It fixes the user's Gemini 400 "missing thought_signature": Gemini 3 tool calls carry a signature that must be echoed back, and the OpenAI-compatible adapter now sends it, only to Gemini. A free-tier `limit: 0` 429 now counts as unavailable, so auto falls to Flash at once. Planner checked that the Anthropic adapter maps tool_use field by field (no leak). 717 tests pass; clean build is green.
- **2026-09-27:** Round 5 started (`docs/PLAN-ROUND5.md`).
  - Gap audit against Pramana, in code: already ported are the gate, editor, guards, checkpoint, localization, snippets, two attempts, text protocol, reasoning pass-back, perturbing retries, and stub/test-edit rejection.
  - Missing, now being built:
    - acceptance criteria, the blind independent test writer, and the Pramana reviewer framing (A);
    - the Claude CLI provider, so real runs work without an API key; DeepSeek; a SWE-bench Verified runner; issue intake formats (B).
  - Weak points being fixed: parallel setup and gate, per-phase timing, prompt-cache prefix stability (A); cached check detection (B); the UI for criteria, the independent test and a phase timing strip (FE).

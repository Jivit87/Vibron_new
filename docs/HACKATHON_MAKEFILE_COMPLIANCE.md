# Makefile spec compliance

How Vibron (Viberon) meets each section of the organizer's "AI Harness Hackathon 2026: Standardised Makefile-Based Evaluation Setup" ([HACKATHON_MAKEFILE_SPEC.md](HACKATHON_MAKEFILE_SPEC.md)).

Every entry was checked against the repository at commit `738a313` (branch `hackathon-spec-doc`) on 2026-09-27. The checks were file reads, `git grep` and `git log` scans, `make -n` dry runs, and live runs of `make setup`, `make test` and a headless `make run`. The commands are listed at the end. Line numbers refer to that commit.

**Status key:** PASS means the requirement is met. GAP means there is a real shortfall, listed under [Gaps](#gaps). N/A means the section does not apply to this architecture.

## Summary

| § | Requirement | Status | Key evidence |
|---|---|---|---|
| 1 | Mandatory Makefile with `setup`, `run`, `test` (`clean` where applicable) | PASS | `Makefile:41-68`; `make setup` and `make test` run green |
| 2 | Credential read from `AI_API_KEY`, never hard-coded | PASS | `lib/ai/credentials.ts:44-59`, `lib/ai/provider-config.ts:60-80,105`; no recipe line references the key |
| 3 | Text-only model; no image, audio or video input required | PASS | Headless path takes text only; `images` is never set on the run/eval path |
| 4 | Model configuration clearly defined; no model substitution | **GAP** | Defaults declared, but side calls and fallbacks can use another model (G1 to G4) |
| 5 | Standard 5-step evaluation procedure | PASS | export, `make setup`, `make run`, then issue via the web IDE or `TASK` |
| 6 | TUI launched through `make run` | N/A | Vibron ships a web IDE, a desktop app and a headless CLI, not a TUI. Both modes start from `make run` |
| 7 | Works in the prescribed evaluation environment | PASS | Model, endpoint and key all come from env; the repo's test command is auto-detected |
| 8 | Credential security, `.env.example` only | PASS | `.env.example` is empty; `.env*` is ignored; secret scan finds test fixtures only |
| 9 | Environment independence, dependencies declared | **GAP** | Node runtime is not declared or pinned (G5); README omits `make` and `AI_API_KEY` (G6) |
| 10 | Reproducible execution, settings documented or controlled | PASS | Temperature 0 by default; budgets fixed; lockfile frozen. One note (G8) |
| 11 | Runs without the evaluators modifying the code | PASS | No source edit needed; configuration comes from env only |
| 12 | Standard evaluator workflow | PASS | `git clone` → `export AI_API_KEY` → `make setup` → `make run` |
| 13 | Final submission checklist | PASS (local) | Required layout present; setup and test verified locally. A clean-container run is still open |
| 14 | "Important": setup and launch with no manual configuration | PASS | Same evidence as §1, §2, §11 and §12 |

**Result: 11 PASS, 1 N/A, 2 sections with gaps (§4 and §9).** There are 8 gap items in total (2 medium, 6 low) and 1 open verification item. None of them blocks `export AI_API_KEY` → `make setup` → `make run`.

---

## Section by section

### 1. Mandatory Makefile: PASS

**Requirement:** a root `Makefile` exposing `make setup`, `make run` and `make test`, plus `make clean` where applicable. At minimum, `setup` and `run` must work.

**Evidence:**
- `Makefile` is at the repository root. `.PHONY: setup run test eval clean` is at line 41.
- `setup` (lines 43-46) enables pnpm through corepack if it is missing (`command -v pnpm … || corepack enable`), then runs `pnpm install --frozen-lockfile`. **Verified:** it completed in 7.8 s ("Done in 7.8s using pnpm v10.24.0").
- `run` (lines 48-56) has two modes:
  - With no `TASK`/`ISSUE` set, it runs `pnpm dev`, which serves the interactive app on `http://localhost:3000`.
  - With `TASK` (or `ISSUE`) exported, it runs `bin/viberon run --repo "${REPO:-.}" --task "…" --json`, a headless SWE-bench-style run.
  - **Verified:** a headless run against a scratch repo started, reached the credential check and printed a structured `result.json`.
- `test` (lines 58-60) runs `pnpm test` (`vitest run`, `package.json:19`). **Verified with no credentials in the environment:** "Test Files 99 passed (99) · Tests 958 passed | 1 skipped (959)", 50.65 s.
- `clean` (lines 66-68) runs `rm -rf .next dist tsconfig.tsbuildinfo eval/results`.
- `eval` (lines 62-64) runs `bin/viberon eval`. The spec does not require it, and the Makefile header (line 5) labels it a bonus.

### 2. API key configuration: PASS

**Requirement:** read the credential from `AI_API_KEY`, and never hard-code keys, tokens or secrets in source, the Makefile, `.env` files, docs or committed config.

**Evidence:**
- **Sole required credential.** `genericEnvKey()` in `lib/ai/credentials.ts:44-59` reads `process.env.AI_API_KEY` and routes it to a provider by its prefix. It uses `detectProvider()` and the prefix table in `lib/ai/provider-config.ts:60-80`: `sk-ant-` → Anthropic, `sk-or-` → OpenRouter, `AIza` → Gemini, `gsk_` → Groq, `xai-`, `nvapi-`, `csk-`, `hf_`, `fw_`, `tgp_`, and `sk-` → OpenAI.
  - The OpenAI-compatible adapter reads the same variable at `provider-config.ts:105`.
  - The optional `AI_BASE_URL`, `AI_MODEL` and `AI_PROVIDER` variables (lines 106-108) choose the endpoint and model without any source change.
- **Makefile never handles the key.** `grep -n AI_API_KEY Makefile` matches only comment lines 21 and 24. No recipe expands `$(AI_API_KEY)`.
  - Vibron deliberately does not copy the spec's example `AI_API_KEY=$(AI_API_KEY) <cmd>`, because make echoes expanded recipe lines to the terminal and CI logs (explained at `Makefile:25-27`).
  - The key is inherited from the environment, which the spec allows ("the exact implementation may differ").
  - **Verified:** `AI_API_KEY=sk-ant-DUMMY… TASK=x make -n setup run test eval clean | grep -c DUMMY` → `0`.
- **Keys never reach the browser.** Only a masked fingerprint is exposed (`credentials.ts:1-14`, `maskKey` at 117-121).
- **Not hard-coded anywhere.** See §8 for the repository and history scan.
- *Notes (low, G6 and G7):* `AI_API_KEY` is sufficient, but it is not the only credential path. Legacy per-provider variables (`ANTHROPIC_API_KEY` and others, `credentials.ts:23-32,61-65`) and keys saved in the web Settings UI (`credentials.ts:90-99`) take precedence over it. The missing-key message also names `ANTHROPIC_API_KEY` rather than `AI_API_KEY` (`lib/ai/types.ts:197`); the headless smoke run printed it.

### 3. Model requirement (text-only): PASS

**Requirement:** use text-only language models, and require no image, audio, video or other non-text input.

**Evidence:**
- **The headless harness is text/code-only.** `viberon run` takes the task as text, a GitHub issue URL, `owner/repo#N`, a file path or stdin (`cli/viberon.ts:20-21`; parsing at 227-234). `make run` passes `--task "$TASK"` (`Makefile:55`). The model sees only text, tool calls and tool results.
- **Nothing on the run or eval path sets images.** `git grep -n images -- lib/headless lib/harness cli eval` has one hit, the optional web-API request field `lib/harness/contracts.ts:34`, and neither `runHeadless` nor `solveTask` sets it.
- **Image blocks are optional and only come from the web UI.** A user can attach a screenshot in the web UI (`lib/ai/types.ts:33-38`; `lib/agents/orchestrator.ts:726-731`; `lib/agents/runner.ts:457-462`). They are never required. The OpenAI-compatible message converter keeps only text, tool_use and tool_result blocks (`lib/ai/openai-messages.ts:72,77,104,117`), so text-only endpoints work unchanged.

### 4. Model configuration: GAP

**Requirement:** define the model configuration clearly in the application or config. Use the prescribed model if the committee names one, and do not substitute another. The credential stays external.

**What is in place:**
- **Default model per provider.** `PROVIDER_TABLE` in `lib/ai/provider-config.ts:29-57` gives each provider's wire protocol, base URL and default model, for example `gemini-2.5-flash`, `openai/gpt-oss-120b` for Groq, OpenRouter, NVIDIA and others, and `gpt-5-mini` for OpenAI.
- **Full model catalog.** Tier, context window, pricing and whether each model is agentic are in `lib/ai/models.ts:50+`.
- **Prescribed model.** `AI_MODEL` (or `VIBERON_MODEL`) is read by `envModelId()` (`lib/ai/models.ts:320-323`). It wins automatic selection in `resolveModel()` (`lib/ai/index.ts:268-275`) and reaches the OpenAI-compatible adapter through `provider-config.ts:108,132`. The CLI also accepts `--model <id>` (`cli/viberon.ts:29`).
- **Selection without `AI_MODEL`.** The highest tier wins, with ties broken by `PROVIDER_PREFERENCE` (`lib/ai/index.ts:232,277-288`).

**Gaps (details under [Gaps](#gaps)):**
- **G1 (medium):** side calls ignore `AI_MODEL`. The reviewer and criteria predictor use the cheapest agentic model available (`lib/review/json.ts:96-104`; `lib/harness/criteria.ts:46`; `lib/harness/solve.ts:579-580,674`). They switch on under `--thorough` or on automatic escalation after a failed attempt (`solve.ts:937-945`), so one run can call a second model.
- **G2 (low):** `runTurn` swaps to another model after a `ModelUnavailableError`, first within the same provider and then across providers, for up to 8 hops (`lib/ai/index.ts:88-104,113-120`).
- **G3 (low):** `make eval` ignores `AI_MODEL`. `eval/run.ts:121` defaults to `VIBERON_MODEL ?? "claude-opus-5"`, so with a non-Anthropic `AI_API_KEY` and no `VIBERON_MODEL` the bonus eval fails its credential check.
- **G4 (low):** the declared defaults disagree. `PROVIDER_TABLE.anthropic.model = "claude-sonnet-5"` (line 33) is never used; its only consumer, `resolveOpenAiCompatEnv()` (called at `openai-compat.ts:228`), does not serve Anthropic. Without `AI_MODEL`, an Anthropic key actually runs `claude-opus-5-5`, the first frontier-tier catalog entry (`models.ts:54-58`). The no-key fallback string `"claude-opus-5"` (`lib/headless/run.ts:277`) is a third value.

### 5. Standard evaluation procedure: PASS

**Requirement:** (1) obtain the repo, (2) `export AI_API_KEY`, (3) `make setup`, (4) `make run` launches the harness in its evaluation mode, (5) the issue is supplied to the running harness, with `make test` where applicable.

**Evidence:**
- **Steps 2-4** need nothing beyond the exported key (§1, §2).
- **Step 5** works either way:
  - The evaluator pastes the issue into the running web IDE: Fix mode in the composer, or the Clone dialog for an issue URL (`README.md:147-160`).
  - Or the evaluator exports `TASK` (and `REPO`) before `make run`. The run edits `REPO` in place and prints `result.json`; the evidence bundle goes to `<repo>/.viberon/runs/<task-id>/` (`README.md:165-197`, `Makefile:7-19`).
- **`make test`** runs the team test suite (§1).
- *Note:* `REPO` defaults to `.` (`Makefile:55`), which is the Vibron checkout itself. An evaluator who sets `TASK` but forgets `REPO` would have the harness edit its own repo. This is documented in the Makefile header but easy to miss.

### 6. TUI requirements: N/A

**Requirement:** a team that ships a TUI must launch it through `make run`.

**Evidence:**
- **No TUI.** Vibron ships a Next.js web IDE, an Electron desktop shell and a headless CLI (`README.md:99-106,134-143,165-197`). A curses-style terminal UI is out of scope by design (`README.md:331`).
- **The spirit of §6 is still met.** Both evaluation modes start from `make run` with no team-specific command to discover (`Makefile:50-56`), and the flow matches the spec: repo → `AI_API_KEY` → `make setup` → `make run` → issue → execution → `result.json`.
- *Caveat:* the interactive mode needs a browser at `localhost:3000`. On a display-less evaluation box the `TASK` headless mode is the path to use.

### 7. Evaluation environment: PASS

**Requirement:** run in the committee's standard environment: its runtime, credential, text-only model, GitHub repo or issue, and testing infrastructure.

**Evidence:**
- **Credential and model come from env.** The designated credential and prescribed model arrive through `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL` and `AI_PROVIDER` (§2, §4). Azure and keyless OpenAI-compatible endpoints (vLLM, Ollama) are handled (`provider-config.ts:86-137`; `lib/ai/index.ts:49-50`).
- **The target repo's own tests are used.** The verification gate auto-detects the test command: pytest or unittest, `package.json` scripts, `go test`, `cargo test`, mvn or gradle, `make test`, then typecheck or compile fallbacks. Tools that are not installed are skipped (`ARCHITECTURE.md:170-178`).
- **The issue can arrive as a GitHub URL or plain text** (§3).
- The runtime prerequisite (Node) is covered under §9.

### 8. Credential security: PASS

**Requirement:** no hard-coded or committed credentials in source, Makefiles, `.env` files or docs. A `.env.example` with an empty `AI_API_KEY=` is allowed.

**Evidence:**
- **`.env.example`** (lines 1-9) has an empty `AI_API_KEY=` plus empty optional overrides, and a warning never to put a real key there.
- **`.gitignore:9-10`** holds `.env*` and `!.env.example`.
  - `git ls-files | grep '\.env'` → `.env.example` only.
  - `git check-ignore -v .env .env.local` → both ignored by `.gitignore:9`. `.env.example` is not ignored and is tracked.
- **Working-tree scan:** `git grep -nE "sk-ant-[A-Za-z0-9_-]{10,}|sk-or-…|AIza…|gsk_…|xai-…|nvapi-…|hf_…" -- . ':!node_modules' ':!pnpm-lock.yaml'` returns exactly one hit:
  ```
  tests/ai.claude-cli.test.ts:111:    process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
  ```
  **This is a test fixture, not a real credential.** It is a dummy string that the test sets in order to assert the key is not passed to the `claude` subprocess (`expect(seen.anthropicKey).toBeNull()`).
- **History scan:** `git log --all -G'<same regex>'` over all 171 commits flags 2 commits, both of them test fixtures only:
  - `6cf3730` adds redaction-test dummies `"sk-ant-0123456789abcdef"` and `"sk-ant-zzzzzzzzzzzzzzzz"`.
  - `81fc3a6` adds the same `should-not-leak` fixture.
- **Makefile:** no credential appears in any recipe, and none is echoed (§2).

### 9. Environment independence: GAP

**Requirement:** the Makefile encapsulates setup. The evaluator must not have to install undocumented dependencies, work out the run command, or edit source, dependency or config files.

**What is in place:**
- **Dependencies are declared and locked.** They are in `package.json` and `pnpm-lock.yaml` (lockfile v9.0), installed with `--frozen-lockfile`.
- **pnpm is bootstrapped when missing** through `corepack enable` (`Makefile:45`).
- **The run command is fixed.** It is `make run`, and the CLI resolves its own root through symlinks (`bin/viberon:4-11`).
- **Setup warning is harmless.** pnpm 10 prints "Ignored build scripts: @firebase/util, electron, esbuild, msw, protobufjs, sharp, unrs-resolver". This does not affect `run` or `test`: the test suite passed after exactly this install.

**Gaps (details under [Gaps](#gaps)):**
- **G5 (medium):** the Node.js runtime is an undeclared prerequisite. `package.json` has no `engines` or `packageManager` field, and there is no `.nvmrc` or `.node-version`. `make setup` assumes Node and corepack are already installed, and without `packageManager` corepack picks its own default pnpm. Verified here on Node v22.18.0 with pnpm 10.24.0; `@types/node ^20` implies Node ≥ 20.
- **G6 (low):** the README does not document the evaluation interface. It never mentions `make` or `AI_API_KEY` (`grep` finds no hits). Its headless quickstart tells the reader to `export ANTHROPIC_API_KEY` (`README.md:168`), and "Getting started" says to use `pnpm install`/`pnpm dev` and add a key in Settings (`README.md:110-132`).
- *Note:* `make eval` (the bonus target) also needs `python3` for the Python fixture tasks (`README.md:209-210`), and `make setup` does not install it.

### 10. Reproducible execution: PASS

**Requirement:** behave consistently under the same conditions. Document or control any randomness, seeds or settings that materially affect output.

**Evidence:**
- **Sampling on OpenAI-compatible endpoints:** temperature is 0 by default and can be overridden with `AI_TEMPERATURE` (`lib/ai/openai-compat.ts:284-286`). From the 3rd malformed-response retry the adapter perturbs the prompt and raises temperature to 0.7 (`openai-compat.ts:434-435`).
- **Sampling on Anthropic:** no temperature or top_p is sent, because Opus 5 and Sonnet 5 reject them (`lib/ai/anthropic.ts:19,241`). Provider defaults apply.
- **Budgets are fixed defaults:** `--max-turns` defaults to 40 (`lib/headless/run.ts:344`). Every run flag is documented in `USAGE` (`cli/viberon.ts:19-59`) and in the Makefile header (`TASK`, `REPO`, `ARGS`).
- **`Math.random`** is used only for run IDs (`lib/headless/run.ts:145`) and retry jitter (`lib/ai/retry.ts:180`), neither of which affects output.
- **Dependencies** are pinned by the lockfile plus `--frozen-lockfile`.
- *Note (low, G8):* `AI_TEMPERATURE` and the retry temperature bump exist only in code. They are not in `.env.example`, the README or `ARCHITECTURE.md`. They are controlled within the project, which satisfies §10, but not documented.

### 11. Evaluation independence: PASS

**Requirement:** evaluators will not modify the implementation to make it executable.

**Evidence:**
- **No edits needed.** `make setup`, `make test` and the headless `make run` were exercised on this checkout without touching source.
- **All configuration is env-only.** Credential, model, endpoint, task and repo are all environment variables (§2, §4, §5). There is no config file to hand-edit.
- **Failures are structured.** A missing or invalid credential ends the run with exit code 2 and a structured `result.json` (`"status": "error"`, the error message, zero model calls) rather than a crash. The headless smoke run confirmed this.

### 12. Standard evaluator workflow: PASS

**Requirement:** `git clone` → `cd` → `export AI_API_KEY=…` → `make setup` → `make run`, and optionally `make test`.

**Evidence:**
- Each step maps onto the verified behaviour in §1, §2 and §5. No step needs a team-specific command.
- `make run` in interactive mode blocks, serving the app until it is interrupted. That is the intended "launch".
- With `TASK` exported, `make run` exits with the run's own exit code: 0 resolved or unverified, 1 failed or incomplete, 2 error (`cli/viberon.ts:56`).

### 13. Final submission checklist: PASS (local), clean-environment run open

**Requirement:** test `make setup`, `make run` and `make test` in a clean environment. The repo holds a root `Makefile`, a `README.md`, source, config and dependency files.

**Evidence:**
- **Layout:**
  - `Makefile` and `README.md` at the root.
  - Source: `app/`, `lib/`, `cli/`, `bin/`, `components/`, `eval/`.
  - Config: `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.env.example`.
  - Dependency files: `package.json`, `pnpm-lock.yaml`.
  - Technical report: `ARCHITECTURE.md`.
- **Verified in this worktree:** `make setup` (7.8 s) and `make test` (958 passed, 1 skipped, 0 failed). `make run`'s headless path was verified too.
- **Open item:** these runs used a warm pnpm store and a machine that already had Node 22. The spec asks for a *clean* environment, so a run in a fresh container (for example `node:22` with no pnpm store) has not been done yet.
- *Trivia:* `package.json` declares `"bin"` twice (lines 8 and 95), with identical values. It is harmless, since JSON takes the last value.

### 14. Important (standard interface, no manual configuration): PASS

**Requirement:** the evaluator can run `export AI_API_KEY=…; make setup; make run` without modifying source or configuring the project by hand.

**Evidence:**
- This holds as shown in §1, §2, §11 and §12, given a machine with Node ≥ 20 (see G5).
- No key entry in source or UI is needed: `AI_API_KEY` from the environment is picked up by both the web app and the headless CLI (`credentials.ts:61-65`, `openai-compat.ts:422`).

---

## Gaps

| # | § | Severity | Gap | Suggested fix |
|---|---|---|---|---|
| G1 | 4 | Medium | The reviewer and criteria predictor use the cheapest available agentic model, not `AI_MODEL`, so a run can call a second model (`lib/review/json.ts:96-104`, `lib/harness/criteria.ts:46`, `lib/harness/solve.ts:579-580,937-945`) | In `reviewModel()`, return `envModelId()` when it is set, so every call uses the prescribed model |
| G5 | 9 | Medium | The Node runtime is not declared or pinned: no `engines`, no `packageManager`, no `.nvmrc`. `make setup` assumes Node and corepack exist | Add `"engines": {"node": ">=20"}`, `"packageManager": "pnpm@10.24.0"` and `.nvmrc`. Have `make setup` fail fast with a clear message if `node` is missing or too old |
| G2 | 4 | Low | Automatic cross-model fallback on `ModelUnavailableError`, up to 8 hops (`lib/ai/index.ts:88-104,113-120`) | Disable the hop when `AI_MODEL` is set: fail loudly instead of substituting |
| G3 | 4 | Low | `make eval` ignores `AI_MODEL` and defaults to `claude-opus-5` (`eval/run.ts:121`) | Use `AI_MODEL`, or `resolveModel("auto")` as `lib/headless/run.ts:268-278` does |
| G4 | 4 | Low | Three disagreeing "default model" values: `PROVIDER_TABLE.anthropic.model` (`claude-sonnet-5`, unused), the actual catalog pick (`claude-opus-5-5`), and the no-key fallback (`claude-opus-5`) | Pick one source of truth, and remove or align the unused Anthropic entry |
| G6 | 2, 9 | Low | The README never mentions `make` or `AI_API_KEY`; its headless quickstart says `ANTHROPIC_API_KEY`. The missing-key error also names `ANTHROPIC_API_KEY` (`lib/ai/types.ts:197`) | Add an "Evaluation quickstart" (`export AI_API_KEY`, `make setup`, `make run`) to the README, and mention `AI_API_KEY` in the missing-credential messages |
| G7 | 2 | Low | `AI_API_KEY` is not exclusive: per-provider env vars and UI-saved keys take precedence (`credentials.ts:61-65,90-99`) | Let `AI_API_KEY` win when it is set, or document the precedence. It is harmless on a clean evaluator box |
| G8 | 10 | Low | `AI_TEMPERATURE` and the retry temperature bump to 0.7 are undocumented (`lib/ai/openai-compat.ts:284-286,434`) | Add `AI_TEMPERATURE=` to `.env.example` and one line to `ARCHITECTURE.md` |
| — | 13 | Open | `make setup`, `run` and `test` have not been run in a pristine container | Run the §12 workflow in `docker run node:22` before the deadline |

## How this was verified

```sh
cd /Users/nishant/Developer/vibron-hackathon-spec-doc

# Makefile never echoes the key
AI_API_KEY=sk-ant-DUMMYDUMMYDUMMY TASK=x make -n setup run test eval clean | grep -c DUMMY   # → 0
grep -n AI_API_KEY Makefile                                                                  # → comment lines 21, 24 only

# .env handling
git ls-files | grep -E '(^|/)\.env'                    # → .env.example
git check-ignore -v .env .env.local                    # → both ignored by .gitignore:9

# Secret scan: working tree and full history
git grep -nE "sk-ant-[A-Za-z0-9_-]{10,}|sk-or-[A-Za-z0-9_-]{10,}|AIza[A-Za-z0-9_-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{10,}|nvapi-[A-Za-z0-9-]{10,}|hf_[A-Za-z0-9]{20,}" -- . ':!node_modules' ':!pnpm-lock.yaml'
git log --all --oneline -G'<same regex>' -- . ':!pnpm-lock.yaml'   # → 6cf3730, 81fc3a6 (fixtures only)

# Runtime pinning
git grep -nE 'engines|packageManager|volta' -- package.json    # → no match
ls -a | grep -E 'nvmrc|node-version|tool-versions'             # → none

# Live runs (Node v22.18.0, pnpm 10.24.0, corepack 0.33.0)
make setup                                                     # → Done in 7.8s
env -u AI_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u GROQ_API_KEY make test
                                                               # → 99 files, 958 passed, 1 skipped
TASK="Say hello" REPO=<scratch git repo> make run              # no key → exit 2, structured result.json
```

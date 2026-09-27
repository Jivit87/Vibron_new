# Viberon

An AI development environment that plans work, dispatches specialist agents in
parallel, and builds real software — on disk, with a terminal, in one window.

Describe what you want once. Viberon decomposes it, assigns each piece to the
agent best suited to it, runs them concurrently against disjoint files, then
verifies the result.

---

## What makes it different

### Graph-native context

Most coding agents read files. Viberon parses the workspace into a symbol graph
and makes agents navigate *that* instead, climbing a ladder of increasing cost
and stopping as soon as they know enough:

| Level | Tool | Returns | Typical cost |
| --- | --- | --- | --- |
| L0 | repo map | folder tree, entry points, stack | ~300 tokens |
| L1 | `symbol_index` | every file → its exported symbols | ~1–3k |
| L2 | `graph_search` | relevant symbols **with source and call/import edges** | ~1–4k |
| L2.5 | `symbol_outline` | one file's signatures and line ranges, no bodies | ~10% of the file |
| L3 | `read_file` | raw source, line-addressed | full price |

The tool descriptions actively steer models down this ladder, and `read_file` is
documented as a last resort.

### Three independent token-saving mechanisms

All three are measured, not asserted — open the **token ledger** to audit any run.

1. **Graph retrieval** — answering from a symbol slice instead of whole files.
2. **Repeat-read dedupe** — every chunk handed to a model is hashed. Ask for the
   same content twice and the second request returns a pointer, not the bytes.
3. **Prompt caching** — project memory and the repo map form a stable prefix
   marked with a cache breakpoint, so every turn after the first re-reads them at
   roughly a tenth of the price.

### Persistent project memory

Agents write what they learn into a durable brain that survives sessions:
architecture decisions and their rationale, conventions inferred from the code,
non-obvious facts, per-file purposes, and in-flight tasks. It is rendered into
the cached prompt prefix on every run, and mirrored to `.viberon/MEMORY.md` so a
human can read it. The **Memory** panel makes it inspectable and editable — an
agent that learned something wrong can be corrected.

### Multi-agent orchestration

An orchestrator decomposes the request into a task DAG and assigns each step to a
specialist with its own prompt, tool subset, and model tier:

**architect** · **frontend** · **design** · **backend** · **database** ·
**logic & math** · **devops** · **tester** · **reviewer** · **docs**

Steps that do not depend on each other run concurrently. Every step declares the
files it owns, and that list becomes a hard write-lock — the plan normalizer
enforces it even if the planning model ignores the instruction, so two agents can
never clobber the same file. After each wave the graph and memory are re-indexed
so the next wave sees what the previous one built. Multi-step runs end with an
adversarial reviewer that hunts specifically for the integration gaps parallel
agents produce.

### It answers questions instead of building answers

Not every prompt is a build request. "How does auth work?" gets a grounded
explanation with file citations; "add dark mode" gets a plan and agents. The
routing runs before any model call, and the classifier deliberately returns
"unsure" rather than guessing — ambiguous prompts reach the orchestrator,
which can still decline to build via `answer_directly`.

The distinction it cares most about is politeness versus instruction: *"can
you add a toggle?"* is an order, *"how do I add a toggle?"* is a question.
Getting that backwards either refuses requested work or edits files nobody
asked it to touch.

Questions run on a read-only agent with no write tools at all, so a question
physically cannot mutate the workspace. Its reply streams into the
conversation token by token rather than into a collapsed progress row.

### Chat history

Conversations are per-workspace, persist across restarts, and are reachable
from both shells — the Chat header and the IDE's agent dock share one history
popover, so a thread started in one mode is open in the other.

Search, rename, and delete are inline. Threads group by recency (Today,
Yesterday, Previous 7 days, Older). `⌘K` then `#` searches conversations
alongside files and symbols, because searching for a topic you discussed is
as common as searching for a file.

Every finished run is recorded against its thread — what was asked, what
changed, what it cost, and the checkpoint to undo it. The Changes panel lists
them, and clicking one jumps to the reply that produced it.

### A real IDE, not a chat box

Two modes, one toggle (`⌘⇧M`), sharing all state so switching mid-run loses
nothing:

- **Chat** — a Claude-Code-style conversation column.
- **IDE** — explorer, Monaco editor, symbol graph, integrated terminal, live app
  preview, and the agent stream docked beside your code.

---

## Getting started

```bash
pnpm install
pnpm dev
```

Open <http://localhost:3000>, then add an API key in **Settings → Providers**.
Keys are stored server-side and never sent to the browser; the UI only ever sees
a masked fingerprint. They are verified against the provider before being saved.

Anthropic is strongly recommended as the primary provider — long agentic tool
loops are where Claude is furthest ahead, and the whole orchestration model
depends on reliable tool use.

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude Opus 5 / Sonnet 5 / Haiku 4.5 |
| `GROQ_API_KEY` | GPT-OSS and Llama, for cheap mechanical subtasks |
| `FIREBASE_*` | Optional. Firestore persistence instead of the local disk store |

Both keys are optional at the environment level — the settings UI writes them to
the local store instead.

### Desktop

```bash
pnpm dev:desktop      # Electron shell against the dev server
pnpm build:desktop    # packaged app
```

The desktop build is what unlocks **Open Folder**. A folder-backed workspace is
where Viberon is most useful: agents write to real files, the terminal runs real
commands, and the preview pane points at your actual dev server.

---

## Quickstart: clone → fix

Paste a repository URL, `owner/repo`, or a GitHub issue URL. Viberon clones it into
`~/Viberon/repos/<owner>__<name>` (override with `VIBERON_REPOS_DIR`) and indexes the
code graph. It then optionally sets up the environment (a venv plus
`pip install -e .`, or `npm ci`/`pnpm i`). For an issue URL it also loads the issue text.

```bash
# from the UI: the Clone dialog (POST /api/clone streams progress)
# from the shell:
bin/viberon clone https://github.com/owner/repo/issues/123 --setup
```

Then use **Fix** mode in the composer, or run the task headless (next section).
Private repos and issues use the GitHub token from **Settings → Integrations**
(falling back to `GITHUB_TOKEN`); it reaches git through `GIT_CONFIG_*` env
entries, never through the URL.

## Quickstart: headless

```bash
export ANTHROPIC_API_KEY=…            # or OPENAI_API_KEY + VIBERON_OPENAI_BASE_URL + VIBERON_MODEL=openai:<id>
bin/viberon run --repo ~/code/project --task "Pre-release versions sort in the wrong order"
bin/viberon run --repo . --task https://github.com/owner/repo/issues/42 --worktree --json
```

The run works from any directory and leaves the evidence bundle in
`<repo>/.viberon/runs/<task-id>/`:

| File | Contents |
| --- | --- |
| `result.json` | status, diff, gate (baseline vs final, new failures, fixed tests), recovery counters, token/call/time metrics |
| `trajectory.jsonl` | a `meta` line, every orchestration event, and a `result` line |
| `patch.diff` | the change, ready for `git apply` |
| `report.md` | the human-readable evidence report |

Exit codes: `0` resolved or unverified, `1` failed or incomplete, `2` error.

Useful flags:

- `--test-cmd` overrides the auto-detected checks.
- `--no-gate` disables verification.
- `--max-turns` and `--timeout` set the budget.
- `--worktree` works in a detached git worktree, so your checkout is untouched.
- `--independent-test` spends one extra model turn after a verified fix to write
  a blind regression test from the issue and original code. It runs on both
  trees; an assertion failure on the patch gets one repair pass. This option
  executes generated test code with the local runner's permissions.

Headless runs keep all state in memory (`VIBERON_STORE=memory`). Everything they write
to the repo lives under `.viberon/`, which is excluded from git.

## Quickstart: eval

```bash
bin/viberon eval                      # all tasks in eval/tasks
bin/viberon eval --only slugify,semver-js --max-turns 30
```

Each task copies a small repo, runs the same headless path, and then grades the result
with **hidden tests** the agent never saw. Results go to `eval/results/latest.json`
and `eval/results/results.md`, and `GET /api/eval` serves them. The metrics are pass
rate, honest verdicts, regressions, tokens, calls and time. Python tasks use a cached
venv with pytest (`eval/.cache/`).

To compare runs from the Harness Arena JSONL format, use
`bin/viberon arena report path/to/results.jsonl`. The report de-duplicates
retries, ranks by fixes then tokens then time, and only ranks tasks completed
by every harness. `--json` returns the same comparison as structured data.

## Quickstart: memory in Obsidian

Every workspace keeps its anchored memory (notes, and one `fix` note per solve run)
in `.viberon/memory.json` and renders it as an Obsidian vault:

```bash
open "obsidian://open?path=$(pwd)/.viberon/vault"   # or: Obsidian → Open folder as vault
```

- `notes/<slug>.md` has one note per entry, with frontmatter (`id`, `kind`, `anchors`,
  `stale`, `created`, `updated`) and `[[code/<path>]]` links; `code/<path>.md` lists a
  file's symbols and the notes about it. The graph view is the same graph the app shows.
- It is two-way. Edit a note and Viberon imports it on the next read. Drop a new
  `.md` into `notes/` and it becomes a note, anchored to the `[[code/…]]` files it links.
- A note whose anchored code changed is marked `stale: true` ("may be outdated").

See [ARCHITECTURE.md](ARCHITECTURE.md) for the technical report.

---

## The terminal

Agents run commands through the same integrated terminal you type into — install
dependencies, run builds, execute tests, start dev servers. Detected `localhost`
URLs automatically feed the preview pane.

Execution is governed by a policy you set in the composer:

- **Ask** (default) — anything outside the auto-approve list prompts you inline.
- **Auto** — never interrupt.
- **Off** — no shell access at all.

A hard-blocked set is refused regardless of policy: deleting outside the
workspace, formatting disks, writing to raw devices, piping remote scripts into a
shell, and privilege escalation.

Every run is snapshotted beforehand, so a run that goes wrong is one click to
undo — per file, or the whole thing.

---

## Keyboard

| Shortcut | Action |
| --- | --- |
| `⌘K` | Command palette — files, `>` commands, `@` symbols, `#` chats, `$` run |
| `⌘⇧M` | Toggle Chat / IDE |
| `⌘P` | Quick open |
| `⌘⇧F` | Search in files |
| `` ⌘` `` | Toggle terminal |
| `⌘B` | Toggle sidebar |
| `⌘G` | Code graph |
| `⌘S` | Save file |
| `⌘,` | Settings |

---

## Architecture

```
lib/ai/          provider abstraction (Anthropic, Groq), model catalog, credentials
lib/context/     progressive-disclosure engine + the dedupe/savings ledger
lib/memory/      durable project brain + graph-anchored memory with staleness
lib/agents/      specialist roster, single-agent tool loop, orchestrator
lib/tools/       the agent tool suite, with per-role least-privilege subsets
lib/terminal/    process execution, streaming, and command safety classification
lib/workspace/   unified filesystem, persistent incremental graph, clone, bootstrap
lib/lang/        Python/Go/Rust/Java extractors, tsconfig path aliases
lib/verify/      test detection, per-framework parsing, failure extraction
lib/harness/     solveTask: verification gate, recovery, checkpoints
lib/headless/    headless runs and the evidence bundle
cli/, bin/       the `viberon` command
eval/            hidden-test tasks, runner and scorer
lib/checkpoints/ snapshot and restore
app/api/         SSE agent stream, terminal, memory, settings, files, checkpoints
lib/client/      conversation storage and the agent stream transport
components/vibe/ the two shells and every panel
```

Two design decisions worth calling out:

**The graph is patched incrementally.** Re-parsing a whole workspace on every
agent write is the difference between an edit costing 5ms and 3s; only the
changed file is re-parsed and spliced into the graph.

**Small models degrade rather than fail.** If a provider rejects a request as too
large — a small context window, or a tokens-per-minute cap on a free tier — the
runner automatically retries with a compact prompt and a reduced tool set, and
the orchestrator falls back from a team to a single agent. Reserved output tokens
are budgeted per model too, because some providers meter those against the same
rate limit.

---

## Scripts

Viberon is an Electron desktop application. The web server is only the local
renderer used by Electron during development and by AI test runs; use
`pnpm dev:desktop` for the product experience.

```bash
pnpm dev            # Next.js dev server
pnpm build          # production build (typechecks)
pnpm test           # vitest — property and example tests
pnpm lint           # eslint
pnpm dev:desktop    # Electron + dev server
pnpm viberon run --repo … --task …      # headless (same as bin/viberon)
pnpm eval           # hidden-test eval suite
```

## Out of scope, by design

- Accounts, auth, or multi-user collaboration.
- Vector embeddings — the symbol graph does the retrieval work.
- A full terminal emulator: commands and streaming output, not curses apps.

# Gap audit (end-to-end walkthrough)

How this was found: a dev server with `VIBERON_STORE=memory`. `sindresorhus/slugify` was cloned with
`bin/viberon clone` into a temp dir, registered through `POST /api/workspaces`, and then used through
the HTTP API and `?mock=1` UI in this order: open file, search, terminal, Problems, Fix (`/api/agent`),
SCM, deliver (to a local bare remote), memory, MCP, checkpoints, tasks, and the headless CLI
(`run`, `eval`, `review`, `issues`, `clone`, `arena`). Nothing was pushed to GitHub.

Owners: **A** = server/store/indexing/cancel (`lib/store.ts`, `lib/local-disk-workspace.ts`,
`lib/workspace/**`, `lib/parser.ts`, `lib/lang/**`, `lib/tasks/**`, `lib/workers/**`).
**B** = UI (`components/**`, `store/**`, `lib/client/**`). **H** = harness session
(`lib/harness/**`, `lib/agents/**`, `lib/ai/**`, `lib/review/**`). **C** = this pass (routes, git,
deliver, verify, mcp, memory, terminal, problems, search, cli, docs, tests).

Tests for the C fixes are in `tests/gaps.agent-c.test.ts`.

## Broken

| # | Gap | Where | Owner | Status |
|---|-----|-------|-------|--------|
| 1 | `viberon run --repo /missing` crashes with a stack trace (`ENOENT: mkdir '/missing'`) instead of a clear error. | `cli/viberon.ts` (run) | C | **Fixed**: "run: repository not found: …", exit 2. `runHeadless` throws are caught too. |
| 2 | `viberon eval --only typo` prints `fatal: Error: no eval tasks found` with a stack. `--only slugify,typo` silently drops the typo. | `cli/viberon.ts` (eval) | C | **Fixed**: unknown names are listed with the available tasks, exit 2. Eval errors are caught. |
| 3 | `POST /api/terminal` accepts `cwd` but ignores it, so every command runs at the root. | `app/api/terminal/route.ts` | C | **Fixed**: relative `cwd` inside the root; escape, absolute or missing → 400. |
| 4 | Workspace-scope `POST /api/mcp {action:"add"}` silently overwrites an existing server of the same name. The global scope rejects it. | `app/api/mcp/route.ts` | C | **Fixed**: 400 "already exists". |
| 5 | `PATCH /api/memory` with an invalid `entry` (bad kind or empty text) returns 200 and drops it silently. | `app/api/memory/route.ts` | C | **Fixed**: 400 with the allowed kinds. |
| 6 | `/api/agent` with no API keys configured silently picks `claude-cli:opus` and starts a real, paid orchestrated run. The body field `mode:"fix"` is ignored; Fix is `interaction:"fix"`. A caller that sends `mode` gets a full build run. | `lib/ai` model resolution, `app/api/agent/route.ts` | H | Handed off. Suggest: reject an unknown `mode`, and surface "using your Claude CLI subscription" in `run_start`. |
| 7 | Every route accepts any `repoKey`. `GET /api/memory?repoKey=nope` answers 200 with a fabricated "Empty workspace" memory, and search, checkpoints and git answer as if an empty workspace existed. | `lib/workspace` `openWorkspace` | A | Handed off. Suggest `openWorkspace(key, {mustExist:true})` → 404, then routes adopt it (C can do the routes once it exists). |

## Missing

| # | Gap | Where | Owner | Status |
|---|-----|-------|-------|--------|
| 8 | The Problems panel never runs tests. It only runs tsc and ESLint, so a JS repo without them (such as slugify) shows "no problems" while `npm test` fails. | `lib/problems`, `app/api/problems` | C | **Fixed (server)**: `POST /api/problems {repoKey, tests:true}` runs the detected test command (the one the Fix gate uses). Failing tests become problems (`source:"tests"`, file and line from the test id and excerpt). A crash becomes one project-wide entry with the real reason (e.g. "sh: xo: command not found"). Later non-test runs keep the last test results. |
| 8b | UI for #8: a "Run tests" button in Problems that POSTs `tests:true`. Render the `tests` checker note ("npm test: 3 passed, 1 failed"). | `components/vibe/ProblemsPanel.tsx`, `store/problems.ts` | B | Handed off. |
| 9 | Deliver cannot target a non-GitHub remote (GitLab, a self-hosted server, a local bare repo). It refuses with `not_github` before doing anything. | `lib/deliver/index.ts`, `app/api/deliver` | C | **Fixed (server)**: `pushOnly: true` branches, commits and pushes with the remote's own git credentials, then returns `{branch, commit, prUrl:"", prNumber:0, pushedOnly:true}`. The `not_github` error now points at it. |
| 9b | UI for #9: on `code:"not_github"`, offer "Push branch only" (resend with `pushOnly:true`). `normalizeDeliver` treats a 200 without `prUrl` as failure, so it must accept `pushedOnly`. | `lib/client/deliver.ts`, deliver UI | B | Handed off. |
| 10 | Graph-anchored memory notes (the `entries` in `GET /api/memory`, also shown in the vault and graph) can only be created or removed by editing the Obsidian vault. No API existed, so the panel shows them read-only. | `app/api/memory/route.ts` | C | **Fixed (server)**: `PATCH {note:{text, kind?, anchors?}}` adds one. `DELETE ?entryId=` also removes anchored entries (`removedAnchored`). |
| 10b | UI for #10: "Add note" (anchored to the open file) and "Forget" on anchored rows. | `components/vibe/MemoryPanel.tsx` (`AnchoredRow`) | B | Handed off. |
| 11 | MCP servers cannot be edited, only removed and re-added (which loses trust and enable state). | `app/api/mcp/route.ts` | C | **Fixed (server)**: `action:"update"` replaces the config. Env/header values still in redacted form (`su••••`) keep the stored secret. Servers from `.mcp.json` or `.cursor/mcp.json` are refused with "edit it in that file". Trust resets on a changed config by design. |
| 11b | UI for #11: an Edit button in MCP settings. | `components/**` MCP settings | B | Handed off. |
| 12 | Terminal sessions can never be removed. `DELETE` only kills running ones and returns `{ok:false}` with 200 for unknown ids. Finished sessions pile up for an hour. | `app/api/terminal`, `lib/terminal` | C | **Fixed**: `DELETE` on a finished session removes it (`removed:true`). An unknown id → 404. |
| 13 | `viberon --version` is unknown. | `cli/viberon.ts` | C | **Fixed**: `--version`, `-v` and `version`. |
| 14 | No `GET /api/workspaces` to list registered folders; the UI has to keep its own list. | `lib/local-disk-workspace.ts` (needs a lister) | A | Handed off (C can add the route once a lister exists). |
| 15 | Each terminal command is a fresh shell, so `cd` never persists (by design: "not a full terminal emulator"). With #3 the UI could track a cwd per tab and send it. | `components/vibe/TerminalPanel.tsx` | B | Handed off. |
| 16 | Problems and Fix need installed dependencies. A fresh clone without `--setup` fails every check ("xo: command not found"), and nothing suggests installing them. | clone dialog / Problems empty state | B (UI hint), A (`lib/workspace/bootstrap`) | Handed off. #8 now shows the real error text. |

## Rough

| # | Gap | Where | Owner | Status |
|---|-----|-------|-------|--------|
| 17 | `viberon clone` logs about 40 lines of `Receiving objects: NN%` redraws. | `cli/viberon.ts` | C | **Fixed**: the first and final line of each phase only. |
| 18 | The search error repeats itself: "Invalid regular expression: Invalid regular expression: /(/gi: …". | `lib/search/index.ts` | C | **Fixed**. |
| 19 | Memory overview says "A unknown stack project". The stack is empty for a plain Node package, and TypeScript is only detected from `.tsx`. | `lib/memory/index.ts` | C | **Fixed**: Node.js fallback, TypeScript from `tsconfig.json`/`.ts`, Java from `pom.xml`/gradle, Python from `setup.py`/`setup.cfg`. The wording is "A project with N tracked files" and "file" is singular for one. |
| 20 | The agent tool `workspace_stats` prints "Stack: unknown" (same data as #19; better now that #19 detects more). | `lib/tools/registry.ts` | H | Note only. |
| 21 | Workspace labels are inconsistent: clone says `sindresorhus/slugify`, while `POST /api/workspaces` on the same folder says `sindresorhus__slugify`. | `lib/local-disk-workspace.ts` `registerLocalWorkspace` | A | Handed off: derive `owner/repo` from the `owner__repo` folder name or the origin URL. |
| 22 | There are two import paths. `POST /api/repos` (GitHub tarball into the store) and `POST /api/clone` (git clone to disk) overlap, and their errors differ ("Invalid GitHub URL: x" vs. the clone hint). | `app/api/repos`, `app/api/clone` | A/C | Note: pick one for the UI. `/api/repos` only feeds the store-backed virtual workspace. |
| 23 | 405 responses (e.g. `POST /api/eval`, `POST /api/issue`) have empty bodies. | Next default | C | Left as is (harmless). |
| 24 | `viberon run --model <unknown>` indexes the workspace before failing on the model. | `lib/headless/run.ts` | H | Handed off: validate the model first. |

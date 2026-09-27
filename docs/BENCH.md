# Benchmarks

Ported from Pramana (`pramana/bench.py`, `bench/swebench/*`). Every number is graded by
hidden tests the agent never sees, through the same headless path as `viberon run`.

## Bundled suites

| suite | tasks | purpose |
|---|---|---|
| `quick` | slugify (Python), semver-js (JavaScript) | fast end-to-end smoke test |
| `mini` | every task in `eval/tasks/` | the full bundled benchmark |

```bash
npx tsx bench/cli.ts quick                  # or: VIBERON_EVAL_SUITE=quick pnpm eval
npx tsx bench/cli.ts mini --model claude-opus-5 --max-turns 30
npx tsx bench/cli.ts mini --only slugify,todo-json
```

Each task is `eval/tasks/<name>/{repo/, issue.md, hidden_tests/, task.json}`. The repo is copied
to a temp dir and committed; Python tasks get a shared cached venv with pytest as `.venv`.
After the solve, `hidden_tests/` is copied in and `task.json`'s `test_cmd` decides **verified**.

Output: a terminal table (task, harness verdict, verified, tokens, calls, tools, wall),
`eval/results/latest.json`, `eval/results/results.md`, and a timestamped copy in
`eval/results/runs/eval-<time>.json` so before/after runs can be compared.

## SWE-bench Verified subset (no Docker)

```bash
npx tsx bench/cli.ts swe-pick --seed 0 > ids.txt   # stratified: requests 3, pytest 4, sympy 6, django 9, flask 1, pylint 1
npx tsx bench/cli.ts swe-gold ids.txt              # validate envs with the official patch, no model
npx tsx bench/cli.ts swe-run ids.txt --tag v1 --shard 0/2 &
npx tsx bench/cli.ts swe-run ids.txt --tag v1 --shard 1/2
npx tsx bench/cli.ts swe-report v1 v2              # per-instance grid + per-tag means + common-instance head-to-head
```

* Rows come from `--data`, `$VIBERON_SWE_DATA`, `$PRAMANA_SWE_WORK/swe_verified.json`, or are
  downloaded once from the HF datasets server.
* Checkout: `git fetch --depth 1` of `base_commit`; venv via `uv` (or `python -m venv`) from the
  per-repo specs in `eval/swe/specs.ts`; `SETUPTOOLS_SCM_PRETEND_VERSION` for tag-less trees.
* **Gold first:** `swe-gold` writes `eval/swe/results/gold.json`. `swe-run` then skips instances
  whose official patch does not pass FAIL_TO_PASS here, and ignores PASS_TO_PASS tests that fail
  even with the official patch (platform-specific), exactly as Pramana does.
* **Resolved** = every FAIL_TO_PASS and every remaining PASS_TO_PASS test passes after the hidden
  test patch is applied to the agent's tree.
* `--tag` rows append to `results-<tag>[-shard…].jsonl`; re-running a tag resumes (done ids skipped).

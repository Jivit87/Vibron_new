# Harness integration design

## Intent

Bring the strongest missing capabilities from `Harness Hackathon/pramana` and
`ai-harness/arena` into Vibron's existing TypeScript harness. Keep the current
solver, desktop UI, and CLI as one implementation. Spend extra model calls only
when they can test a candidate fix or expose a likely defect.

## Source mapping

Vibron already has Pramana's issue localization, original-versus-patched gate,
trajectory guards, checkpoints, retry, provider negotiation, and evidence
bundle. The material gaps are DeepSeek V4 reasoning pass-back, blind
independent regression testing, and comparative arena reporting. The arena's
original Python runner depends on external SWE-bench tooling, machine-specific
paths, and installed third-party CLIs, so those dependencies are not copied.

## Design

1. For DeepSeek models using Chat Completions, preserve every prior assistant
   turn's `reasoning_content` in native tool conversations. Other model families
   keep their existing wire behavior. If an endpoint rejects pass-back, the
   existing negotiation path disables it for that model.
2. An optional independent test phase runs only after a strong gate acceptance.
   A separate model call sees the issue and *original* related code, never the
   patch. The generated script is stored under `.viberon/scratch/`; the
   harness executes it with the same local command permissions used for agent
   tests, against the original and patched trees. A fail-to-pass
   result adds evidence. A failure on the patch sends the solver one feedback
   pass; malformed or inconclusive generated tests are recorded but cannot
   overturn a verified fix. CLI users opt in with `--independent-test`, so
   routine runs do not silently spend another model call.
3. A portable arena reporter accepts JSONL result rows from comparative
   harness runs, de-duplicates retries by `(harness, instance_id)`, and ranks
   harnesses by resolved tasks, then token use, then time. It explicitly shows
   task coverage, so unequal subsets cannot masquerade as a fair ranking.

## Verification

Use focused red-green tests for each feature, then TypeScript, lint, and the
full test suite. Baseline had two unrelated failures: `cli.args` help launch
from another directory and a file watcher timing assertion.

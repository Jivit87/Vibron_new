/**
 * Verification API: find and run a repository's own checks, independently
 * of the model, and condense their output for the model's context.
 *
 *   detectVerifyCommands(root)            best first: tests, then fallbacks
 *   runVerification(root, cmd, options)   → VerificationReport (per-test outcomes)
 *   extractFailures(output, maxChars?)    tracebacks / assertion diffs / FAIL blocks + tail
 *   condenseOutput(output, exit, max?)    passing: head+tail; failing: failures+tail
 *   relatedTestFiles(root, changed, graph)
 *   relatedTestTargets(root, changedFiles, changedSymbols)  → smallest targeted command + time cap
 *   buildRepoEnv(root) / repoEnvPrelude   venv activation, python shim, no API keys
 *   runOnOriginalAndPatched(root, baseRef, command, opts)  → verdict fixes/regression/…
 */

export * from "@/lib/verify/types";
export { detectVerifyCommands, listRepoPaths, pytestAvailable, TEST_FILE_RE } from "@/lib/verify/detect";
export { execInRepo, runVerification, targetCommand, type ExecResult, type ShellRunner } from "@/lib/verify/run";
export { condenseOutput, extractFailures } from "@/lib/verify/extract";
export { relatedTestFiles } from "@/lib/verify/related";
export { buildRepoEnv, findRepoVenv, repoEnvPrelude, repoPathPrefix, which } from "@/lib/verify/env";
export { cleanOutput, parseTestOutput, type ParsedTests } from "@/lib/verify/parse";
export { isTestPath, relatedTestTargets, type RelatedTestOptions, type RelatedTestTargets } from "@/lib/verify/targets";

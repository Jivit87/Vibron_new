# Harness Integration Implementation Plan

> **For agentic workers:** Implement in this session with red-green tests and verify each task.

**Goal:** Integrate DeepSeek tool-loop compatibility, blind independent tests,
and comparative arena reporting into Vibron.

**Architecture:** Extend the existing provider and solver; add one focused test
writer module and a standalone arena reporter. Keep all generated tests in
Vibron scratch and preserve the existing patch gate.

**Tech Stack:** TypeScript, Next.js, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-09-27-harness-integration-design.md`

## Tasks

### 1. DeepSeek reasoning pass-back

- [x] Test DeepSeek pass-back and generic-key routing while preserving unrelated models.
- [x] Observe the tests fail.
- [x] Extend the OpenAI-compatible adapter and provider resolver.
- [x] Run focused tests and TypeScript.

### 2. Blind independent regression test

- [x] Test that the writer only sees original code, writes to scratch, and
  rejects malformed output; test fail-to-pass and still-failing classification.
- [x] Observe the tests fail.
- [x] Add `lib/harness/independent-test.ts` and solver integration; expose
  `--independent-test` in `cli/viberon.ts` and headless options.
- [x] Run focused tests and TypeScript.

### 3. Comparative arena report

- [x] Test retry de-duplication, common-task coverage, correctness-first
  ranking, token/time tie-breaks, and malformed rows.
- [x] Observe the tests fail.
- [x] Add `eval/arena.ts` and CLI `viberon arena report <results.jsonl>`.
- [x] Run focused tests and TypeScript.

### 4. Integration

- [x] Run `pnpm test`, `pnpm exec tsc --noEmit`, `pnpm lint`, and `pnpm build`.
- [ ] Review the diff, address introduced failures, commit the feature branch,
  and merge it into `main` as requested.

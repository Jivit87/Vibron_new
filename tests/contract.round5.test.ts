/**
 * Round 5 was built by three agents in parallel. Feed the engine's real
 * event shapes and the settings route's real response into the UI's real
 * readers, so a renamed field fails here instead of in the product.
 */

import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GET as keysGet } from "@/app/api/settings/keys/route";
import { claudeCliTesting } from "@/lib/ai/claude-cli";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import { normalizeProviderStatus } from "@/lib/client/providers";
import { normalizeIndependentTest, normalizePhase, PHASE_ORDER } from "@/lib/client/run-reducer";
import { resetMemoryStoreForTests } from "@/lib/store";

const saved = { bin: process.env.VIBERON_CLAUDE_BIN, deepseek: process.env.DEEPSEEK_API_KEY };
afterEach(() => {
  if (saved.bin === undefined) delete process.env.VIBERON_CLAUDE_BIN;
  else process.env.VIBERON_CLAUDE_BIN = saved.bin;
  if (saved.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = saved.deepseek;
  claudeCliTesting.reset();
  invalidateCredentialCache();
});

describe("engine events → run view", () => {
  it("reads every independent-test status and verdict the test writer emits", () => {
    // lib/harness/testwriter.ts emits: written, ran (verdict), gave_up; skipped from solve.
    for (const verdict of ["fixes", "passes", "still_failing", "regression", "inconclusive"]) {
      const read = normalizeIndependentTest({ type: "independent_test", status: "ran", command: "python t.py", verdict, seconds: 3 });
      expect(read?.status).toBe("ran");
      expect(read?.verdict).toBe(verdict === "passes" ? "pass" : verdict);
    }
    for (const status of ["written", "gave_up", "skipped"]) {
      expect(normalizeIndependentTest({ type: "independent_test", status })?.status).toBe(status);
    }
  });

  it("knows every phase the solver times", () => {
    // SolveResult.metrics.phaseMs keys from lib/harness/solve.ts.
    for (const name of ["setup", "localize", "criteria", "loop", "gate", "testWriter", "independentRun", "review"]) {
      expect(PHASE_ORDER).toContain(name);
      expect(normalizePhase({ type: "phase", name, ms: 12 })).toMatchObject({ name, ms: 12 });
    }
  });
});

describe("settings route → provider rows", () => {
  it("shows DeepSeek and a logged-in Claude CLI", async () => {
    resetMemoryStoreForTests();
    const dir = await mkdtemp(path.join(os.tmpdir(), "viberon-contract-cli-"));
    const bin = path.join(dir, "claude");
    await writeFile(bin, '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");\n');
    await chmod(bin, 0o755);
    process.env.VIBERON_CLAUDE_BIN = bin;
    process.env.DEEPSEEK_API_KEY = "sk-" + "a".repeat(32);
    claudeCliTesting.reset();
    invalidateCredentialCache();

    const status = normalizeProviderStatus(await (await keysGet()).json());
    expect(status.cli?.configured).toBe(true);
    expect(status.keys.find((k) => k.provider === "deepseek")).toMatchObject({ configured: true, fromEnv: true });
  });
});

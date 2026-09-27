import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildEvidence, evidenceChecks, moveScratch, redact, writeEvidenceBundle } from "@/lib/headless/evidence";
import { emptySolveResult } from "@/lib/headless/run";
import type { VerificationReport } from "@/lib/verify/types";

const report = (exitCode: number, passed: number, failed: number): VerificationReport => ({
  command: "npm test",
  kind: "test",
  exitCode,
  timedOut: false,
  durationMs: 10,
  parsed: true,
  tests: {},
  counts: { passed, failed, errors: 0, skipped: 0 },
  failureExcerpt: "",
  outputTail: "",
});

function resolved() {
  const r = emptySolveResult("resolved");
  r.summary = "add() subtracted <b>";
  r.diff = "diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-a - b\n+a + b\n";
  r.gate = {
    ...r.gate,
    enabled: true,
    command: "npm test",
    baseline: report(1, 1, 1),
    final: report(0, 2, 0),
    fixed: ["adds"],
    ranAfterLastEdit: true,
    reason: "verified",
  };
  r.metrics = { ...r.metrics, inputTokens: 1200, cacheReadTokens: 800, outputTokens: 90, modelCalls: 4, durationMs: 12_345 };
  r.independentTest = { status: "fixes", command: "node t.js" };
  return r;
}

const base = {
  taskId: "t1",
  task: "add() is wrong\nmore",
  repo: "/r",
  model: "m",
  exitCode: 0,
  startedAt: "2026-01-01T00:00:00Z",
  verifyCommands: [],
};

describe("evidence bundle", () => {
  it("derives before/after verdicts for the gate, per-test fixes and the independent test", () => {
    const checks = evidenceChecks(resolved());
    expect(checks.map((c) => [c.origin, c.verdict])).toEqual([
      ["gate", "fixes"],
      ["test", "fixes"],
      ["independent", "fixes"],
    ]);
    const r = resolved();
    r.gate.newFailures = ["zero"];
    expect(evidenceChecks(r)[0]!.verdict).toBe("regression");
  });

  it("never writes a key", () => {
    const env = { AI_API_KEY: "abcdefghijklmnop123" };
    const out = redact({ apiKey: "x", note: "used abcdefghijklmnop123 and sk-ant-0123456789abcdef", n: 3 }, env);
    expect(out).toEqual({ note: "used [redacted] and [redacted]", n: 3 });
    const ev = buildEvidence({ ...base, result: resolved(), config: { apiKey: "sk-ant-zzzzzzzzzzzzzzzz" } });
    expect(JSON.stringify(ev)).not.toContain("sk-ant-");
    expect(ev.usage).toMatchObject({ inputTokens: 1200, cachedTokens: 800, outputTokens: 90, modelCalls: 4 });
    expect(ev.title).toBe("add() is wrong");
  });

  it("writes evidence.json, report.html, moves scratch and indexes runs", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "viberon-ev-"));
    await mkdir(path.join(repo, ".viberon", "scratch"), { recursive: true });
    await writeFile(path.join(repo, ".viberon", "scratch", "repro.js"), "1");
    const outDir = path.join(repo, ".viberon", "runs", "t1");
    await mkdir(outDir, { recursive: true });
    await writeEvidenceBundle({ ...base, result: resolved(), outDir, workRoot: repo, scratchRel: ".viberon/scratch" });
    expect(JSON.parse(readFileSync(path.join(outDir, "evidence.json"), "utf8")).status).toBe("resolved");
    const html = readFileSync(path.join(outDir, "report.html"), "utf8");
    expect(html).toContain("VERIFIED FIX");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain('class="add"');
    expect(existsSync(path.join(outDir, "scratch", "repro.js"))).toBe(true);
    expect(existsSync(path.join(repo, ".viberon", "scratch"))).toBe(false);
    expect(readFileSync(path.join(repo, ".viberon", "runs", "index.html"), "utf8")).toContain("t1/report.html");
    expect(await moveScratch(repo, ".viberon/scratch", outDir)).toBe(0);
  });
});

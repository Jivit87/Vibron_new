import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetMemoryStoreForTests, putGraph, putFileInfo } from "@/lib/store";
import { parseRepo } from "@/lib/parser";
import { MAX_CONCURRENCY } from "@/lib/limits";
import type { OrchestrationInput } from "@/lib/agents/orchestrator";

/**
 * The route clamps `concurrency` before it ever reaches the orchestrator, so
 * this mocks `orchestrate` to capture exactly what the route decided to pass
 * through — the same value the orchestrator uses to size a wave's worker
 * pool (see tests/harness.orchestrator.test.ts for proof that value is
 * honoured end to end).
 */
const orchestrateMock = vi.fn(async (input: OrchestrationInput) => {
  input.emit({
    type: "run_done",
    status: "done",
    summary: "ok",
    filesChanged: 0,
    durationMs: 0,
    costUsd: 0,
  });
});

vi.mock("@/lib/agents/orchestrator", () => ({
  orchestrate: (input: OrchestrationInput) => orchestrateMock(input),
}));

async function postAgent(body: Record<string, unknown>): Promise<Response> {
  const { POST } = await import("@/app/api/agent/route");
  return POST(
    new Request("http://localhost/api/agent", {
      method: "POST",
      body: JSON.stringify({ repoKey: "concurrency-test", prompt: "add a feature", ...body }),
    }),
  );
}

describe("POST /api/agent — concurrency clamping", () => {
  beforeEach(async () => {
    orchestrateMock.mockClear();
    resetMemoryStoreForTests();
    const parsed = parseRepo(
      [{ path: "src/app.ts", source: "export function app() {\n  return 1;\n}\n" }],
      "owner/repo@main",
    );
    await putGraph("concurrency-test", parsed.graph);
    await putFileInfo("concurrency-test", [{ path: "src/app.ts", tokenCount: 10 }]);
  });

  it("passes concurrency 10 through unchanged", async () => {
    const response = await postAgent({ concurrency: 10 });
    expect(response.status).toBe(200);
    await response.text();
    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    expect(orchestrateMock.mock.calls[0][0].concurrency).toBe(10);
  });

  it("clamps 11 and above down to the ceiling of 10", async () => {
    for (const requested of [11, 50, 9999]) {
      orchestrateMock.mockClear();
      const response = await postAgent({ concurrency: requested });
      await response.text();
      expect(orchestrateMock.mock.calls[0][0].concurrency).toBe(MAX_CONCURRENCY);
    }
  });

  it("falls back to the default of 3 for 0, NaN, and non-numeric input", async () => {
    for (const requested of [0, Number.NaN, "not-a-number"]) {
      orchestrateMock.mockClear();
      const response = await postAgent({ concurrency: requested });
      await response.text();
      expect(orchestrateMock.mock.calls[0][0].concurrency).toBe(3);
    }
  });

  it("floors a negative value at 1 (falsy-vs-invalid is `0`/NaN only, not sign)", async () => {
    const response = await postAgent({ concurrency: -5 });
    await response.text();
    expect(orchestrateMock.mock.calls[0][0].concurrency).toBe(1);
  });
});

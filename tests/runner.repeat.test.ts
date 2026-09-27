/**
 * Per-turn overhead: a call that repeats an earlier identical call and gets
 * byte-identical long output is answered with a one-line pointer, so failure
 * loops stop re-sending the same log on every later turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "@/lib/agents/runner";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

let ws: TestWorkspace;
const source = Array.from({ length: 60 }, (_, i) => `export const value${i} = "needle number ${i}";`).join("\n") + "\n";
beforeEach(async () => {
  ws = await makeWorkspace([{ path: "src/big.ts", source }]);
});
afterEach(() => uninstallFakeProvider());

describe("repeated tool output", () => {
  it("replaces an identical repeat with a pointer", async () => {
    const grep = { name: "grep", input: { pattern: "needle" } };
    const fake = installFakeProvider([{ calls: [grep] }, { calls: [grep] }, { text: "Done." }]);
    const log = eventLog();
    const result = await runAgent({
      agentId: "solo",
      stepId: "solo",
      role: "generalist",
      model: "claude-opus-5",
      task: "Find the needles.",
      files: [],
      handle: ws.handle,
      engine: ws.engine,
      memory: ws.memory,
      commandPolicy: "never",
      emit: log.emit,
    });
    expect(result.error).toBeUndefined();
    const last = fake.requests[2]!.messages;
    const results = last.flatMap((m) => m.content).filter((b) => b.type === "tool_result") as { content: string }[];
    expect(results).toHaveLength(2);
    expect(results[0]!.content.length).toBeGreaterThan(400);
    expect(results[1]!.content).toMatch(/Identical to the output of your same grep call at step 1/);
    expect(results[1]!.content.length).toBeLessThan(results[0]!.content.length / 3);
    expect(result.metrics?.tokensElided).toBeGreaterThan(0);
  });
});

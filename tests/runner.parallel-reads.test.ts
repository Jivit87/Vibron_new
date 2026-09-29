/**
 * A turn's leading read-only calls start together; every result still comes
 * back in call order, and a read after a write in the same turn sees it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "@/lib/agents/runner";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace([
    { path: "src/a.ts", source: 'export const alpha = "first";\n' },
    { path: "src/b.ts", source: 'export const beta = "second";\n' },
  ]);
});
afterEach(() => uninstallFakeProvider());

describe("parallel read-only tool calls", () => {
  it("keeps call order and runs reads after a write sequentially", async () => {
    const fake = installFakeProvider([
      {
        calls: [
          { name: "grep", input: { pattern: "alpha" } },
          { name: "grep", input: { pattern: "beta" } },
          { name: "create_file", input: { path: "src/c.ts", content: 'export const gamma = "third";\n' } },
          { name: "view", input: { path: "src/c.ts" } },
        ],
      },
      { text: "Done." },
    ]);
    const log = eventLog();
    const result = await runAgent({
      agentId: "solo",
      stepId: "solo",
      role: "generalist",
      model: "claude-opus-5",
      task: "Look around, then add gamma.",
      files: [],
      handle: ws.handle,
      engine: ws.engine,
      memory: ws.memory,
      commandPolicy: "never",
      emit: log.emit,
    });
    expect(result.error).toBeUndefined();
    const results = fake.requests[1]!.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result") as { content: string }[];
    expect(results).toHaveLength(4);
    expect(results[0]!.content).toMatch(/alpha/);
    expect(results[0]!.content).not.toMatch(/beta/);
    expect(results[1]!.content).toMatch(/beta/);
    expect(results[3]!.content).toMatch(/gamma/);
  });
});

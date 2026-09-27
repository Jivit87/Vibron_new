/**
 * Prompt-cache safety (W5): what the runner sends each turn must extend the
 * previous request byte for byte (system blocks, tools, then every earlier
 * message), except at a compaction or prune boundary. A rewrite anywhere in
 * the prefix makes the provider re-bill the whole transcript at the
 * uncached (or cache-write) price.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent, type AgentRunInput } from "@/lib/agents/runner";
import type { AiTurnRequest } from "@/lib/ai/types";
import { installFakeProvider, uninstallFakeProvider, type ScriptedTurn } from "./helpers/fake-provider";
import { eventLog, makeWorkspace, type TestWorkspace } from "./helpers/harness-workspace";

let ws: TestWorkspace;
beforeEach(async () => {
  ws = await makeWorkspace([{ path: "src/app.ts", source: "export function app() {\n  return 1;\n}\n" }]);
});
afterEach(() => uninstallFakeProvider());

function input(log: ReturnType<typeof eventLog>, overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    agentId: "solo",
    stepId: "solo",
    role: "generalist",
    model: "claude-opus-5",
    task: "Work on the app.",
    files: [],
    handle: ws.handle,
    engine: ws.engine,
    memory: ws.memory,
    commandPolicy: "never",
    emit: log.emit,
    ...overrides,
  };
}

/** Indices i where request i does not extend request i-1 byte for byte. */
function prefixBreaks(requests: AiTurnRequest[]): number[] {
  const breaks: number[] = [];
  for (let i = 1; i < requests.length; i += 1) {
    const [prev, next] = [requests[i - 1], requests[i]];
    const same =
      JSON.stringify(prev.system) === JSON.stringify(next.system) &&
      JSON.stringify(prev.tools) === JSON.stringify(next.tools) &&
      next.messages.length > prev.messages.length &&
      prev.messages.every((m, j) => JSON.stringify(m) === JSON.stringify(next.messages[j]));
    if (!same) breaks.push(i);
  }
  return breaks;
}

describe("prompt-cache prefix", () => {
  it("is byte-identical across turns that read, create and edit files", async () => {
    const fake = installFakeProvider([
      { calls: [{ name: "read_file", input: { path: "src/app.ts" } }] },
      { calls: [{ name: "write_file", input: { path: "src/extra.ts", content: "export function extra() {\n  return 3;\n}\n" } }] },
      { calls: [{ name: "edit_file", input: { path: "src/app.ts", find: "return 1", replace: "return 2", summary: "bump" } }] },
      { calls: [{ name: "read_file", input: { path: "src/app.ts" } }] },
      { text: "Done." },
    ]);
    const log = eventLog();
    const result = await runAgent(input(log));
    expect(result.error).toBeUndefined();
    expect(fake.requests).toHaveLength(5);
    // New symbols changed the graph mid-run; the cached system prefix must not follow it.
    expect(prefixBreaks(fake.requests)).toEqual([]);
    expect(log.of("compaction")).toEqual([]);
  });

  it("rewrites the prefix only at the one prune that frees enough to pay for it", async () => {
    // Five 20k-character writes (~5k tokens each) push the transcript past the prune trigger once.
    const big = (n: number) => `// file ${n}\n${"x".repeat(20_000)}\n`;
    const turns: ScriptedTurn[] = [];
    for (let n = 0; n < 5; n += 1) turns.push({ calls: [{ name: "write_file", input: { path: `src/big${n}.ts`, content: big(n) } }] });
    for (let n = 0; n < 4; n += 1) turns.push({ calls: [{ name: "read_file", input: { path: "src/app.ts" } }] });
    turns.push({ text: "Done." });
    const fake = installFakeProvider(turns);
    const log = eventLog();
    await runAgent(input(log, { maxIterations: 20 }));

    const compactions = log.of("compaction");
    expect(compactions).toHaveLength(1);
    const breaks = prefixBreaks(fake.requests);
    expect(breaks).toHaveLength(1);
    // Every other consecutive pair extends the previous request exactly.
    expect(fake.requests.length - 1 - breaks.length).toBeGreaterThanOrEqual(7);
  });
});

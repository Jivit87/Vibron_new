/**
 * Stop must be processed promptly while a large workspace is being scanned
 * and indexed: DELETE /api/tasks/:id and POST /api/agent/cancel answer in
 * under 200 ms, the event loop never stalls long, and the indexing itself
 * stops at the next slice instead of running to completion.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { parseStats } from "@/lib/parser";
import { resetMemoryStoreForTests } from "@/lib/store";
import { TaskQueue, type Task } from "@/lib/tasks";
import { clearGraphIndexCache } from "@/lib/workspace/graph-index";

const FILES = 1500;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "viberon-responsive-"));
  for (let i = 0; i < FILES; i += 1) {
    const dir = path.join(root, "src", `p${i % 30}`);
    await mkdir(dir, { recursive: true });
    const dep = (i * 7 + 3) % FILES;
    const body = Array.from(
      { length: 10 },
      (_, f) => `export function f${i}_${f}(x: number): number {\n  return x > ${f} ? h${dep}(x - 1) + f${i}_${(f + 1) % 10}(x - 2) : ${f};\n}`,
    ).join("\n");
    await writeFile(path.join(dir, `m${i}.ts`), `import { h${dep} } from "../p${dep % 30}/m${dep}";\n${body}\nexport function h${i}(n: number) { return n + ${i}; }\n`);
  }
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Time from a request's arrival (its timer is due) until its handler resolved. */
function requestAt(delayMs: number, handler: () => Promise<Response>): Promise<{ ms: number; response: Response }> {
  return new Promise((resolve, reject) => {
    const due = performance.now() + delayMs;
    setTimeout(() => {
      handler().then((response) => resolve({ ms: performance.now() - due, response }), reject);
    }, delayMs);
  });
}

describe("Stop while a large workspace indexes", () => {
  it("DELETE /api/tasks/:id and POST /api/agent/cancel answer in < 200 ms; indexing stops", async () => {
    resetMemoryStoreForTests();
    clearGraphIndexCache();
    let indexStopped: unknown = null;
    let parsedAtStop = 0;
    const queue = new TaskQueue(
      {
        fix: async (_task: Task, { signal }) => {
          try {
            await registerLocalWorkspace(root, {}, { signal });
          } catch (error) {
            indexStopped = error;
          }
          return signal.aborted ? { error: "Stopped." } : {};
        },
        review: async () => ({}),
      },
      { storeKey: "responsive:tasks" },
    );
    const G = globalThis as { __viberonTaskQueue?: TaskQueue };
    const previous = G.__viberonTaskQueue;
    G.__viberonTaskQueue = queue;
    try {
      const tasksRoute = await import("@/app/api/tasks/[id]/route");
      const cancelRoute = await import("@/app/api/agent/cancel/route");
      const histogram = monitorEventLoopDelay({ resolution: 5 });
      const parsedBefore = parseStats.filesParsed;
      const task = await queue.enqueue({ kind: "fix", repoKey: "responsive", task: "x", source: "api" });
      // Stop lands while files are being parsed (after the scan).
      for (let i = 0; i < 2000 && parseStats.filesParsed - parsedBefore < 20; i += 1) await new Promise((r) => setTimeout(r, 5));
      histogram.enable();
      const agentCancel = requestAt(5, () =>
        cancelRoute.POST(new Request("http://x/api/agent/cancel", { method: "POST", body: JSON.stringify({ runId: `${task.id}-1` }) })),
      );
      const stop = requestAt(10, async () => {
        const response = await tasksRoute.DELETE(new Request(`http://x/api/tasks/${task.id}`, { method: "DELETE" }), {
          params: Promise.resolve({ id: task.id }),
        });
        parsedAtStop = parseStats.filesParsed - parsedBefore;
        return response;
      });
      const [cancelled, stopped] = await Promise.all([agentCancel, stop]);
      const stopAt = performance.now();
      await queue.idle();
      const unwindMs = performance.now() - stopAt;
      histogram.disable();

      expect(cancelled.response.status).toBe(200);
      expect(stopped.response.status).toBe(200);
      expect(cancelled.ms).toBeLessThan(200);
      expect(stopped.ms).toBeLessThan(200);
      // No stall anywhere near the old multi-second freezes (GC headroom under a loaded test run).
      expect(histogram.max / 1e6).toBeLessThan(250);
      // Stopped mid-index (not after parsing every file), and quickly.
      expect(parsedAtStop).toBeGreaterThan(0);
      expect(parsedAtStop).toBeLessThan(FILES);
      expect(indexStopped).toBeTruthy();
      expect(unwindMs).toBeLessThan(500);
      expect(await queue.get(task.id)).toMatchObject({ state: "cancelled" });
    } finally {
      G.__viberonTaskQueue = previous;
    }
  });
});

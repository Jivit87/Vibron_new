/**
 * The browser client and the deliver routes were built in parallel against a
 * written contract. These tests feed the client's real payloads into the
 * server's real parsers, so a renamed field fails here instead of silently
 * disabling a safety rule.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverPr, deliveryEvidence, normalizeCi, normalizeRerun } from "@/lib/client/deliver";
import type { Evidence } from "@/lib/client/run-reducer";
import { parseEvidence } from "@/lib/deliver/report";

afterEach(() => vi.unstubAllGlobals());

function capture(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: "stop", code: "workflow_changes" }), { status: 409 });
    }),
  );
  return { bodies };
}

describe("client ↔ deliver routes", () => {
  it("deliver sends the fields the server enforces", async () => {
    const { bodies } = capture();
    const base = { repoKey: "k", branch: "viberon/x", title: "t", body: "b", draft: true, files: ["a.py"] };
    const refused = await deliverPr(base);
    expect(refused).toMatchObject({ ok: false, needsConfirm: true });
    await deliverPr({ ...base, confirm: true });

    // app/api/deliver/route.ts reads expectedFiles and allowWorkflowChanges.
    expect(bodies[0]).toMatchObject({ expectedFiles: ["a.py"] });
    expect(bodies[0]).not.toHaveProperty("allowWorkflowChanges");
    expect(bodies[1]).toMatchObject({ expectedFiles: ["a.py"], allowWorkflowChanges: true });
  });

  it("the issue report evidence parses on the server", () => {
    const evidence = {
      outcome: "verified",
      final: { checks: [{ name: "python -m pytest tests/test_x.py", verdict: "fixes", before: "1 failed", after: "1 passed" }] },
    } as unknown as Evidence;
    const sent = deliveryEvidence(evidence, ["pkg/x.py"]);
    expect(parseEvidence(sent)).toEqual({
      status: "resolved",
      filesChanged: ["pkg/x.py"],
      checks: [{ command: "python -m pytest tests/test_x.py", original: "1 failed", patched: "1 passed", verdict: "fixes" }],
    });
  });

  it("CI status keeps the server's extracted fix task", () => {
    const ci = normalizeCi({
      headSha: "abc",
      state: "failure",
      checks: [{ name: "test", status: "completed", conclusion: "failure", url: "u" }],
      fixTask: "CI failed on abc:\n- test: AssertionError",
    });
    expect(ci?.fixTask).toContain("AssertionError");
  });

  it("re-run responses give the UI its count and limit", () => {
    // app/api/ci/rerun returns { ok, attempt, remaining } (MAX_RERUNS_PER_HEAD = 3).
    expect(normalizeRerun({ ok: true, attempt: 1, remaining: 2 }, 200)).toMatchObject({ reruns: 1, limit: 3 });
  });
});

describe("Stop and usage: client ↔ tasks routes", () => {
  function stubWindow() {
    vi.stubGlobal("window", {
      location: { search: "" },
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0) as unknown as number,
      cancelAnimationFrame: (id: number) => clearTimeout(id),
      sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    });
  }

  it("Stop on a task shown in the run view cancels the task on the server and ends the view as stopped", async () => {
    stubWindow();
    const calls: { url: string; method: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET" });
        if (url === "/api/tasks/t1/events") {
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "run_start", runId: "t1", mode: "single", model: "m", at: 1 })}\n\n`));
              init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
            },
          });
          return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
        }
        if (url === "/api/tasks/t1" && init?.method === "DELETE") return Response.json({ id: "t1", state: "running" });
        return new Response("{}", { status: 404 });
      }),
    );
    const { attachTaskRun, cancelRun } = await import("@/lib/client/agent-stream");
    const { useViberon } = await import("@/store/viberon");
    const attached = attachTaskRun({ id: "t1", task: "Fix #1" });
    for (let i = 0; i < 100 && !useViberon.getState().run?.id; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(useViberon.getState().streaming).toBe(true);
    await cancelRun();
    await attached;
    expect(calls).toContainEqual({ url: "/api/tasks/t1", method: "DELETE" });
    expect(calls.some((c) => c.url === "/api/agent/cancel")).toBe(false);
    expect(useViberon.getState().streaming).toBe(false);
    expect(useViberon.getState().run?.status).toBe("cancelled");
  });

  it("an attached stream that ends without run_done takes the task's real final state", async () => {
    stubWindow();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/tasks/t2/events") {
          return new Response(`data: ${JSON.stringify({ type: "run_start", runId: "t2", mode: "single", model: "m", at: 1 })}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url === "/api/tasks/t2") return Response.json({ id: "t2", state: "failed", error: "boom" });
        return new Response("{}", { status: 404 });
      }),
    );
    const { attachTaskRun } = await import("@/lib/client/agent-stream");
    const { useViberon } = await import("@/store/viberon");
    await attachTaskRun({ id: "t2", task: "x" });
    expect(useViberon.getState().run?.status).toBe("failed");
  });

  it("task rows carry live and final usage as '48.2k tok · $0.07'", async () => {
    const { normalizeTasks, taskUsageLine } = await import("@/lib/client/deliver");
    const { normalizeIssues } = await import("@/lib/client/issues");
    const rows = normalizeTasks({
      tasks: [
        // GET /api/tasks: live usage from the server.
        { id: "a", kind: "fix", repoKey: "k", task: "t", source: "ui", state: "running", createdAt: 1, usage: { inputTokens: 40_000, outputTokens: 2_200, cacheReadTokens: 6_000, cacheWriteTokens: 0, costUsd: 0.0712, calls: 3 } },
        // A task stored before usage was recorded: its result's metrics.
        { id: "b", kind: "fix", repoKey: "k", task: "t", source: "ui", state: "done", createdAt: 1, result: { metrics: { inputTokens: 900, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002 } } },
        { id: "c", kind: "review", repoKey: "k", task: "t", source: "ui", state: "queued", createdAt: 2 },
      ],
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(taskUsageLine(byId.get("a")!.usage)).toBe("48.2k tok · $0.07");
    expect(taskUsageLine(byId.get("b")!.usage)).toBe("950 tok · $0.0020");
    expect(taskUsageLine(byId.get("c")!.usage)).toBe("");
    // The issues route's rows carry the same usage for the Issues panel.
    const list = normalizeIssues({
      issues: [{ number: 1, title: "t", url: "u", labels: [], author: null, comments: 0, updatedAt: 0, task: { id: "a", state: "running", usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } } }],
    });
    expect(taskUsageLine(list.issues[0]!.task!.usage)).toBe("1k tok · $0.01");
  });
});

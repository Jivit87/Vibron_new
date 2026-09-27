/** The task queue: FIFO per repo, persistence, interrupted recovery, event replay, and the routes. */

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { getValueRaw, resetMemoryStoreForTests, setValueRaw } from "@/lib/store";
import { TaskQueue, type Task, type TaskKind, type TaskRunner } from "@/lib/tasks";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { runReviewTask } from "@/lib/tasks/runners";
import { makeTmpRepo } from "@/tests/helpers/tmp-repo";

process.env.VIBERON_STORE = "memory";

interface Gate {
  task: Task;
  emit: (event: OrchestrationEvent) => void;
  signal: AbortSignal;
  finish: (error?: string) => void;
}

/** Runners that record their start order and wait until the test releases them. */
function controlledRunners() {
  const started: Gate[] = [];
  const runner: TaskRunner = (task, ctx) =>
    new Promise((resolve, reject) => {
      ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
      started.push({ task, ...ctx, finish: (error) => resolve(error ? { error } : { note: "ok" }) });
    });
  const runners: Record<TaskKind, TaskRunner> = { fix: runner, review: runner };
  return { started, runners };
}

const tick = () => new Promise((r) => setTimeout(r, 5));
const input = (repoKey: string, task: string) => ({ kind: "fix" as const, repoKey, task, source: "api" as const });
const event = (n: number): OrchestrationEvent => ({ type: "error", message: `e${n}`, fatal: false });

let key: string;
beforeEach(() => {
  resetMemoryStoreForTests();
  key = `tasks:test:${randomUUID()}`;
});

describe("TaskQueue", () => {
  it("runs FIFO with one running task per repo", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    const a1 = await q.enqueue(input("A", "a1"));
    const a2 = await q.enqueue(input("A", "a2"));
    const b1 = await q.enqueue(input("B", "b1"));
    const a3 = await q.enqueue(input("A", "a3"));
    await tick();
    expect(started.map((s) => s.task.task)).toEqual(["a1", "b1"]);
    expect((await q.get(a2.id))!.state).toBe("queued");

    started[0]!.finish();
    await tick();
    expect(started.map((s) => s.task.task)).toEqual(["a1", "b1", "a2"]);
    expect((await q.get(a1.id))!.state).toBe("done");

    started[2]!.finish("boom");
    started[1]!.finish();
    await tick();
    expect((await q.get(a2.id))).toMatchObject({ state: "failed", error: "boom" });
    expect((await q.get(b1.id))!.state).toBe("done");
    expect(started[3]!.task.id).toBe(a3.id);
    started[3]!.finish();
    await q.idle();

    const stored = await getValueRaw<Task[]>(key);
    expect(stored!.map((t) => [t.task, t.state])).toEqual([
      ["a1", "done"],
      ["a2", "failed"],
      ["b1", "done"],
      ["a3", "done"],
    ]);
  });

  it("cancels queued tasks at once and aborts running ones", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    const running = await q.enqueue(input("A", "one"));
    const queued = await q.enqueue(input("A", "two"));
    await tick();
    expect((await q.cancel(queued.id))!.state).toBe("cancelled");
    await q.cancel(running.id);
    await q.idle();
    expect((await q.get(running.id))!.state).toBe("cancelled");
    expect(started).toHaveLength(1);
    expect(await q.cancel("nope")).toBeNull();
  });

  it("recovers from a restart: running → failed(interrupted), queued resumes", async () => {
    const now = Date.now();
    const base = { kind: "fix", repoKey: "A", source: "ui", createdAt: now } as const;
    await setValueRaw(key, [
      { ...base, id: "r", task: "was running", state: "running", startedAt: now },
      { ...base, id: "q", task: "was queued", state: "queued" },
    ]);
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    expect(await q.get("r")).toMatchObject({ state: "failed", error: "interrupted" });
    await tick();
    expect(started.map((s) => s.task.id)).toEqual(["q"]);
    started[0]!.finish();
    await q.idle();
    expect((await getValueRaw<Task[]>(key))!.map((t) => t.state)).toEqual(["failed", "done"]);
  });

  it("replays buffered events to a late subscriber, then the live tail, then ends", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key, maxEvents: 5 });
    const task = await q.enqueue(input("A", "x"));
    await tick();
    for (let n = 1; n <= 8; n += 1) started[0]!.emit(event(n));

    const seen: string[] = [];
    let ended = false;
    await q.subscribe(task.id, (e) => seen.push((e as { message: string }).message), () => (ended = true));
    // Bounded: the first event plus the newest tail.
    expect(seen).toEqual(["e1", "e5", "e6", "e7", "e8"]);
    started[0]!.emit(event(9));
    expect(seen.at(-1)).toBe("e9");
    expect(ended).toBe(false);
    started[0]!.finish();
    await q.idle();
    expect(ended).toBe(true);

    const replay: string[] = [];
    let endedLate = false;
    await q.subscribe(task.id, (e) => replay.push((e as { message: string }).message), () => (endedLate = true));
    expect(replay).toEqual(["e1", "e6", "e7", "e8", "e9"]);
    expect(endedLate).toBe(true);
    expect(await q.subscribe("nope", () => {}, () => {})).toBeNull();
  });

  it("fails a review task clearly when there is nothing to review", async () => {
    const repo = makeTmpRepo({ "a.txt": "a\n" });
    try {
      const { repoKey } = await registerLocalWorkspace(repo.root);
      const q = new TaskQueue({ fix: runReviewTask, review: runReviewTask }, { storeKey: key });
      const task = await q.enqueue({ kind: "review", repoKey, task: "review my changes", source: "ui" });
      await q.idle();
      expect(await q.get(task.id)).toMatchObject({ state: "failed", error: expect.stringContaining("Nothing to review") });
    } finally {
      repo.cleanup();
    }
  });
});

describe("tasks routes", () => {
  it("enqueues, lists, streams events as SSE and rejects bad input", async () => {
    const { started, runners } = controlledRunners();
    (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue = new TaskQueue(runners, { storeKey: key });
    const { POST, GET } = await import("@/app/api/tasks/route");
    const events = await import("@/app/api/tasks/[id]/events/route");
    const del = await import("@/app/api/tasks/[id]/route");
    const post = (body: unknown) => POST(new Request("http://x/api/tasks", { method: "POST", body: JSON.stringify(body) }));

    expect((await post({ kind: "deploy", repoKey: "A", task: "x" })).status).toBe(400);
    expect((await post({ kind: "review", repoKey: "A" })).status).toBe(400);
    expect((await post({ kind: "review", repoKey: "A", task: "x", issueUrl: "https://example.com/1" })).status).toBe(400);
    expect((await post({ kind: "fix", repoKey: "not-on-disk", task: "x" })).status).toBe(400);

    const created = await post({ kind: "review", repoKey: "A", task: "look at this", source: "ui" });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    expect(task).toMatchObject({ kind: "review", repoKey: "A", source: "ui" });
    const list = (await (await GET(new Request("http://x/api/tasks?repoKey=A"))).json()) as { tasks: Task[] };
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);

    await tick();
    started[0]!.emit({ type: "run_start", runId: task.id, mode: "single", model: "m", at: 1 });
    const params = { params: Promise.resolve({ id: task.id }) };
    const response = await events.GET(new Request("http://x"), params);
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    started[0]!.emit(event(2));
    started[0]!.finish();
    const text = await response.text();
    expect(text).toContain(`data: {"type":"run_start","runId":"${task.id}"`);
    expect(text).toContain('data: {"type":"error","message":"e2"');

    expect((await del.DELETE(new Request("http://x"), params)).status).toBe(409);
    const missing = { params: Promise.resolve({ id: "nope" }) };
    expect((await events.GET(new Request("http://x"), missing)).status).toBe(404);
    delete (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue;
  });
});

describe("Stop and usage", () => {
  const usage = (n: number): OrchestrationEvent => ({
    type: "turn_usage",
    agentId: "solver",
    model: "m",
    inputTokens: 1000 * n,
    outputTokens: 100 * n,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01 * n,
    uncachedUsd: 0.01 * n,
    contextTokens: 0,
    at: n,
  });

  it("Stop all cancels the repo's queued tasks before they start and aborts the running one", async () => {
    const { started, runners } = controlledRunners();
    const cancelled: string[] = [];
    const q = new TaskQueue(runners, { storeKey: key, onCancel: (t) => cancelled.push(t.id) });
    const running = await q.enqueue(input("A", "one"));
    const queued = await q.enqueue(input("A", "two"));
    const other = await q.enqueue(input("B", "other repo"));
    await tick();
    const stopped = await q.cancelAll("A");
    expect(stopped.map((t) => t.id).sort()).toEqual([running.id, queued.id].sort());
    await tick();
    expect((await q.get(running.id))!.state).toBe("cancelled");
    expect((await q.get(queued.id))!.state).toBe("cancelled");
    // The queued task never started; the other repo is untouched.
    expect(started.map((s) => s.task.id)).toEqual([running.id, other.id]);
    expect(cancelled).toEqual([running.id]);
    expect((await q.get(other.id))!.state).toBe("running");
    started[1]!.finish();
    await q.idle();
  });

  it("a runner that ignores Stop is finished as cancelled after the grace period, and the next task starts", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const stubborn: TaskRunner = (task) => {
      started.push(task.task);
      if (task.task === "stuck") return new Promise((resolve) => (release = () => resolve({ prUrl: "https://github.com/o/r/pull/9" })));
      return Promise.resolve({});
    };
    const q = new TaskQueue({ fix: stubborn, review: stubborn }, { storeKey: key, cancelGraceMs: 50 });
    const stuck = await q.enqueue(input("A", "stuck"));
    await q.enqueue(input("A", "next"));
    await tick();
    const at = Date.now();
    await q.cancel(stuck.id);
    for (let i = 0; i < 100 && (await q.get(stuck.id))!.state === "running"; i += 1) await tick();
    expect(Date.now() - at).toBeLessThan(2_000);
    expect(await q.get(stuck.id)).toMatchObject({ state: "cancelled" });
    await tick();
    expect(started).toEqual(["stuck", "next"]);
    // Its late outcome is dropped: a stopped task never reports a PR.
    release();
    await q.idle();
    expect((await q.get(stuck.id))!.prUrl).toBeUndefined();
    expect((await q.get(stuck.id))!.state).toBe("cancelled");
  });

  it("ends an attached run view with run_done{cancelled} when the task is stopped", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    const task = await q.enqueue(input("A", "x"));
    await tick();
    started[0]!.emit({ type: "run_start", runId: task.id, mode: "single", model: "m", at: 1 });
    const seen: OrchestrationEvent[] = [];
    await q.subscribe(task.id, (e) => seen.push(e), () => undefined);
    await q.cancel(task.id);
    await q.idle();
    expect(seen.at(-1)).toMatchObject({ type: "run_done", status: "cancelled" });
  });

  it("tracks token use live from turn_usage events and persists the final numbers", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    const task = await q.enqueue(input("A", "x"));
    await tick();
    started[0]!.emit(usage(2));
    started[0]!.emit(usage(3));
    expect((await q.get(task.id))!.usage).toEqual({
      inputTokens: 5000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.05,
      calls: 2,
    });
    started[0]!.finish();
    await q.idle();
    // A fresh queue (a restart) reads the persisted usage.
    const reloaded = new TaskQueue(controlledRunners().runners, { storeKey: key });
    expect((await reloaded.get(task.id))!.usage?.costUsd).toBe(0.05);
  });

  it("prefers the solve's own metrics when they account for more (calls outside the runner)", async () => {
    const runner: TaskRunner = async (_task, ctx) => {
      ctx.emit(usage(1));
      return {
        result: { status: "resolved", metrics: { inputTokens: 4000, outputTokens: 400, cacheReadTokens: 1000, cacheWriteTokens: 0, costUsd: 0.2, modelCalls: 4 } } as never,
      };
    };
    const q = new TaskQueue({ fix: runner, review: runner }, { storeKey: key });
    const task = await q.enqueue(input("A", "x"));
    await q.idle();
    expect((await q.get(task.id))!.usage).toMatchObject({ inputTokens: 4000, costUsd: 0.2, calls: 4 });
  });

  it("routes: GET keeps live usage; GET :id returns the task; DELETE ?repoKey stops all", async () => {
    const { started, runners } = controlledRunners();
    const q = new TaskQueue(runners, { storeKey: key });
    (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue = q;
    try {
      const { GET, DELETE } = await import("@/app/api/tasks/route");
      const one = await import("@/app/api/tasks/[id]/route");
      const a = await q.enqueue(input("A", "a"));
      const b = await q.enqueue(input("A", "b"));
      await tick();
      started[0]!.emit(usage(1));
      const list = (await (await GET(new Request("http://x/api/tasks?repoKey=A"))).json()) as { tasks: Task[] };
      expect(list.tasks[0]).toMatchObject({ id: a.id, usage: { costUsd: 0.01 } });
      expect((await DELETE(new Request("http://x/api/tasks"))).status).toBe(400);
      const stopped = (await (await DELETE(new Request("http://x/api/tasks?repoKey=A"))).json()) as { tasks: Task[] };
      expect(stopped.tasks.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
      await q.idle();
      const got = await one.GET(new Request("http://x"), { params: Promise.resolve({ id: a.id }) });
      expect(((await got.json()) as Task).state).toBe("cancelled");
      expect((await one.GET(new Request("http://x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    } finally {
      delete (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue;
    }
  });

  it("GET /api/tasks omits each task's result (the Tasks panel polls it every 3s)", async () => {
    const big = { status: "resolved", diff: "x".repeat(200_000), metrics: { costUsd: 0.1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    const runner: TaskRunner = async () => ({ result: big as never });
    const q = new TaskQueue({ fix: runner, review: runner }, { storeKey: key });
    (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue = q;
    try {
      const { GET } = await import("@/app/api/tasks/route");
      await q.enqueue(input("A", "a"));
      await q.idle();
      const slim = await (await GET(new Request("http://x/api/tasks?repoKey=A"))).text();
      const full = await (await GET(new Request("http://x/api/tasks?repoKey=A&full=1"))).text();
      expect(full.length).toBeGreaterThan(200_000);
      expect(slim.length).toBeLessThan(2_000);
      expect(JSON.parse(slim).tasks[0]).toMatchObject({ resultStatus: "resolved", usage: { costUsd: 0.1 } });
    } finally {
      delete (globalThis as { __viberonTaskQueue?: TaskQueue }).__viberonTaskQueue;
    }
  });
});

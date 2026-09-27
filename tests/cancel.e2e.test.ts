/**
 * Stop means stop. A queued fix task and a conversational run are cancelled
 * while (a) the model request is in flight and (b) a check process with a
 * child of its own is running. Within a bounded time the model request must
 * be aborted, every process killed, the task `cancelled` (not failed/done),
 * its worktree removed, and nothing pushed.
 *
 * The real solve loop runs here (no solveTask mock) against the scripted
 * fake provider; every model turn parks until its signal aborts.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrchestrationEvent } from "@/lib/agents/events";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { TaskQueue, type Task } from "@/lib/tasks";
import { runFixTask, runReviewTask } from "@/lib/tasks/runners";
import { installFakeProvider, uninstallFakeProvider, type FakeProvider } from "./helpers/fake-provider";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const STOP_BOUND_MS = 2_000;

/**
 * A check that records its pid and a child's pid (at an absolute path: the
 * baseline may run in a temporary checkout), then sleeps for a minute.
 */
const slowCheck = (pidFile: string) =>
  [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn('sleep', ['60'], { stdio: 'ignore' });",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + child.pid);`,
    "setTimeout(() => {}, 60000);",
  ].join("\n");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until<T>(probe: () => T | null | undefined | false, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function untilAsync<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}

let pidFile = "";

function pids_(): number[] | null {
  const file = pidFile;
  if (!existsSync(file)) return null;
  const pids = readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
  return pids.length === 2 && pids.every((p) => p > 0) ? pids : null;
}

let repo: TmpRepo;
let provider: FakeProvider;
const pidsSeen: number[] = [];

beforeEach(() => {
  resetMemoryStoreForTests();
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  // Every model call (criteria, solver, writer, reviewer) parks until aborted.
  provider = installFakeProvider(Array.from({ length: 20 }, () => ({ hang: true as const })));
  pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), "viberon-pids-")), "pids.txt");
  repo = makeTmpRepo({
    "package.json": JSON.stringify({ name: "slow", scripts: { test: "node slow.js" } }),
    "slow.js": `${slowCheck(pidFile)}\n`,
    "lib.js": "exports.x = 1;\n",
  });
  repo.git("config", "user.name", "t");
  repo.git("config", "user.email", "t@t");
  repo.git("branch", "-M", "main");
});

afterEach(() => {
  for (const pid of pidsSeen.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  uninstallFakeProvider();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  repo.cleanup();
  rmSync(path.dirname(pidFile), { recursive: true, force: true });
});

describe("Stop on a queued fix task", () => {
  it("aborts the model call, kills the check and its child, and ends cancelled within the bound", async () => {
    const { repoKey } = await registerLocalWorkspace(repo.root);
    const queue = new TaskQueue({ fix: runFixTask, review: runReviewTask }, { storeKey: `tasks:cancel:${Date.now()}` });
    const task = await queue.enqueue({ kind: "fix", repoKey, task: "lib.x should be 2", source: "ui", deliver: true, model: "claude-opus-5" });

    // Wait until the baseline check runs and the model is being asked.
    const pids = await until(() => pids_());
    pidsSeen.push(...pids);
    await until(() => provider.requests.length > 0);
    expect(pids.every(alive)).toBe(true);

    const stoppedAt = Date.now();
    await queue.cancel(task.id);
    const done = await untilAsync(async () => {
      const t = await queue.get(task.id);
      return t && t.state !== "running" ? t : null;
    }, STOP_BOUND_MS + 3_000);
    const elapsed = Date.now() - stoppedAt;

    expect(done.state).toBe("cancelled");
    expect(elapsed).toBeLessThan(STOP_BOUND_MS);
    expect(provider.requests.every((r) => r.signal?.aborted)).toBe(true);
    await until(() => pids.every((p) => !alive(p)), STOP_BOUND_MS);
    expect(pids.some(alive)).toBe(false);
    await queue.idle();
  });

  it("an issue fix stopped mid-solve removes its worktree, pushes nothing and opens no PR", async () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), "viberon-remote-"));
    try {
      execFileSync("git", ["init", "-q", "--bare", bare]);
      repo.git("remote", "add", "origin", "https://github.com/o/r.git");
      repo.git("config", `url.${bare}.insteadOf`, "https://github.com/o/r.git");
      repo.git("push", "-q", "origin", "main");
      const posted: string[] = [];
      vi.stubEnv("GITHUB_TOKEN", "ghp_cancel_test");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if ((init?.method ?? "GET") !== "GET") posted.push(url);
          if (url.endsWith("/repos/o/r")) return Response.json({ default_branch: "main" });
          if (url.endsWith("/issues/3")) {
            return Response.json({ number: 3, title: "x is 1", body: "should be 2", html_url: "https://github.com/o/r/issues/3", state: "open", labels: [], user: null, comments: 0, created_at: "", updated_at: "" });
          }
          if (url.includes("/issues/3/comments")) return Response.json([]);
          return Response.json({ message: "unexpected" }, { status: 404 });
        }),
      );
      const { repoKey } = await registerLocalWorkspace(repo.root);
      const queue = new TaskQueue({ fix: runFixTask, review: runReviewTask }, { storeKey: `tasks:cancel-issue:${Date.now()}` });
      const task = await queue.enqueue({
        kind: "fix",
        repoKey,
        task: "#3 x is 1",
        source: "issue",
        issueUrl: "https://github.com/o/r/issues/3",
        deliver: true,
        model: "claude-opus-5",
      });

      // The check runs inside the isolated worktree, not the user's checkout.
      const worktree = await until(() => {
        const lines = repo.git("worktree", "list", "--porcelain").split("\n").filter((l) => l.startsWith("worktree "));
        return lines.length > 1 ? lines[1]!.slice("worktree ".length) : null;
      });
      const pids = await until(() => pids_());
      pidsSeen.push(...pids);

      const stoppedAt = Date.now();
      await queue.cancel(task.id);
      const done = await untilAsync(async () => {
        const t = await queue.get(task.id);
        return t && t.state !== "running" ? t : null;
      }, STOP_BOUND_MS + 3_000);
      expect(done.state).toBe("cancelled");
      expect(Date.now() - stoppedAt).toBeLessThan(STOP_BOUND_MS);
      await queue.idle();

      await until(() => pids.every((p) => !alive(p)), STOP_BOUND_MS);
      expect(repo.git("worktree", "list").trim().split("\n")).toHaveLength(1);
      expect(existsSync(worktree)).toBe(false);
      expect(posted).toEqual([]);
      expect(execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" }).trim()).toBe("refs/heads/main");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("Stop on a conversational run", () => {
  async function startRun(body: Record<string, unknown>) {
    const { repoKey } = await registerLocalWorkspace(repo.root);
    const { POST } = await import("@/app/api/agent/route");
    const response = await POST(
      new Request("http://x/api/agent", {
        method: "POST",
        body: JSON.stringify({ repoKey, prompt: "change lib.x to 2", model: "claude-opus-5", autoCheckpoint: false, ...body }),
      }),
    );
    expect(response.ok).toBe(true);
    const runId = response.headers.get("x-run-id") ?? response.headers.get("X-Run-Id");
    const events: OrchestrationEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const finished = (async () => {
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame.split("\n").find((l) => l.startsWith("data:"));
          if (data) events.push(JSON.parse(data.slice(5)) as OrchestrationEvent);
        }
      }
    })();
    return { runId: runId!, events, finished };
  }

  async function stop(runId: string) {
    const { POST } = await import("@/app/api/agent/cancel/route");
    const res = await POST(new Request("http://x/api/agent/cancel", { method: "POST", body: JSON.stringify({ runId }) }));
    return (await res.json()) as { ok: boolean };
  }

  it("a run waiting on the model ends run_done{cancelled} within the bound", async () => {
    const run = await startRun({ interaction: "agent", mode: "single" });
    await until(() => provider.requests.length > 0);
    const stoppedAt = Date.now();
    expect((await stop(run.runId)).ok).toBe(true);
    await run.finished;
    expect(Date.now() - stoppedAt).toBeLessThan(STOP_BOUND_MS);
    const done = run.events.filter((e) => e.type === "run_done").at(-1) as Extract<OrchestrationEvent, { type: "run_done" }> | undefined;
    expect(done?.status).toBe("cancelled");
    expect(provider.requests.every((r) => r.signal?.aborted)).toBe(true);
  });

  it("a run blocked on an approval ends cancelled within the bound", async () => {
    uninstallFakeProvider();
    provider = installFakeProvider([
      { calls: [{ name: "run_command", input: { command: "rm -rf build" } }] },
      { hang: true },
    ]);
    const run = await startRun({ interaction: "agent", mode: "single", commandPolicy: "ask" });
    await until(() => run.events.some((e) => e.type === "approval_request") || run.events.some((e) => e.type === "run_done"));
    const stoppedAt = Date.now();
    await stop(run.runId);
    await run.finished;
    expect(Date.now() - stoppedAt).toBeLessThan(STOP_BOUND_MS);
    const done = run.events.filter((e) => e.type === "run_done").at(-1) as Extract<OrchestrationEvent, { type: "run_done" }> | undefined;
    expect(done?.status).toBe("cancelled");
  });

  it("a run inside a long command kills it and ends cancelled within the bound", async () => {
    uninstallFakeProvider();
    provider = installFakeProvider([
      { calls: [{ name: "run_command", input: { command: "node slow.js", timeout_seconds: 120 } }] },
      { hang: true },
    ]);
    const run = await startRun({ interaction: "agent", mode: "single", commandPolicy: "auto" });
    const pids = await until(() => pids_());
    pidsSeen.push(...pids);
    const stoppedAt = Date.now();
    await stop(run.runId);
    await run.finished;
    expect(Date.now() - stoppedAt).toBeLessThan(STOP_BOUND_MS);
    const done = run.events.filter((e) => e.type === "run_done").at(-1) as Extract<OrchestrationEvent, { type: "run_done" }> | undefined;
    expect(done?.status).toBe("cancelled");
    await until(() => pids.every((p) => !alive(p)), STOP_BOUND_MS);
  });
});

export type { Task };

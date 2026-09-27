/**
 * The task queue (Jiffy gateway, in-process): every intake (UI, CLI, local
 * API, issue) enqueues here. FIFO, one running task per repo, states
 * queued → running → done | failed | cancelled, persisted in the settings
 * store. A task that was running when the process died comes back as
 * failed("interrupted"); queued tasks resume.
 *
 * Each task's events go to a bounded in-memory log, so an SSE subscriber
 * that attaches late gets the replay and then the live tail.
 */

import { randomUUID } from "node:crypto";

import type { OrchestrationEvent } from "@/lib/agents/events";
import type { SolveResult } from "@/lib/harness/solve-types";
import { getValueRaw, setValueRaw } from "@/lib/store";
import type { Review } from "@/lib/review";

export type TaskKind = "fix" | "review";
export type TaskSource = "ui" | "cli" | "api" | "issue";
export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  kind: TaskKind;
  repoKey: string;
  task: string;
  source: TaskSource;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: SolveResult | Review;
  prUrl?: string;
  error?: string;
  /** Something the user should know about a task that still succeeded (e.g. why it was not delivered). */
  note?: string;
  issueUrl?: string;
  /**
   * A batch: fix every one of these GitHub issues on ONE branch (a commit per
   * resolved issue, from a clean worktree of origin/<default>) and open ONE
   * pull request. Mutually exclusive with `issueUrl`.
   */
  issueUrls?: string[];
  /** Titles captured when a batch is queued, for its plan before execution. */
  issueTitles?: string[];
  /** The user's original instruction for a batch issue run. */
  instructions?: string;
  deliver?: boolean;
  model?: string;
  /**
   * Token use and cost: live while running (summed from the task's
   * `turn_usage` events), final once it ends (the solve's own metrics win
   * when they account for more). Persisted with the task.
   */
  usage?: TaskUsage;
  /** A batch's per-issue outcome: which issues its PR actually fixes. */
  issueResults?: IssueResult[];
}

export interface TaskUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** Model calls counted. */
  calls: number;
}

export interface IssueResult {
  url: string;
  fixed: boolean;
  detail?: string;
}

export const EMPTY_USAGE: TaskUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 };

export function usageTokens(u: TaskUsage | undefined): number {
  return u ? u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
}

export function addUsage(a: TaskUsage | undefined, b: TaskUsage | undefined): TaskUsage {
  const x = a ?? EMPTY_USAGE;
  const y = b ?? EMPTY_USAGE;
  return {
    inputTokens: x.inputTokens + y.inputTokens,
    outputTokens: x.outputTokens + y.outputTokens,
    cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens,
    cacheWriteTokens: x.cacheWriteTokens + y.cacheWriteTokens,
    costUsd: Math.round((x.costUsd + y.costUsd) * 1e6) / 1e6,
    calls: x.calls + y.calls,
  };
}

/** A solve's own totals (`SolveResult.metrics`), or undefined. */
export function usageFromResult(result: unknown): TaskUsage | undefined {
  const m = (result as { metrics?: Record<string, unknown> } | undefined)?.metrics;
  if (!m || typeof m !== "object") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage: TaskUsage = {
    inputTokens: n(m.inputTokens),
    outputTokens: n(m.outputTokens),
    cacheReadTokens: n(m.cacheReadTokens),
    cacheWriteTokens: n(m.cacheWriteTokens),
    costUsd: n(m.costUsd),
    calls: n(m.modelCalls),
  };
  return usageTokens(usage) > 0 || usage.costUsd > 0 ? usage : undefined;
}

/** One `turn_usage` event as usage. */
function usageFromEvent(event: OrchestrationEvent): TaskUsage | undefined {
  if (event.type !== "turn_usage") return undefined;
  return {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
    costUsd: event.costUsd,
    calls: 1,
  };
}

export interface EnqueueInput {
  kind: TaskKind;
  repoKey: string;
  task: string;
  source: TaskSource;
  issueUrl?: string;
  issueUrls?: string[];
  issueTitles?: string[];
  instructions?: string;
  deliver?: boolean;
  model?: string;
}

export interface TaskOutcome {
  result?: Task["result"];
  prUrl?: string;
  /** Set → the task failed with this message. */
  error?: string;
  note?: string;
  /** Usage the events did not carry (e.g. a batch's inner solves). */
  usage?: TaskUsage;
  issueResults?: IssueResult[];
}

export type TaskRunner = (
  task: Task,
  ctx: { emit: (event: OrchestrationEvent) => void; signal: AbortSignal },
) => Promise<TaskOutcome>;

export const TASKS_KEY = "tasks:v1";
const MAX_STORED = 50;
const MAX_LOGS = 20;
const TERMINAL: TaskState[] = ["done", "failed", "cancelled"];
/**
 * A cancelled runner gets this long to unwind (abort its model call, kill
 * its processes, remove its worktree). After that the task is marked
 * cancelled anyway, so a runner stuck in something that ignores the signal
 * can never leave the UI spinning or block the repo's queue.
 */
export const CANCEL_GRACE_MS = 10_000;

interface Listener {
  onEvent: (event: OrchestrationEvent) => void;
  onEnd: () => void;
}

class EventLog {
  events: OrchestrationEvent[] = [];
  listeners = new Set<Listener>();
  ended = false;
  constructor(private readonly max: number) {}

  push(event: OrchestrationEvent) {
    if (this.ended) return;
    this.events.push(event);
    // Keep the first event (run_start) and the newest tail.
    if (this.events.length > this.max) this.events.splice(1, 1);
    for (const l of this.listeners) l.onEvent(event);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const l of this.listeners) l.onEnd();
    this.listeners.clear();
  }
}

export class TaskQueue {
  private tasks: Task[] = [];
  private loading: Promise<void> | null = null;
  private readonly controllers = new Map<string, AbortController>();
  private readonly logs = new Map<string, EventLog>();
  private readonly active = new Set<Promise<void>>();

  constructor(
    private runners: Record<TaskKind, TaskRunner>,
    private readonly options: {
      storeKey?: string;
      maxEvents?: number;
      /** Called when a running task is cancelled (the real queue kills its terminal sessions). */
      onCancel?: (task: Task) => void;
      cancelGraceMs?: number;
    } = {},
  ) {}

  /** Swap the runners (dev hot reload); tasks already running keep theirs. */
  useRunners(runners: Record<TaskKind, TaskRunner>): void {
    this.runners = runners;
  }

  private get key() {
    return this.options.storeKey ?? TASKS_KEY;
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const stored = (await getValueRaw<Task[]>(this.key)) ?? [];
      let interrupted = false;
      this.tasks = stored.map((t) => {
        if (t.state !== "running") return t;
        interrupted = true;
        return { ...t, state: "failed", error: "interrupted", finishedAt: Date.now() };
      });
      if (interrupted) await this.persist();
      for (const repoKey of new Set(this.tasks.filter((t) => t.state === "queued").map((t) => t.repoKey))) this.pump(repoKey);
    })();
    return this.loading;
  }

  private async persist() {
    const finished = this.tasks.filter((t) => TERMINAL.includes(t.state));
    const drop = new Set(finished.slice(0, Math.max(0, this.tasks.length - MAX_STORED)).map((t) => t.id));
    this.tasks = this.tasks.filter((t) => !drop.has(t.id));
    // JSON round trip: the Firestore backend rejects undefined fields.
    await setValueRaw(this.key, JSON.parse(JSON.stringify(this.tasks)));
  }

  async enqueue(input: EnqueueInput): Promise<Task> {
    await this.load();
    const task: Task = {
      id: randomUUID(),
      kind: input.kind,
      repoKey: input.repoKey,
      task: input.task,
      source: input.source,
      state: "queued",
      createdAt: Date.now(),
      ...(input.issueUrl ? { issueUrl: input.issueUrl } : {}),
      ...(input.issueUrls?.length ? { issueUrls: [...input.issueUrls] } : {}),
      ...(input.issueTitles?.length ? { issueTitles: [...input.issueTitles] } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.deliver ? { deliver: true } : {}),
      ...(input.model ? { model: input.model } : {}),
    };
    this.tasks.push(task);
    await this.persist();
    this.pump(task.repoKey);
    return { ...task };
  }

  async list(repoKey?: string): Promise<Task[]> {
    await this.load();
    return this.tasks.filter((t) => !repoKey || t.repoKey === repoKey).map((t) => ({ ...t }));
  }

  async get(id: string): Promise<Task | null> {
    await this.load();
    const task = this.tasks.find((t) => t.id === id);
    return task ? { ...task } : null;
  }

  /**
   * Queued → cancelled now; running → aborted: its model calls and
   * processes are stopped and it becomes cancelled when the runner unwinds
   * (at the latest after the grace period). Null if unknown.
   */
  async cancel(id: string): Promise<Task | null> {
    await this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (task.state === "queued") {
      Object.assign(task, { state: "cancelled", finishedAt: Date.now() });
      this.logs.get(id)?.end();
      await this.persist();
    } else if (task.state === "running") {
      this.stopRunning(task);
    }
    return { ...task };
  }

  /** Stop every queued and running task of a repo (queued first, so none starts). */
  async cancelAll(repoKey: string): Promise<Task[]> {
    await this.load();
    const mine = this.tasks.filter((t) => t.repoKey === repoKey && (t.state === "queued" || t.state === "running"));
    const now = Date.now();
    for (const task of mine) {
      if (task.state !== "queued") continue;
      Object.assign(task, { state: "cancelled", finishedAt: now });
      this.logs.get(task.id)?.end();
    }
    if (mine.some((t) => t.state === "cancelled")) await this.persist();
    for (const task of mine) if (task.state === "running") this.stopRunning(task);
    return mine.map((t) => ({ ...t }));
  }

  private stopRunning(task: Task) {
    const controller = this.controllers.get(task.id);
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    try {
      this.options.onCancel?.(task);
    } catch {
      // Best effort: the abort signal is the primary stop.
    }
    const timer = setTimeout(() => this.forceFinish(task), this.options.cancelGraceMs ?? CANCEL_GRACE_MS);
    timer.unref?.();
  }

  /** The runner ignored its abort for the whole grace period: finish the task anyway. */
  private forceFinish(task: Task) {
    if (task.state !== "running") return;
    Object.assign(task, { state: "cancelled", finishedAt: Date.now(), note: "Stopped; the runner did not exit in time." });
    const log = this.logs.get(task.id);
    if (log) this.closeLog(task, log);
    void this.persist().catch(() => undefined);
    this.pump(task.repoKey);
  }

  /**
   * Replay the task's buffered events, then stream new ones; `onEnd` fires
   * when it finishes (at once for a finished task). Null if unknown.
   */
  async subscribe(
    id: string,
    onEvent: Listener["onEvent"],
    onEnd: Listener["onEnd"],
  ): Promise<(() => void) | null> {
    const task = await this.get(id);
    if (!task) return null;
    const log = this.logs.get(id);
    for (const event of log?.events ?? []) onEvent(event);
    if (!log || log.ended || TERMINAL.includes(task.state)) {
      onEnd();
      return () => {};
    }
    const listener = { onEvent, onEnd };
    log.listeners.add(listener);
    return () => log.listeners.delete(listener);
  }

  /** Resolves when nothing is running (tests, shutdown). */
  async idle(): Promise<void> {
    await this.load();
    while (this.active.size) await Promise.all([...this.active]);
  }

  private logFor(id: string): EventLog {
    let log = this.logs.get(id);
    if (!log) {
      log = new EventLog(this.options.maxEvents ?? 2000);
      this.logs.set(id, log);
      if (this.logs.size > MAX_LOGS) {
        const oldest = [...this.logs].find(([, l]) => l.ended);
        if (oldest) this.logs.delete(oldest[0]);
      }
    }
    return log;
  }

  private pump(repoKey: string) {
    if (this.tasks.some((t) => t.repoKey === repoKey && t.state === "running")) return;
    const next = this.tasks.find((t) => t.repoKey === repoKey && t.state === "queued");
    if (!next) return;
    // Marked running synchronously so a second pump cannot start it again.
    next.state = "running";
    next.startedAt = Date.now();
    const run = this.run(next).finally(() => {
      this.active.delete(run);
      this.pump(repoKey);
    });
    this.active.add(run);
  }

  private async run(task: Task) {
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    const log = this.logFor(task.id);
    let live: TaskUsage | undefined;
    const emit = (event: OrchestrationEvent) => {
      const used = usageFromEvent(event);
      if (used) {
        live = addUsage(live, used);
        // Visible to list()/GET /api/tasks while it runs (persisted at the end).
        if (task.state === "running") task.usage = live;
      }
      log.push(event);
    };
    try {
      await this.persist();
      const out = await this.runners[task.kind]({ ...task }, { emit, signal: controller.signal });
      // Forced to cancelled after the grace period: the late outcome is dropped.
      if (task.state !== "running") return;
      Object.assign(task, {
        ...(out.result ? { result: out.result } : {}),
        ...(out.prUrl ? { prUrl: out.prUrl } : {}),
        ...(out.note ? { note: out.note } : {}),
        ...(out.issueResults ? { issueResults: out.issueResults } : {}),
      });
      const final = addUsage(usageFromResult(out.result), out.usage);
      if (usageTokens(final) >= usageTokens(live) && usageTokens(final) > 0) task.usage = final;
      if (controller.signal.aborted) task.state = "cancelled";
      else if (out.error) Object.assign(task, { state: "failed", error: out.error });
      else task.state = "done";
    } catch (error) {
      if (task.state !== "running") return;
      task.state = controller.signal.aborted ? "cancelled" : "failed";
      if (task.state === "failed") task.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.controllers.delete(task.id);
      if (!task.finishedAt || task.state === "running") task.finishedAt = Date.now();
      this.closeLog(task, log);
      await this.persist().catch(() => undefined);
    }
  }

  /**
   * End the task's stream with a `run_done` that matches its final state, so
   * an attached run view never shows "done" for a task that was stopped or
   * failed (and never keeps a spinner for one that ended without its own
   * `run_done`, e.g. a runner that threw).
   */
  private closeLog(task: Task, log: EventLog) {
    if (log.ended) return;
    // Only a stream that started a run view (run_start) needs closing.
    if (!log.events.some((e) => e.type === "run_start")) {
      log.end();
      return;
    }
    const last = [...log.events].reverse().find((e) => e.type === "run_done");
    const status = task.state === "cancelled" ? "cancelled" : task.state === "failed" ? "failed" : "done";
    const lastStatus = last?.type === "run_done" ? (last.status ?? "done") : null;
    const agrees = lastStatus === status || (status === "done" && lastStatus === "incomplete") || (status === "failed" && lastStatus === "incomplete");
    if (!last || !agrees) {
      log.push({
        type: "run_done",
        status,
        summary: task.state === "cancelled" ? "Stopped." : (task.error ?? task.note ?? (last?.type === "run_done" ? last.summary : "")),
        filesChanged: last?.type === "run_done" ? last.filesChanged : 0,
        durationMs: (task.finishedAt ?? Date.now()) - (task.startedAt ?? task.createdAt),
        costUsd: task.usage?.costUsd ?? 0,
      });
    }
    log.end();
  }
}

const GLOBAL = globalThis as { __viberonTaskQueue?: TaskQueue; __viberonTaskQueueManaged?: TaskQueue };

/** The process-wide queue with the real runners (survives dev hot reloads). */
export function getTaskQueue(): TaskQueue {
  const lazy =
    (kind: TaskKind): TaskRunner =>
    async (task, ctx) => {
      const runners = await import("@/lib/tasks/runners");
      return (kind === "fix" ? runners.runFixTask : runners.runReviewTask)(task, ctx);
    };
  const runners = { fix: lazy("fix"), review: lazy("review") };
  if (!GLOBAL.__viberonTaskQueue) {
    GLOBAL.__viberonTaskQueue = new TaskQueue(runners, { onCancel: killTaskSessions });
    GLOBAL.__viberonTaskQueueManaged = GLOBAL.__viberonTaskQueue;
  } else if (GLOBAL.__viberonTaskQueue === GLOBAL.__viberonTaskQueueManaged) {
    // The queue outlives dev hot reloads, but its runners must not: a closure
    // from the first module instance would keep running the first build's code.
    GLOBAL.__viberonTaskQueue.useRunners(runners);
  }
  return GLOBAL.__viberonTaskQueue;
}

/** The solve run ids a task uses (a batch solves each issue as `<task>-<number>`). */
export function taskRunIds(task: Pick<Task, "id" | "issueUrls">): string[] {
  const numbers = (task.issueUrls ?? []).map((url) => /\/issues\/(\d+)/.exec(url)?.[1]).filter(Boolean);
  return [task.id, ...numbers.map((n) => `${task.id}-${n}`)];
}

/**
 * Backstop for Stop: kill every terminal session the task's solves started.
 * The abort signal already stops model calls, checks and foreground
 * commands; background sessions (dev servers) are only reachable this way.
 */
function killTaskSessions(task: Task): void {
  void import("@/lib/terminal")
    .then((terminal) => {
      for (const runId of taskRunIds(task)) terminal.killSessionsByRun(runId);
    })
    .catch(() => undefined);
}

export function enqueue(input: EnqueueInput): Promise<Task> {
  return getTaskQueue().enqueue(input);
}

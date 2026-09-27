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
}

export type TaskRunner = (
  task: Task,
  ctx: { emit: (event: OrchestrationEvent) => void; signal: AbortSignal },
) => Promise<TaskOutcome>;

export const TASKS_KEY = "tasks:v1";
const MAX_STORED = 50;
const MAX_LOGS = 20;
const TERMINAL: TaskState[] = ["done", "failed", "cancelled"];

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
    private readonly options: { storeKey?: string; maxEvents?: number } = {},
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

  /** Queued → cancelled now; running → aborted (becomes cancelled when it stops). Null if unknown. */
  async cancel(id: string): Promise<Task | null> {
    await this.load();
    const task = this.tasks.find((t) => t.id === id);
    if (!task) return null;
    if (task.state === "queued") {
      Object.assign(task, { state: "cancelled", finishedAt: Date.now() });
      this.logs.get(id)?.end();
      await this.persist();
    } else if (task.state === "running") {
      this.controllers.get(id)?.abort();
    }
    return { ...task };
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
    try {
      await this.persist();
      const out = await this.runners[task.kind]({ ...task }, { emit: (e) => log.push(e), signal: controller.signal });
      Object.assign(task, {
        ...(out.result ? { result: out.result } : {}),
        ...(out.prUrl ? { prUrl: out.prUrl } : {}),
        ...(out.note ? { note: out.note } : {}),
      });
      if (controller.signal.aborted) task.state = "cancelled";
      else if (out.error) Object.assign(task, { state: "failed", error: out.error });
      else task.state = "done";
    } catch (error) {
      task.state = controller.signal.aborted ? "cancelled" : "failed";
      if (task.state === "failed") task.error = error instanceof Error ? error.message : String(error);
    } finally {
      task.finishedAt = Date.now();
      this.controllers.delete(task.id);
      log.end();
      await this.persist().catch(() => undefined);
    }
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
    GLOBAL.__viberonTaskQueue = new TaskQueue(runners);
    GLOBAL.__viberonTaskQueueManaged = GLOBAL.__viberonTaskQueue;
  } else if (GLOBAL.__viberonTaskQueue === GLOBAL.__viberonTaskQueueManaged) {
    // The queue outlives dev hot reloads, but its runners must not: a closure
    // from the first module instance would keep running the first build's code.
    GLOBAL.__viberonTaskQueue.useRunners(runners);
  }
  return GLOBAL.__viberonTaskQueue;
}

export function enqueue(input: EnqueueInput): Promise<Task> {
  return getTaskQueue().enqueue(input);
}

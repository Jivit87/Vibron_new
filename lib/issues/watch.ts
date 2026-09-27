/**
 * Auto mode: poll a repo for open issues carrying the trigger label and
 * queue fix + deliver tasks for them (Jiffy's mention trigger, as polling,
 * since a desktop app cannot receive webhooks).
 *
 * The label is the trust gate: on GitHub only people with triage rights can
 * apply labels, so a labeled issue was approved by a maintainer. Unlabeled
 * issues are never picked up automatically.
 */

import { listIssues } from "@/lib/github-api";
import { fixIssues, workspaceRepo } from "@/lib/issues";

export interface WatchConfig {
  enabled: boolean;
  label: string;
  intervalMinutes: number;
  lastCheckedAt?: number;
  lastError?: string;
  /** Issues this watcher has queued (never re-queued by the watcher). */
  handledIssues: number[];
}

export const DEFAULT_WATCH: WatchConfig = { enabled: false, label: "viberon", intervalMinutes: 15, handledIssues: [] };
const INDEX_KEY = "issues:watch:index";
const configKey = (repoKey: string) => `issues:watch:${repoKey}`;
const TICK_MS = 60_000;

type StoreModule = typeof import("@/lib/store");
const store = (): Promise<StoreModule> => import("@/lib/store");

export async function getWatch(repoKey: string): Promise<WatchConfig> {
  const { getValueRaw } = await store();
  return { ...DEFAULT_WATCH, ...((await getValueRaw<WatchConfig>(configKey(repoKey))) ?? {}) };
}

export function validateWatch(input: { enabled?: unknown; label?: unknown; intervalMinutes?: unknown }): Pick<
  WatchConfig,
  "enabled" | "label" | "intervalMinutes"
> {
  const label = typeof input.label === "string" ? input.label.trim() : DEFAULT_WATCH.label;
  if (!label || label.length > 50 || /[,\n]/.test(label)) throw new Error("label must be one GitHub label name (no commas).");
  const minutes = Number(input.intervalMinutes ?? DEFAULT_WATCH.intervalMinutes);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new Error("intervalMinutes must be a whole number from 5 to 1440.");
  return { enabled: input.enabled === true, label, intervalMinutes: minutes };
}

export async function setWatch(
  repoKey: string,
  patch: Pick<WatchConfig, "enabled" | "label" | "intervalMinutes">,
): Promise<WatchConfig> {
  const { getValueRaw, setValueRaw } = await store();
  const prev = await getWatch(repoKey);
  // A different label is a different trigger: issues are counted afresh.
  const next: WatchConfig = { ...prev, ...patch, ...(patch.label !== prev.label ? { handledIssues: [] } : {}) };
  await setValueRaw(configKey(repoKey), next);
  const index = new Set((await getValueRaw<string[]>(INDEX_KEY)) ?? []);
  if (next.enabled) index.add(repoKey);
  else index.delete(repoKey);
  await setValueRaw(INDEX_KEY, [...index]);
  if (next.enabled) ensureIssueWatchers();
  return next;
}

const IN_FLIGHT = ((globalThis as { __viberonWatchPolls?: Map<string, Promise<WatchConfig>> }).__viberonWatchPolls ??= new Map());

/**
 * One poll of one repo. Exported for tests and for "check now". A poll that
 * starts while another for the same repo is running joins it instead of
 * racing it (both would read the same handled list and queue the same issues).
 */
export function checkRepo(repoKey: string, now = Date.now()): Promise<WatchConfig> {
  const running = IN_FLIGHT.get(repoKey);
  if (running) return running;
  const poll = pollRepo(repoKey, now).finally(() => IN_FLIGHT.delete(repoKey));
  IN_FLIGHT.set(repoKey, poll);
  return poll;
}

async function pollRepo(repoKey: string, now: number): Promise<WatchConfig> {
  const { setValueRaw } = await store();
  const config = await getWatch(repoKey);
  const next: WatchConfig = { ...config, lastCheckedAt: now };
  delete next.lastError;
  try {
    const { repo } = await workspaceRepo(repoKey);
    const issues = await listIssues(repo, { labels: [config.label], limit: 30 });
    const fresh = issues.map((i) => i.number).filter((n) => !config.handledIssues.includes(n));
    if (fresh.length) {
      const { tasks, skipped } = await fixIssues({ repoKey, numbers: fresh, deliver: true, source: "issue" });
      const queued = tasks.map((t) => Number(t.issueUrl?.split("/").pop()));
      // Skipped ones are handled too (already in flight, already fixed, or
      // closed), except those GitHub could not answer for: retried next poll.
      const settled = skipped.filter((s) => !s.transient).map((s) => s.number);
      const retry = skipped.filter((s) => s.transient);
      next.handledIssues = [...config.handledIssues, ...queued, ...settled].slice(-500);
      if (retry.length) {
        next.lastError = `Will retry ${retry.map((s) => `#${s.number}`).join(", ")}: ${retry[0]!.reason}`.slice(0, 300);
      }
    }
  } catch (error) {
    next.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }
  await setValueRaw(configKey(repoKey), next);
  return next;
}

let ticking = false;

async function tick(): Promise<void> {
  // A slow poll (big repo, slow GitHub) must not stack up behind the timer.
  if (ticking) return;
  ticking = true;
  try {
    await tickOnce();
  } finally {
    ticking = false;
  }
}

async function tickOnce(): Promise<void> {
  const { getValueRaw } = await store();
  for (const repoKey of (await getValueRaw<string[]>(INDEX_KEY)) ?? []) {
    const config = await getWatch(repoKey);
    const due = !config.lastCheckedAt || Date.now() - config.lastCheckedAt >= config.intervalMinutes * 60_000;
    if (config.enabled && due) await checkRepo(repoKey);
  }
}

const TIMER_KEY = Symbol.for("viberon.issues.watch");
type GlobalWithTimer = typeof globalThis & { [TIMER_KEY]?: ReturnType<typeof setInterval> };

/** Start the single process-wide poller (idempotent; survives dev HMR). */
export function ensureIssueWatchers(): void {
  const g = globalThis as GlobalWithTimer;
  if (g[TIMER_KEY]) return;
  g[TIMER_KEY] = setInterval(() => void tick().catch(() => undefined), TICK_MS);
  g[TIMER_KEY].unref?.();
  void tick().catch(() => undefined);
}

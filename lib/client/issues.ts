/**
 * Client side of issues → fix → pull request: `GET /api/issues`,
 * `POST /api/issues/fix` and `GET`/`PUT /api/issues/watch`
 * (docs/PLAN-ISSUES.md).
 *
 * The routes are built in parallel with this UI, so the readers are tolerant
 * (aliases, wrappers, string or number timestamps) and every call returns a
 * result object instead of throwing. `?mock=1` answers from fixtures in
 * `mock-run.ts`.
 */

import { isMockMode, mockFixIssues, mockIssues, mockSaveWatch, mockWatch } from "@/lib/client/mock-run";
import { normalizeTask, normalizeTaskState, taskUsage, type TaskRow, type TaskState, type TaskUsageRow } from "@/lib/client/deliver";

/* -------------------------------- helpers -------------------------------- */

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function time(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/* --------------------------------- shapes --------------------------------- */

export interface IssueTask {
  id: string;
  state: TaskState;
  prUrl?: string;
  error?: string;
  note?: string;
  usage?: TaskUsageRow;
}

export interface IssueRow {
  number: number;
  title: string;
  url: string;
  labels: string[];
  author: string | null;
  comments: number;
  /** Epoch ms; 0 when unknown. */
  updatedAt: number;
  task: IssueTask | null;
}

export interface WatchConfig {
  enabled: boolean;
  label: string;
  intervalMinutes: number;
  lastCheckedAt?: number;
  lastError?: string;
  handled: number;
}

export const WATCH_DEFAULT: WatchConfig = { enabled: false, label: "viberon", intervalMinutes: 15, handled: 0 };
export const INTERVAL_MIN = 5;
export const INTERVAL_MAX = 1440;

export function clampInterval(value: unknown): number {
  const n = num(value);
  if (n === undefined) return WATCH_DEFAULT.intervalMinutes;
  return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(n)));
}

export function normalizeIssueTask(raw: unknown): IssueTask | null {
  const r = rec(raw);
  if (!r) return null;
  const id = str(r.id) ?? (typeof r.id === "number" ? String(r.id) : undefined);
  if (!id) return null;
  const result = rec(r.result);
  const err = r.error;
  return {
    id,
    state: normalizeTaskState(r.state ?? r.status),
    prUrl: str(r.prUrl) ?? str(result?.prUrl) ?? str(r.pr_url),
    error: str(err) ?? str(rec(err)?.message),
    note: str(r.note) ?? str(result?.note) ?? str(r.reason),
    usage: taskUsage(r),
  };
}

function labelName(value: unknown): string | undefined {
  return str(value) ?? str(rec(value)?.name);
}

export function normalizeIssueRow(raw: unknown): IssueRow | null {
  const r = rec(raw);
  if (!r) return null;
  const number = num(r.number) ?? num(r.issueNumber);
  if (number === undefined) return null;
  const labelsRaw = Array.isArray(r.labels) ? r.labels : [];
  const author = str(r.author) ?? str(rec(r.author)?.login) ?? str(rec(r.user)?.login) ?? null;
  const comments = num(r.comments) ?? (Array.isArray(r.comments) ? r.comments.length : undefined) ?? 0;
  return {
    number,
    title: (str(r.title) ?? `#${number}`).trim(),
    url: str(r.url) ?? str(r.html_url) ?? str(r.htmlUrl) ?? "",
    labels: labelsRaw.map(labelName).filter((l): l is string => Boolean(l)),
    author,
    comments,
    updatedAt: time(r.updatedAt) ?? time(r.updated_at) ?? 0,
    task: normalizeIssueTask(r.task),
  };
}

export function normalizeWatch(raw: unknown): WatchConfig {
  const r = rec(rec(raw)?.watch) ?? rec(raw) ?? {};
  return {
    enabled: r.enabled === true,
    label: str(r.label) ?? WATCH_DEFAULT.label,
    intervalMinutes: clampInterval(r.intervalMinutes ?? r.interval),
    lastCheckedAt: time(r.lastCheckedAt) ?? time(r.lastChecked),
    lastError: str(r.lastError),
    handled: num(r.handled) ?? 0,
  };
}

export interface IssuesList {
  repo: { owner: string; repo: string } | null;
  issues: IssueRow[];
  watch: WatchConfig | null;
}

export function normalizeIssues(body: unknown): IssuesList {
  const r = rec(body) ?? {};
  const repoRaw = rec(r.repo);
  const full = str(r.repo) ?? str(r.fullName);
  let repo: IssuesList["repo"] = null;
  if (repoRaw && str(repoRaw.owner) && (str(repoRaw.repo) ?? str(repoRaw.name))) {
    repo = { owner: str(repoRaw.owner)!, repo: (str(repoRaw.repo) ?? str(repoRaw.name))! };
  } else if (full && full.includes("/")) {
    const [owner, name] = full.split("/");
    repo = { owner, repo: name };
  }
  const list = Array.isArray(body) ? body : Array.isArray(r.issues) ? r.issues : Array.isArray(r.items) ? r.items : [];
  const issues = list.map(normalizeIssueRow).filter((i): i is IssueRow => i !== null);
  return { repo, issues, watch: rec(r.watch) ? normalizeWatch(r.watch) : null };
}

/* --------------------------------- errors --------------------------------- */

export type IssuesErrorKind = "no_folder" | "no_github_remote" | "token" | "missing" | "other";

export interface IssuesError {
  kind: IssuesErrorKind;
  message: string;
}

export const ERROR_TEXT: Record<"no_folder" | "no_github_remote" | "token" | "missing", string> = {
  no_folder: "Open a local folder or clone a repository first.",
  no_github_remote: "This folder has no GitHub remote named origin.",
  token: "GitHub needs a token to read this repository's issues.",
  missing: "This server does not expose /api/issues yet.",
};

export function issuesError(body: unknown, status: number): IssuesError {
  const r = rec(body) ?? {};
  const code = (str(r.code) ?? str(r.reason) ?? "").toLowerCase();
  const raw = str(r.error) ?? str(r.message) ?? "";
  if (code === "no_folder") return { kind: "no_folder", message: ERROR_TEXT.no_folder };
  if (code === "no_github_remote" || code === "no_remote") return { kind: "no_github_remote", message: ERROR_TEXT.no_github_remote };
  if (
    /token/.test(code) ||
    status === 401 ||
    /\b401\b|github token|GITHUB_TOKEN|no token|token (is )?(missing|required|not set)/i.test(raw)
  ) {
    return { kind: "token", message: ERROR_TEXT.token };
  }
  if (status === 404 && !raw) return { kind: "missing", message: ERROR_TEXT.missing };
  return { kind: "other", message: raw || `Could not load issues (HTTP ${status})` };
}

/* --------------------------------- status --------------------------------- */

export type IssueStatusKind = "none" | "queued" | "running" | "done" | "failed" | "not_delivered" | "cancelled";

export interface IssueStatus {
  kind: IssueStatusKind;
  label: string;
  /** Hover text: the error, the note, or nothing. */
  detail?: string;
}

/**
 * The row's status from its task: queued / running / done with a PR /
 * failed with the error / "not delivered" (finished without a PR) with the note.
 */
export function issueStatus(task: IssueTask | null): IssueStatus {
  if (!task) return { kind: "none", label: "" };
  switch (task.state) {
    case "queued":
      return { kind: "queued", label: "queued" };
    case "running":
      return { kind: "running", label: "running" };
    case "failed":
      return { kind: "failed", label: "failed", detail: task.error ?? task.note };
    case "cancelled":
      return { kind: "cancelled", label: "stopped", detail: task.note };
    case "done":
      return task.prUrl
        ? { kind: "done", label: "done" }
        : { kind: "not_delivered", label: "not delivered", detail: task.note ?? task.error };
  }
}

/** Whether a row can be queued: nothing in flight and no PR yet. */
export function canFix(row: IssueRow): boolean {
  const s = row.task?.state;
  if (s === "queued" || s === "running") return false;
  return !(s === "done" && row.task?.prUrl);
}

export const POLL_ACTIVE_MS = 5_000;
export const POLL_IDLE_MS = 60_000;

export function pollInterval(rows: IssueRow[] | null | undefined): number {
  return (rows ?? []).some((r) => r.task?.state === "queued" || r.task?.state === "running") ? POLL_ACTIVE_MS : POLL_IDLE_MS;
}

/* ---------------------------------- fix ----------------------------------- */

export interface FixResult {
  ok: boolean;
  tasks: TaskRow[];
  skipped: { number: number; reason: string }[];
  error?: IssuesError;
}

export function normalizeFix(body: unknown, status: number): FixResult {
  const r = rec(body) ?? {};
  if (status < 200 || status >= 300 || (str(r.error) && !Array.isArray(r.tasks))) {
    return { ok: false, tasks: [], skipped: [], error: issuesError(body, status) };
  }
  const tasksRaw = Array.isArray(r.tasks) ? r.tasks : Array.isArray(r.queued) ? r.queued : [];
  const skippedRaw = Array.isArray(r.skipped) ? r.skipped : [];
  const skipped: FixResult["skipped"] = [];
  for (const item of skippedRaw) {
    const s = rec(item);
    const number = num(s?.number) ?? num(item);
    if (number === undefined) continue;
    skipped.push({ number, reason: str(s?.reason) ?? str(s?.message) ?? "skipped" });
  }
  return {
    ok: true,
    tasks: tasksRaw.map(normalizeTask).filter((t): t is TaskRow => t !== null),
    skipped,
  };
}

/* --------------------------------- calls ---------------------------------- */

export async function fetchIssues(
  repoKey: string,
  label: string,
): Promise<{ ok: true; data: IssuesList } | { ok: false; error: IssuesError }> {
  if (isMockMode()) return { ok: true, data: normalizeIssues(mockIssues(label)) };
  try {
    const qs = new URLSearchParams({ repoKey });
    if (label.trim()) qs.set("label", label.trim());
    const response = await fetch(`/api/issues?${qs.toString()}`);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, error: issuesError(body, response.status) };
    return { ok: true, data: normalizeIssues(body) };
  } catch {
    return { ok: false, error: { kind: "other", message: "Network error" } };
  }
}

export async function fixIssues(
  repoKey: string,
  numbers: number[] | "all",
  options: { combined?: boolean; model?: string; prompt?: string } = {},
): Promise<FixResult> {
  const payload = {
    repoKey,
    ...(numbers === "all" ? { all: true } : { numbers }),
    deliver: true,
    ...(options.combined ? { combined: true } : {}),
    ...(options.model && options.model !== "auto" ? { model: options.model } : {}),
    ...(options.prompt?.trim() ? { prompt: options.prompt.trim() } : {}),
  };
  if (isMockMode()) return normalizeFix(mockFixIssues(numbers === "all" ? [] : numbers, Boolean(options.combined)), 200);
  try {
    const response = await fetch("/api/issues/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return normalizeFix(await response.json().catch(() => null), response.status);
  } catch {
    return { ok: false, tasks: [], skipped: [], error: { kind: "other", message: "Network error" } };
  }
}

export async function fetchWatch(repoKey: string): Promise<{ ok: boolean; watch?: WatchConfig; error?: string }> {
  if (isMockMode()) return { ok: true, watch: normalizeWatch(mockWatch()) };
  try {
    const response = await fetch(`/api/issues/watch?repoKey=${encodeURIComponent(repoKey)}`);
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, error: issuesError(body, response.status).message };
    return { ok: true, watch: normalizeWatch(body) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export async function saveWatch(
  repoKey: string,
  config: Pick<WatchConfig, "enabled" | "label" | "intervalMinutes">,
): Promise<{ ok: boolean; watch?: WatchConfig; error?: string }> {
  const payload = {
    repoKey,
    enabled: config.enabled,
    label: config.label.trim() || WATCH_DEFAULT.label,
    intervalMinutes: clampInterval(config.intervalMinutes),
  };
  if (isMockMode()) return { ok: true, watch: normalizeWatch(mockSaveWatch(payload)) };
  try {
    const response = await fetch("/api/issues/watch", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, error: issuesError(body, response.status).message };
    return { ok: true, watch: normalizeWatch(body) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/**
 * Fix mode's "fix every GitHub issue": one task solves the open issues one by
 * one on a single branch and opens ONE pull request; its live run is attached
 * to the run view. Returns an error message, or null when it started.
 */
export async function fixAllIssuesInOnePr(repoKey: string, model?: string, prompt?: string): Promise<string | null> {
  const result = await fixIssues(repoKey, "all", { combined: true, model, prompt });
  if (!result.ok) return result.error?.message ?? "Could not queue the fix.";
  const task = result.tasks[0];
  if (!task) return result.skipped.length ? `Nothing to fix: ${result.skipped.map((s) => `#${s.number} ${s.reason}`).join("; ")}` : "No open issues.";
  const { attachTaskRun } = await import("@/lib/client/agent-stream");
  void attachTaskRun(task);
  return null;
}

/** Route an explicit request to fix the repository's issues through the issue pipeline. */
export function isAllIssuesFixRequest(prompt: string): boolean {
  return /\b(fix|resolve|solve|repair|address|implement)\b/i.test(prompt)
    && /\b(all|every|each)\b[\s\S]{0,60}\bissues?\b|\bissues?\b[\s\S]{0,60}\b(all|every|each)\b/i.test(prompt);
}

/** A repository named in the prompt takes precedence over the open workspace. */
export function issuePromptRepo(prompt: string): string | null {
  const match = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\.git)?(?:[/?#\s]|$)/i.exec(prompt);
  if (match) return `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}`;
  const short = /\b(?:repo(?:sitory)?\s*(?:at|on|is|:)?|issues?\s+(?:of|in|for|from))\s+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\b/i.exec(prompt);
  return short ? `${short[1]}/${short[2]}` : null;
}

const PENDING_BATCH_KEY = "viberon.pendingIssueBatch.v1";

export function stashPendingIssueBatch(repoKey: string, prompt: string, model?: string): void {
  window.sessionStorage.setItem(PENDING_BATCH_KEY, JSON.stringify({ repoKey, prompt, model }));
}

export function takePendingIssueBatch(repoKey: string): { prompt: string; model?: string } | null {
  const raw = window.sessionStorage.getItem(PENDING_BATCH_KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as { repoKey?: string; prompt?: string; model?: string };
    if (pending.repoKey !== repoKey || typeof pending.prompt !== "string") return null;
    window.sessionStorage.removeItem(PENDING_BATCH_KEY);
    return { prompt: pending.prompt, model: pending.model };
  } catch {
    window.sessionStorage.removeItem(PENDING_BATCH_KEY);
    return null;
  }
}

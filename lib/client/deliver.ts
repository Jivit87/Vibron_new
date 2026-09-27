/**
 * Client side of the ship loop: `POST /api/deliver`, `POST /api/deliver/report`,
 * `GET /api/ci`, `POST /api/ci/rerun` and the task queue (`/api/tasks`).
 *
 * The routes are built in parallel with this UI, so the readers are tolerant
 * (aliases, wrappers, string or number timestamps) and every call returns a
 * result object instead of throwing. `?mock=1` answers from fixtures in
 * `mock-run.ts`.
 */

import {
  isMockMode,
  mockCancelTask,
  mockCi,
  mockDeliver,
  mockEnqueue,
  mockReport,
  mockRerun,
  mockTaskById,
  mockTasks,
} from "@/lib/client/mock-run";
import type { Evidence } from "@/lib/client/run-reducer";
import { formatTok, formatUsd } from "@/lib/client/usage";

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

/* ------------------------------ branch names ------------------------------ */

const BRANCH_PREFIX = "viberon/";
const BRANCH_MAX = 48;

/** A human task title from a run prompt: the first line, minus "Fix this issue:". */
export function taskTitle(prompt: string): string {
  const first = prompt.split("\n").find((l) => l.trim()) ?? "";
  return first
    .replace(/^fix this issue:\s*/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .trim();
}

/** `viberon/<slug>`, at most 48 characters, cut on a word boundary when possible. */
export function branchSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[`'"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const room = BRANCH_MAX - BRANCH_PREFIX.length;
  let cut = slug.slice(0, room);
  if (slug.length > room) {
    const lastDash = cut.lastIndexOf("-");
    if (lastDash >= room / 2) cut = cut.slice(0, lastDash);
  }
  cut = cut.replace(/-+$/g, "");
  return `${BRANCH_PREFIX}${cut || "fix"}`;
}

/** Git ref rules the UI can check before a round-trip. */
export function branchError(name: string): string | null {
  const b = name.trim();
  if (!b) return "Enter a branch name.";
  if (/\s/.test(b)) return "Branch names cannot contain spaces.";
  if (/\.\.|[~^:?*[\\]|@\{|\/\/|^\/|\/$|\.lock$|^-|\.$/.test(b)) return "Not a valid git branch name.";
  return null;
}

/* -------------------------------- deliver -------------------------------- */

/** `ok` carries branch/commit/prUrl; a failure carries error/needsConfirm/files. */
export interface DeliverResult {
  ok: boolean;
  branch?: string;
  commit?: string;
  prUrl?: string;
  prNumber?: number;
  updated?: boolean;
  error?: string;
  /** The server wants an explicit second confirmation (e.g. workflow files changed). */
  needsConfirm?: boolean;
  files?: string[];
  /** Success without a PR: the branch was pushed (`pushOnly`, a non-GitHub remote). */
  pushedOnly?: boolean;
  /** The remote is not on GitHub: no PR can be opened, but the branch can be pushed. */
  notGithub?: boolean;
}

export function normalizeDeliver(body: unknown, status: number): DeliverResult {
  const r = rec(body) ?? {};
  const inner = rec(r.result) ?? r;
  const prUrl = str(inner.prUrl) ?? str(inner.url) ?? str(inner.html_url) ?? str(rec(inner.pr)?.url) ?? str(rec(inner.pr)?.html_url);
  const pushedOnly = inner.pushedOnly === true || r.pushedOnly === true;
  if (status >= 200 && status < 300 && !r.error && pushedOnly && !prUrl) {
    return { ok: true, pushedOnly: true, branch: str(inner.branch) ?? "", commit: str(inner.commit) ?? str(inner.sha) };
  }
  if (status >= 200 && status < 300 && prUrl && !r.error) {
    return {
      ok: true,
      branch: str(inner.branch) ?? "",
      commit: str(inner.commit) ?? str(inner.sha),
      prUrl,
      prNumber: num(inner.prNumber) ?? num(inner.number) ?? num(rec(inner.pr)?.number),
      updated: inner.updated === true || inner.created === false,
    };
  }
  const error = str(r.error) ?? str(r.message) ?? (status === 404 ? "The deliver API is not available on this server." : `Deliver failed (HTTP ${status})`);
  const code = str(r.code) ?? str(r.reason) ?? "";
  const filesRaw = r.workflowFiles ?? r.files ?? r.paths;
  const files = Array.isArray(filesRaw) ? filesRaw.filter((f): f is string => typeof f === "string") : [];
  const needsConfirm =
    r.needsConfirmation === true ||
    r.needsConfirm === true ||
    r.requiresConfirmation === true ||
    /workflow|confirm/i.test(code) ||
    (status === 409 && /workflow|\.github\//i.test(error));
  return { ok: false, error, needsConfirm, files, ...(code === "not_github" ? { notGithub: true } : {}) };
}

export interface DeliverInput {
  repoKey: string;
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  files?: string[];
  issueUrl?: string;
  /** Second, explicit confirmation after the server refused (workflow files). */
  confirm?: boolean;
  /** Push the branch without opening a pull request (non-GitHub remotes). */
  pushOnly?: boolean;
}

export async function deliverPr(input: DeliverInput): Promise<DeliverResult> {
  if (isMockMode()) return mockDeliver(input);
  const payload = {
    repoKey: input.repoKey,
    branch: input.branch,
    title: input.title,
    body: input.body,
    draft: input.draft,
    // The server refuses changes outside these files, and CI workflow edits
    // unless the user confirmed them a second time.
    expectedFiles: input.files,
    ...(input.confirm ? { allowWorkflowChanges: true } : {}),
    ...(input.pushOnly ? { pushOnly: true } : {}),
  };
  try {
    const response = await fetch("/api/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    return normalizeDeliver(body, response.status);
  } catch {
    return { ok: false, error: "Network error", needsConfirm: false, files: [] };
  }
}

/** The shape `/api/deliver/report` renders as the checks table on the issue. */
export interface DeliveryEvidence {
  status: string;
  filesChanged: string[];
  checks: { command: string; original: string; patched: string; verdict: string }[];
}

/** A run's evidence in the report route's shape: one row per original-vs-patched check. */
export function deliveryEvidence(e: Evidence, files: string[]): DeliveryEvidence {
  return {
    status: e.outcome === "verified" ? "resolved" : e.outcome,
    filesChanged: files,
    checks: (e.final?.checks ?? []).map((c) => ({
      command: c.name,
      original: c.before ?? "",
      patched: c.after ?? "",
      verdict: c.verdict === "pass" ? "passes" : c.verdict,
    })),
  };
}

export async function reportOnIssue(input: {
  repoKey: string;
  issueUrl: string;
  prUrl: string;
  summary: string;
  evidence: DeliveryEvidence;
}): Promise<{ ok: boolean; commentUrl?: string; error?: string }> {
  if (isMockMode()) return mockReport(input.issueUrl);
  try {
    const response = await fetch("/api/deliver/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = rec(await response.json().catch(() => null)) ?? {};
    if (!response.ok || body.error) {
      return { ok: false, error: str(body.error) ?? `Comment failed (HTTP ${response.status})` };
    }
    return { ok: true, commentUrl: str(body.commentUrl) ?? str(body.url) ?? str(body.html_url) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/* ----------------------------------- CI ----------------------------------- */

export type CheckState = "pending" | "success" | "failure" | "skipped";

export interface CiCheck {
  name: string;
  state: CheckState;
  conclusion: string;
  url?: string;
  logExcerpt?: string;
}

export interface CiStatus {
  headSha: string;
  state: "pending" | "success" | "failure";
  checks: CiCheck[];
  reruns?: number;
  rerunLimit?: number;
  /** Server-built task text from the failing checks' extracted log failures. */
  fixTask?: string;
}

export function checkState(conclusion: unknown, status?: unknown): CheckState {
  const c = typeof conclusion === "string" ? conclusion.toLowerCase() : "";
  const s = typeof status === "string" ? status.toLowerCase() : "";
  if (c === "success" || c === "passed" || c === "pass" || c === "neutral") return "success";
  if (c === "skipped" || c === "stale") return "skipped";
  if (["failure", "failed", "fail", "timed_out", "cancelled", "action_required", "error", "startup_failure"].includes(c))
    return "failure";
  if (!c && s === "completed") return "success";
  return "pending";
}

export function normalizeCi(body: unknown): CiStatus | null {
  const r = rec(rec(body)?.result) ?? rec(rec(body)?.ci) ?? rec(body);
  if (!r) return null;
  const list = Array.isArray(r.checks) ? r.checks : Array.isArray(r.check_runs) ? r.check_runs : null;
  if (!list) return null;
  const checks: CiCheck[] = [];
  for (const item of list) {
    const c = rec(item);
    const name = str(c?.name);
    if (!c || !name) continue;
    const conclusion = str(c.conclusion) ?? str(c.status) ?? str(c.state) ?? "pending";
    checks.push({
      name,
      state: checkState(c.conclusion ?? c.state, c.status),
      conclusion: conclusion.toLowerCase(),
      url: str(c.url) ?? str(c.html_url) ?? str(c.detailsUrl) ?? str(c.details_url),
      logExcerpt: str(c.logExcerpt) ?? str(c.log) ?? str(c.excerpt),
    });
  }
  const derived: CiStatus["state"] = checks.some((c) => c.state === "failure")
    ? "failure"
    : checks.some((c) => c.state === "pending") || checks.length === 0
      ? "pending"
      : "success";
  const stateRaw = typeof r.state === "string" ? r.state.toLowerCase() : "";
  const state: CiStatus["state"] =
    stateRaw === "pending" || stateRaw === "success" || stateRaw === "failure" ? stateRaw : derived;
  return {
    headSha: str(r.headSha) ?? str(r.head_sha) ?? str(r.sha) ?? "",
    state,
    checks,
    reruns: num(r.reruns),
    rerunLimit: num(r.rerunLimit) ?? num(r.maxReruns),
    fixTask: str(rec(body)?.fixTask) ?? str(r.fixTask),
  };
}

export async function fetchCi(prUrl: string): Promise<{ ok: boolean; ci?: CiStatus; error?: string }> {
  if (isMockMode()) return { ok: true, ci: normalizeCi(mockCi(prUrl)) as CiStatus };
  try {
    const response = await fetch(`/api/ci?prUrl=${encodeURIComponent(prUrl)}`);
    const body = (await response.json().catch(() => null)) as unknown;
    const ci = response.ok ? normalizeCi(body) : null;
    if (!ci) return { ok: false, error: str(rec(body)?.error) ?? `CI status failed (HTTP ${response.status})` };
    return { ok: true, ci };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/** A fix-task prompt from the failing checks, for `POST /api/tasks`. */
export function ciFailureTask(ci: CiStatus, prUrl: string): string {
  const failing = ci.checks.filter((c) => c.state === "failure");
  const parts = [`Fix the failing CI checks on ${prUrl}${ci.headSha ? ` (head ${ci.headSha.slice(0, 7)})` : ""}.`];
  for (const check of failing) {
    parts.push(`Check "${check.name}" (${check.conclusion}):${check.logExcerpt ? `\n${check.logExcerpt.trim()}` : " no log excerpt"}`);
  }
  return parts.join("\n\n");
}

export interface RerunResult {
  ok: boolean;
  error?: string;
  reruns?: number;
  limit?: number;
}

export function normalizeRerun(body: unknown, status: number): RerunResult {
  const r = rec(body) ?? {};
  const reruns = num(r.reruns) ?? num(r.count) ?? num(r.attempt) ?? num(r.used);
  const remaining = num(r.remaining);
  // The server reports { attempt, remaining }; the limit is their sum.
  const limit =
    num(r.limit) ?? num(r.max) ?? num(r.maxReruns) ?? (reruns !== undefined && remaining !== undefined ? reruns + remaining : undefined);
  const ok = status >= 200 && status < 300 && r.ok !== false && !r.error;
  return {
    ok,
    error: ok ? undefined : (str(r.error) ?? `Re-run failed (HTTP ${status})`),
    reruns: reruns ?? (remaining !== undefined && limit !== undefined ? limit - remaining : undefined),
    limit,
  };
}

export async function rerunCheck(input: { prUrl: string; checkName: string; evidence: string }): Promise<RerunResult> {
  if (isMockMode()) return mockRerun(input.checkName);
  try {
    const response = await fetch("/api/ci/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return normalizeRerun(await response.json().catch(() => null), response.status);
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/* --------------------------------- tasks ---------------------------------- */

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface TaskRow {
  id: string;
  kind: string;
  repoKey: string;
  task: string;
  source: string;
  state: TaskState;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  prUrl?: string;
  issueUrl?: string;
  error?: string;
  /** Why a task that succeeded was not delivered, or a caveat. */
  note?: string;
  /** Token use and cost: live while running, final after. */
  usage?: TaskUsageRow;
  /** Files the task changed, when the server reports them. */
  files?: string[];
  /** A batch task's per-issue outcome (`docs/PLAN-ISSUES.md`), several issues at once. */
  issueResults?: BatchIssueResult[];
  /** The model the task ran with, when the server reports it. */
  model?: string;
}

export interface TaskUsageRow {
  tokens: number;
  costUsd: number;
}

/* ------------------------------ issue batch -------------------------------- */

/** A batch issue row's lifecycle, richer than a task's own `TaskState`. */
export type BatchIssueStatus = "queued" | "running" | "verified" | "unproven" | "failed" | "cancelled";

export interface BatchTiming {
  modelMs: number;
  toolsMs: number;
  proofMs: number;
}

export interface BatchUsageRow {
  input: number;
  output: number;
  cached: number;
  calls: number;
}

export interface BatchFastPath {
  used: boolean;
  calls: number;
  accepted: boolean;
}

/** One issue's row in a batch: `GET /api/tasks/:id` → `task.issueResults[]`. */
export interface BatchIssueResult {
  url: string;
  number?: number;
  title?: string;
  status: BatchIssueStatus;
  phase?: string;
  startedAt?: number;
  finishedAt?: number;
  timing?: BatchTiming;
  usage?: BatchUsageRow;
  prUrl?: string;
  fastPath?: BatchFastPath;
  detail?: string;
}

export function normalizeBatchIssueStatus(value: unknown, fallbackState?: unknown): BatchIssueStatus {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "queued" || s === "pending") return "queued";
  if (s === "running" || s === "in_progress" || s === "active") return "running";
  if (s === "verified" || s === "done" || s === "resolved" || s === "fixed") return "verified";
  if (s === "unproven" || s === "no_proof" || s === "gave_up" || s === "incomplete") return "unproven";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled" || s === "stopped") return "cancelled";
  // A batch issue row without its own status yet: fall back to the task's.
  const t = normalizeTaskState(fallbackState);
  return t === "done" ? "verified" : t;
}

function batchTiming(raw: unknown): BatchTiming | undefined {
  const t = rec(raw);
  if (!t) return undefined;
  const modelMs = num(t.modelMs) ?? 0;
  const toolsMs = num(t.toolsMs) ?? 0;
  const proofMs = num(t.proofMs) ?? 0;
  return modelMs || toolsMs || proofMs ? { modelMs, toolsMs, proofMs } : undefined;
}

function batchUsage(raw: unknown): BatchUsageRow | undefined {
  const u = rec(raw);
  if (!u) return undefined;
  const input = num(u.input) ?? num(u.inputTokens) ?? 0;
  const output = num(u.output) ?? num(u.outputTokens) ?? 0;
  const cached = num(u.cached) ?? num(u.cacheReadTokens) ?? 0;
  const calls = num(u.calls) ?? num(u.modelCalls) ?? 0;
  return input || output || cached || calls ? { input, output, cached, calls } : undefined;
}

function batchFastPath(raw: unknown): BatchFastPath | undefined {
  const f = rec(raw);
  if (!f) return undefined;
  return { used: f.used === true, calls: num(f.calls) ?? 0, accepted: f.accepted === true };
}

export function normalizeBatchIssueResult(raw: unknown): BatchIssueResult | null {
  const r = rec(raw);
  if (!r) return null;
  const url = str(r.url) ?? str(r.issueUrl) ?? str(r.html_url);
  if (!url) return null;
  return {
    url,
    number: num(r.number) ?? num(r.issueNumber),
    title: str(r.title),
    status: normalizeBatchIssueStatus(r.status, r.state),
    phase: str(r.phase),
    startedAt: time(r.startedAt),
    finishedAt: time(r.finishedAt),
    timing: batchTiming(r.timing),
    usage: batchUsage(r.usage),
    prUrl: str(r.prUrl) ?? str(r.pr_url),
    fastPath: batchFastPath(r.fastPath),
    detail: str(r.detail) ?? str(r.note) ?? str(r.error),
  };
}

function taskIssueResults(r: Record<string, unknown>): BatchIssueResult[] | undefined {
  const list = Array.isArray(r.issueResults) ? r.issueResults : undefined;
  if (!list) return undefined;
  const rows = list.map(normalizeBatchIssueResult).filter((x): x is BatchIssueResult => x !== null);
  return rows.length ? rows : undefined;
}

/** Elapsed ms for a batch row: finished-started, else now-started, else 0 (not started). */
export function batchIssueElapsedMs(row: Pick<BatchIssueResult, "startedAt" | "finishedAt">, now: number): number {
  if (!row.startedAt) return 0;
  return Math.max(0, (row.finishedAt ?? now) - row.startedAt);
}

/** The time-breakdown bar's three segments as a percentage of their sum (100 when nothing was measured). */
export function batchTimingPct(timing: BatchTiming | undefined): { modelPct: number; toolsPct: number; proofPct: number } {
  const total = (timing?.modelMs ?? 0) + (timing?.toolsMs ?? 0) + (timing?.proofMs ?? 0);
  if (!timing || total <= 0) return { modelPct: 0, toolsPct: 0, proofPct: 0 };
  return {
    modelPct: (timing.modelMs / total) * 100,
    toolsPct: (timing.toolsMs / total) * 100,
    proofPct: (timing.proofMs / total) * 100,
  };
}

/** Sums tokens/calls across a batch's rows (its usage, when the task's own totals are unset). */
export function batchIssueTotals(rows: readonly BatchIssueResult[]): { tokens: number; calls: number } {
  return rows.reduce(
    (acc, r) => ({
      tokens: acc.tokens + (r.usage ? r.usage.input + r.usage.output + r.usage.cached : 0),
      calls: acc.calls + (r.usage?.calls ?? 0),
    }),
    { tokens: 0, calls: 0 },
  );
}

/**
 * A task's usage: the server's `usage` (summed from the task's `turn_usage`
 * events while it runs, final after), else the solve result's metrics (a
 * task persisted before usage was recorded).
 */
export function taskUsage(raw: unknown): TaskUsageRow | undefined {
  const r = rec(raw);
  const u = rec(r?.usage) ?? rec(rec(r?.result)?.metrics);
  if (!u) return undefined;
  const tokens =
    (num(u.inputTokens) ?? 0) + (num(u.outputTokens) ?? 0) + (num(u.cacheReadTokens) ?? 0) + (num(u.cacheWriteTokens) ?? 0);
  const costUsd = num(u.costUsd) ?? 0;
  return tokens > 0 || costUsd > 0 ? { tokens, costUsd } : undefined;
}

/** "48.2k tok · $0.07" (the format of the status bar's usage line). */
export function taskUsageLine(usage: TaskUsageRow | undefined): string {
  if (!usage) return "";
  return `${formatTok(usage.tokens)} tok · ${formatUsd(usage.costUsd)}`;
}

export function normalizeTaskState(value: unknown): TaskState {
  const s = typeof value === "string" ? value.toLowerCase() : "";
  if (s === "running" || s === "in_progress" || s === "active") return "running";
  if (s === "done" || s === "completed" || s === "succeeded" || s === "success" || s === "resolved") return "done";
  if (s === "failed" || s === "error" || s === "failure") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "queued";
}

export function normalizeTask(raw: unknown): TaskRow | null {
  const r = rec(raw);
  if (!r) return null;
  const id = str(r.id) ?? (typeof r.id === "number" ? String(r.id) : undefined);
  if (!id) return null;
  const result = rec(r.result);
  return {
    id,
    kind: str(r.kind) ?? "fix",
    repoKey: str(r.repoKey) ?? "",
    task: (str(r.task) ?? str(r.title) ?? str(r.prompt) ?? "").trim(),
    source: str(r.source) ?? "api",
    state: normalizeTaskState(r.state ?? r.status),
    createdAt: time(r.createdAt) ?? time(r.created_at) ?? 0,
    startedAt: time(r.startedAt),
    finishedAt: time(r.finishedAt),
    prUrl: str(r.prUrl) ?? str(result?.prUrl),
    issueUrl: str(r.issueUrl),
    error: str(r.error) ?? (typeof rec(r.error)?.message === "string" ? String(rec(r.error)?.message) : undefined),
    note: str(r.note),
    usage: taskUsage(r),
    ...taskFiles(r, result),
    ...(taskIssueResults(r) ? { issueResults: taskIssueResults(r) } : {}),
    ...(str(r.model) ? { model: str(r.model) } : {}),
  };
}

/** One task by id, for a batch's live poll (`GET /api/tasks/:id`). Null on any failure. */
export async function fetchTask(id: string): Promise<TaskRow | null> {
  if (isMockMode()) return normalizeTask(mockTaskById(id));
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as unknown;
    return normalizeTask(rec(body)?.task ?? body);
  } catch {
    return null;
  }
}

/** Changed files from `files` / `changedFiles` / `result.files`, as paths or `{ path }`. */
function taskFiles(r: Record<string, unknown>, result: Record<string, unknown> | null | undefined): { files?: string[] } {
  const raw = [r.files, r.changedFiles, result?.files, result?.changedFiles, result?.filesChanged].find(Array.isArray) as unknown[] | undefined;
  if (!raw) return {};
  const files = raw
    .map((f) => (typeof f === "string" ? f : str(rec(f)?.path)))
    .filter((f): f is string => Boolean(f));
  return files.length ? { files: [...new Set(files)] } : {};
}

const STATE_ORDER: Record<TaskState, number> = { running: 0, queued: 1, failed: 2, done: 3, cancelled: 4 };

/** Running first, then queued in FIFO order, then finished newest first. */
export function normalizeTasks(body: unknown): TaskRow[] {
  const list = Array.isArray(body) ? body : (rec(body)?.tasks ?? rec(body)?.items ?? []);
  const rows = (Array.isArray(list) ? list : []).map(normalizeTask).filter((t): t is TaskRow => t !== null);
  return rows.sort((a, b) => {
    const ao = Math.min(STATE_ORDER[a.state], 2);
    const bo = Math.min(STATE_ORDER[b.state], 2);
    if (ao !== bo) return ao - bo;
    if (a.state === "queued" && b.state === "queued") return a.createdAt - b.createdAt;
    return (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt);
  });
}

export async function listTasks(repoKey: string): Promise<{ ok: boolean; tasks?: TaskRow[]; error?: string; missing?: boolean }> {
  if (isMockMode()) return { ok: true, tasks: normalizeTasks(mockTasks()) };
  try {
    const response = await fetch(`/api/tasks?repoKey=${encodeURIComponent(repoKey)}`);
    if (response.status === 404) return { ok: false, error: "The task queue is not available on this server.", missing: true };
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, error: str(rec(body)?.error) ?? `HTTP ${response.status}` };
    return { ok: true, tasks: normalizeTasks(body) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export async function enqueueTask(input: {
  kind: "fix" | "review";
  repoKey: string;
  task: string;
  source?: "ui";
  issueUrl?: string;
  deliver?: boolean;
}): Promise<{ ok: boolean; task?: TaskRow | null; error?: string }> {
  const payload = { source: "ui", ...input };
  if (isMockMode()) return { ok: true, task: normalizeTask(mockEnqueue(payload)) };
  try {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) return { ok: false, error: str(rec(body)?.error) ?? `Could not queue the task (HTTP ${response.status})` };
    return { ok: true, task: normalizeTask(rec(body)?.task ?? body) };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

export async function cancelTask(id: string): Promise<{ ok: boolean; error?: string }> {
  if (isMockMode()) {
    mockCancelTask(id);
    return { ok: true };
  }
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) return { ok: true };
    const body = rec(await response.json().catch(() => null));
    return { ok: false, error: str(body?.error) ?? `Cancel failed (HTTP ${response.status})` };
  } catch {
    return { ok: false, error: "Network error" };
  }
}

/** Stop all: cancel every queued and running task of the repo. */
export async function stopAllTasks(repoKey: string): Promise<{ ok: boolean; stopped: number; error?: string }> {
  if (isMockMode()) {
    const active = normalizeTasks(mockTasks()).filter((t) => t.state === "queued" || t.state === "running");
    for (const t of active) mockCancelTask(t.id);
    return { ok: true, stopped: active.length };
  }
  try {
    const response = await fetch(`/api/tasks?repoKey=${encodeURIComponent(repoKey)}`, { method: "DELETE" });
    const body = rec(await response.json().catch(() => null));
    if (!response.ok) return { ok: false, stopped: 0, error: str(body?.error) ?? `Stop failed (HTTP ${response.status})` };
    return { ok: true, stopped: Array.isArray(body?.tasks) ? body.tasks.length : 0 };
  } catch {
    return { ok: false, stopped: 0, error: "Network error" };
  }
}

/** "owner/repo#12" from an issue or PR URL. */
export function shortRef(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : url;
}

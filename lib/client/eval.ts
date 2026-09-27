/**
 * Eval results for the /eval page.
 *
 * `GET /api/eval` is built in parallel with this page, so the reader is
 * tolerant: it accepts an array or `{results|tasks|rows}`, and per row either
 * flat fields (`task`, `resolved`, `gate`, `tokens`, `durationMs`) or a
 * `SolveResult`-shaped record (`status`, `gate.reason`, `metrics.*`).
 */

export interface EvalRow {
  task: string;
  category?: string;
  resolved: boolean;
  status: string;
  gate: string;
  tokens: number;
  durationMs: number;
  /** `SolveResult.metrics.phaseMs`, when the result carries it. */
  phaseMs?: Record<string, number>;
}

export interface EvalTable {
  rows: EvalRow[];
  model?: string;
  generatedAt?: string;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function normalizeEvalRow(raw: unknown): EvalRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const result = (r.result && typeof r.result === "object" ? r.result : r) as Record<string, unknown>;
  const metrics = (result.metrics ?? {}) as Record<string, unknown>;
  const gateRaw = result.gate ?? r.gate;
  const task = str(r.task) ?? str(r.taskId) ?? str(r.id) ?? str(r.name);
  if (!task) return null;
  const status = str(result.status) ?? str(r.status) ?? (r.resolved === true ? "resolved" : "failed");
  const resolved = typeof r.resolved === "boolean" ? r.resolved : status === "resolved";
  let gate = "";
  if (typeof gateRaw === "string") gate = gateRaw;
  else if (gateRaw && typeof gateRaw === "object") {
    const g = gateRaw as Record<string, unknown>;
    gate =
      str(g.decision) ??
      (g.enabled === false ? "off" : undefined) ??
      (typeof g.rejections === "number" ? `${g.rejections} rejected` : undefined) ??
      "";
  }
  const tokens =
    num(r.tokens) ||
    num(metrics.inputTokens) + num(metrics.outputTokens) ||
    num(r.inputTokens) + num(r.outputTokens);
  const durationMs = num(r.durationMs) || num(metrics.durationMs) || num(r.timeMs);
  const phaseMs = readPhaseMs(metrics.phaseMs ?? r.phaseMs);
  return { task, category: str(r.category), resolved, status, gate, tokens, durationMs, ...(phaseMs ? { phaseMs } : {}) };
}

/** `metrics.phaseMs`: finite, non-negative numbers only; null when nothing usable. */
export function readPhaseMs(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [name, ms] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0) out[name] = Math.round(ms);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function normalizeEval(body: unknown): EvalTable {
  const b = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(body) ? body : (b.results ?? b.tasks ?? b.rows ?? []);
  const rows = (Array.isArray(list) ? list : [])
    .map(normalizeEvalRow)
    .filter((r): r is EvalRow => r !== null);
  return { rows, model: str(b.model), generatedAt: str(b.generatedAt) ?? str(b.at) };
}

export function evalTotals(rows: readonly EvalRow[]) {
  const resolved = rows.filter((r) => r.resolved).length;
  const tokens = rows.reduce((s, r) => s + r.tokens, 0);
  const durationMs = rows.reduce((s, r) => s + r.durationMs, 0);
  return {
    count: rows.length,
    resolved,
    rate: rows.length ? resolved / rows.length : 0,
    tokens,
    durationMs,
    meanTokens: rows.length ? tokens / rows.length : 0,
  };
}

export const MOCK_EVAL = {
  model: "claude-sonnet-5",
  generatedAt: "2026-09-26T09:12:00Z",
  results: [
    { task: "config-merge", category: "bench", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 41_200, outputTokens: 3_100, durationMs: 48_000 } },
    { task: "todo-json", category: "bench", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 28_900, outputTokens: 2_200, durationMs: 31_500 } },
    { task: "semver-js", category: "bench", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 52_300, outputTokens: 4_800, durationMs: 66_200 } },
    { task: "slugify", category: "bench", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 19_700, outputTokens: 1_400, durationMs: 22_900 } },
    { task: "py-inventory/stacktrace", category: "stacktrace", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 23_000, outputTokens: 1_900, durationMs: 27_400 } },
    { task: "py-inventory/regression-trap", category: "regression-trap", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 61_000, outputTokens: 5_300, durationMs: 88_100 } },
    { task: "ts-textkit/multi-file", category: "multi-file", status: "unverified", gate: { decision: "accept_unverified" }, metrics: { inputTokens: 44_800, outputTokens: 3_900, durationMs: 57_000 } },
    { task: "ts-textkit/recovery", category: "recovery", status: "incomplete", gate: { decision: "give_up" }, metrics: { inputTokens: 97_400, outputTokens: 8_800, durationMs: 142_000 } },
    { task: "ts-textkit/injection-trap", category: "injection-trap", status: "resolved", gate: { decision: "accept" }, metrics: { inputTokens: 21_600, outputTokens: 1_700, durationMs: 25_300 } },
    { task: "py-inventory/feature", category: "feature", status: "failed", gate: { decision: "reject" }, metrics: { inputTokens: 58_100, outputTokens: 6_000, durationMs: 90_000 } },
  ],
};

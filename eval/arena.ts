/** Compare harnesses on the same tasks. Accepts ai-harness/arena JSONL rows. */

export interface ArenaRow {
  harness: string;
  instance_id: string;
  resolved: boolean;
  tokens?: number;
  input?: number;
  output?: number;
  harness_seconds?: number;
  wall_seconds?: number;
  error?: string;
}

export interface ArenaSummary {
  harness: string;
  resolved: number;
  total: number;
  available: number;
  meanTokens: number | null;
  meanSeconds: number | null;
}

export interface ArenaReport {
  commonTasks: string[];
  harnesses: ArenaSummary[];
}

function validNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function parseArenaJsonl(text: string): ArenaRow[] {
  const rows: ArenaRow[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      throw new Error(`Invalid arena JSON on line ${index + 1}`);
    }
    if (!raw || typeof raw !== "object") throw new Error(`Invalid arena row on line ${index + 1}`);
    const row = raw as Record<string, unknown>;
    if (typeof row.harness !== "string" || !row.harness.trim() ||
        typeof row.instance_id !== "string" || !row.instance_id.trim() ||
        typeof row.resolved !== "boolean") {
      throw new Error(`Invalid arena row on line ${index + 1}: harness, instance_id and resolved are required`);
    }
    rows.push({
      harness: row.harness,
      instance_id: row.instance_id,
      resolved: row.resolved,
      tokens: validNumber(row.tokens),
      input: validNumber(row.input),
      output: validNumber(row.output),
      harness_seconds: validNumber(row.harness_seconds),
      wall_seconds: validNumber(row.wall_seconds),
      ...(typeof row.error === "string" && row.error ? { error: row.error } : {}),
    });
  }
  return rows;
}

export function summarizeArena(rows: ArenaRow[]): ArenaReport {
  const byHarness = new Map<string, Map<string, ArenaRow>>();
  for (const row of rows) {
    let tasks = byHarness.get(row.harness);
    if (!tasks) byHarness.set(row.harness, (tasks = new Map()));
    const previous = tasks.get(row.instance_id);
    // A later setup failure must not erase a completed run. Latest completed retry wins.
    if (!row.error || !previous || previous.error) tasks.set(row.instance_id, row);
  }
  const completed = [...byHarness.values()].map((tasks) =>
    new Set([...tasks].filter(([, row]) => !row.error).map(([id]) => id)));
  const commonTasks = completed.length
    ? [...completed[0]].filter((id) => completed.every((tasks) => tasks.has(id))).sort()
    : [];
  const harnesses: ArenaSummary[] = [...byHarness].map(([harness, tasks]) => {
    const cohort = commonTasks.map((id) => tasks.get(id)!);
    const mean = (value: (row: ArenaRow) => number | undefined) => {
      const values = cohort.map(value);
      return values.length && values.every((v): v is number => v !== undefined)
        ? values.reduce((sum, v) => sum + v, 0) / values.length
        : null;
    };
    return {
      harness,
      resolved: cohort.filter((row) => row.resolved).length,
      total: cohort.length,
      available: [...tasks.values()].filter((row) => !row.error).length,
      meanTokens: mean((row) => row.tokens ?? (row.input !== undefined && row.output !== undefined
        ? row.input + row.output : undefined)),
      meanSeconds: mean((row) => row.harness_seconds ?? row.wall_seconds),
    };
  }).sort((a, b) => b.resolved - a.resolved ||
    (a.meanTokens ?? Infinity) - (b.meanTokens ?? Infinity) ||
    (a.meanSeconds ?? Infinity) - (b.meanSeconds ?? Infinity) || a.harness.localeCompare(b.harness));
  return { commonTasks, harnesses };
}

export function renderArenaMarkdown(report: ArenaReport): string {
  const lines = [
    "# Harness arena comparison",
    "",
    `Common task cohort: **${report.commonTasks.length}** task(s). Rankings use only this cohort.`,
    "",
    "| harness | resolved | available runs | tokens/run | seconds/run |",
    "|---|---:|---:|---:|---:|",
    ...report.harnesses.map((h) =>
      `| ${h.harness} | ${h.resolved}/${h.total} | ${h.available} | ${h.meanTokens?.toFixed(0) ?? "—"} | ${h.meanSeconds?.toFixed(1) ?? "—"} |`),
  ];
  if (!report.commonTasks.length) lines.push("", "No common completed tasks; a fair ranking is unavailable.");
  return `${lines.join("\n")}\n`;
}

/**
 * Compare SWE-bench runs per tag (port of Pramana `bench/swebench/swe_report.py`):
 * a per-instance grid (PASS/fail, tokens, wall) and, per tag, resolve rate,
 * mean tokens, mean wall and status counts; plus a head-to-head on the
 * instances every tag ran.
 */

import { readdir } from "node:fs/promises";
import path from "node:path";

import { readRows, type SweRow } from "@/eval/swe/run";

export async function loadTag(resultsDir: string, tag: string): Promise<Map<string, SweRow>> {
  const rows = new Map<string, SweRow>();
  const files = (await readdir(resultsDir).catch(() => [] as string[]))
    .filter((f) => f === `results-${tag}.jsonl` || (f.startsWith(`results-${tag}-`) && f.endsWith(".jsonl")))
    .sort();
  for (const f of files) for (const r of await readRows(path.join(resultsDir, f))) rows.set(r.instance_id, r);
  return rows;
}

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

export function renderSweReport(data: Record<string, Map<string, SweRow>>): string {
  const tags = Object.keys(data);
  const ids = [...new Set(tags.flatMap((t) => [...data[t]!.keys()]))].sort();
  const lines = [`${"instance".padEnd(36)} ${tags.map((t) => t.padStart(22)).join(" ")}`];
  for (const id of ids) {
    const cells = tags.map((t) => {
      const r = data[t]!.get(id);
      return (r ? `${r.resolved ? "PASS" : "fail"} ${k(r.tokens).padStart(6)} ${`${Math.round(r.seconds)}s`.padStart(6)}` : "-").padStart(22);
    });
    lines.push(`${id.padEnd(36)} ${cells.join(" ")}`);
  }
  for (const t of tags) {
    const rows = [...data[t]!.values()];
    if (!rows.length) continue;
    const n = rows.length;
    const solved = rows.filter((r) => r.resolved).length;
    const statuses: Record<string, number> = {};
    for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    const mean = (pick: (r: SweRow) => number) => rows.reduce((a, r) => a + pick(r), 0) / n;
    lines.push(
      `${t}: ${solved}/${n} resolved (${Math.round((100 * solved) / n)}%), mean tokens ${k(mean((r) => r.tokens))}, ` +
        `mean calls ${mean((r) => r.calls).toFixed(1)}, mean wall ${Math.round(mean((r) => r.seconds))}s, statuses ` +
        Object.entries(statuses).sort().map(([s, c]) => `${s}=${c}`).join(" "),
    );
  }
  if (tags.length > 1) {
    const common = ids.filter((id) => tags.every((t) => data[t]!.has(id)));
    if (common.length) {
      lines.push(
        `on ${common.length} common instances: ` +
          tags
            .map((t) => {
              const rows = common.map((id) => data[t]!.get(id)!);
              const solved = rows.filter((r) => r.resolved).length;
              return `${t} ${solved}/${common.length} (${k(rows.reduce((a, r) => a + r.tokens, 0) / common.length)} tok)`;
            })
            .join(", "),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

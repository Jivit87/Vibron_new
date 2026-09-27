/**
 * Named eval suites (Pramana `bench.py`): `quick` is one Python and one
 * JavaScript task, a fast end-to-end smoke test; `mini` is every bundled task.
 * Explicit `--only` names win over a suite.
 */

export const SUITES: Record<string, string[] | "all"> = {
  quick: ["slugify", "semver-js"],
  mini: "all",
};

export function resolveSuite(suite: string | undefined, only: string[] | undefined, known: string[]): string[] {
  if (only?.length) return only;
  const name = suite || "mini";
  const members = SUITES[name];
  if (!members) throw new Error(`unknown suite "${name}" (known: ${Object.keys(SUITES).join(", ")})`);
  return members === "all" ? known : members.filter((t) => known.includes(t));
}

/** Plain-text per-task table for the terminal: tokens, calls, wall time, verified. */
export function renderTable(
  rows: { task: string; status: string; resolved: boolean; tokens: number; modelCalls: number; toolCalls: number; seconds: number }[],
): string {
  const head = ["task", "harness verdict", "verified", "tokens", "calls", "tools", "wall"];
  const body = rows.map((r) => [
    r.task,
    r.status,
    r.resolved ? "PASS" : "FAIL",
    r.tokens.toLocaleString("en-US"),
    String(r.modelCalls),
    String(r.toolCalls),
    `${r.seconds.toFixed(0)}s`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const fmt = (cells: string[]) => cells.map((c, i) => (i >= 3 ? c.padStart(widths[i]!) : c.padEnd(widths[i]!))).join("  ");
  const solved = rows.filter((r) => r.resolved).length;
  const tokens = rows.reduce((a, r) => a + r.tokens, 0);
  const wall = rows.reduce((a, r) => a + r.seconds, 0);
  return [
    fmt(head),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(fmt),
    `resolved ${solved}/${rows.length} · ${tokens.toLocaleString("en-US")} tokens · ${wall.toFixed(0)}s`,
  ].join("\n");
}

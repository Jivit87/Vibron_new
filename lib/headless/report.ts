/**
 * Evidence bundle rendering (Pramana `report/evidence.py` style): a
 * reviewer reads report.md and knows what changed, why, and what proves it.
 */

import type { SolveResult, SolveStatus } from "@/lib/harness/solve-types";
import { evidenceChecks, VERDICT_ICON } from "@/lib/headless/evidence";
import type { VerificationReport, VerifyCommand } from "@/lib/verify/types";

export const STATUS_TEXT: Record<SolveStatus, string> = {
  resolved: "VERIFIED FIX: the gate ran the repo's checks after the last edit, with no new failures.",
  unverified: "PATCH WITHOUT PROOF: a change was made, but the repo has no runnable checks to prove it.",
  failed: "FAILED: the change did not pass verification.",
  incomplete: "INCOMPLETE: budget ran out; the best checkpoint was restored.",
  error: "ERROR: the run did not complete.",
};

export function diffstat(patch: string): { files: number; added: number; removed: number; paths: string[] } {
  let files = 0;
  let added = 0;
  let removed = 0;
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      files += 1;
      const b = line.split(" b/")[1];
      if (b) paths.push(b);
    } else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files, added, removed, paths };
}

function counts(report: VerificationReport | null): string {
  if (!report) return "-";
  const c = report.counts;
  const status = report.timedOut ? "timed out" : `exit ${report.exitCode}`;
  return `${c.passed} passed, ${c.failed} failed, ${c.errors} errors (${status})`;
}

export function renderReport(input: {
  taskId: string;
  task: string;
  repo: string;
  model: string;
  result: SolveResult;
  verifyCommands: VerifyCommand[];
  exitCode: number;
}): string {
  const { result } = input;
  const m = result.metrics;
  const title = input.task.trim().split("\n")[0]!.slice(0, 120) || input.taskId;
  const stat = diffstat(result.diff);
  const lines: string[] = [
    `# Viberon run: ${title}`,
    "",
    `**Result:** ${STATUS_TEXT[result.status]}`,
    "",
    `- Task id: \`${input.taskId}\` (exit code ${input.exitCode})`,
    `- Repository: \`${input.repo}\``,
    `- Model: \`${input.model}\``,
    `- Attempts: ${1 + result.recovery.rollbacks}`,
    `- Cost: ${(m.inputTokens + m.outputTokens).toLocaleString()} tokens (${m.inputTokens.toLocaleString()} in, ${m.cacheReadTokens.toLocaleString()} cached, ${m.outputTokens.toLocaleString()} out) in ${m.modelCalls} model calls, ${m.toolCalls} tool calls${m.costUsd ? `, $${m.costUsd.toFixed(4)}` : ""}`,
    `- Context: ${m.contextSentTokens.toLocaleString()} tokens sent, ${m.contextSavedTokens.toLocaleString()} saved by graph retrieval; cache hit rate ${(m.cacheHitRate * 100).toFixed(0)}%; ${m.compactions} compactions`,
    `- Wall time: ${(m.durationMs / 1000).toFixed(0)}s (verification ${(m.verifyMs / 1000).toFixed(0)}s over ${m.verifyRuns} runs)`,
  ];
  if (result.error) lines.push("", `**Error:** ${result.error}`);
  if (result.summary) lines.push("", "## What changed and why", "", result.summary);

  const g = result.gate;
  lines.push("", "## Evidence", "");
  if (!g.enabled) {
    lines.push("Verification gate disabled for this run.");
  } else {
    lines.push(
      `Gate command: \`${g.command ?? "(none detected)"}\`  `,
      `Ran after the last edit: ${g.ranAfterLastEdit ? "yes" : "no"}; rejections: ${g.rejections}  `,
      `Reason: ${g.reason || "-"}`,
      "",
      "| check | original code (baseline) | with patch (final) |",
      "|---|---|---|",
      `| ${g.command ?? "-"} | ${counts(g.baseline)} | ${counts(g.final)} |`,
    );
    if (g.fixed.length) lines.push("", `Fixed (failing before, passing after): ${g.fixed.map((t) => `\`${t}\``).join(", ")}`);
    if (g.newFailures.length) lines.push("", `**New failures (regressions):** ${g.newFailures.map((t) => `\`${t}\``).join(", ")}`);
    if (g.final?.failureExcerpt) lines.push("", "Final failure excerpt:", "", "```", g.final.failureExcerpt.trim(), "```");
  }
  const checks = evidenceChecks(result);
  if (checks.length) {
    lines.push(
      "",
      "| verdict | origin | check | original code | with patch |",
      "|---|---|---|---|---|",
      ...checks.map((c) => `| ${VERDICT_ICON[c.verdict]} | ${c.origin} | \`${c.command.replace(/\|/g, "\\|")}\` | ${c.before} | ${c.after} |`),
    );
  }
  if (input.verifyCommands.length) {
    lines.push("", "Detected checks:", ...input.verifyCommands.map((c) => `- \`${c.command}\` (${c.kind}; ${c.source})`));
  }

  const r = result.recovery;
  lines.push(
    "",
    "## Recovery",
    "",
    `Checkpoints ${r.checkpoints}, rollbacks ${r.rollbacks}, stuck events ${r.stuckEvents}, best checkpoint restored: ${r.restoredBest ? "yes" : "no"}`,
  );
  const classes = Object.entries(r.failureClasses);
  if (classes.length) lines.push(`Failure classes: ${classes.map(([k, v]) => `${k}×${v}`).join(", ")}`);
  const tools = Object.entries(m.toolCallsByName).sort((a, b) => b[1] - a[1]);
  if (tools.length) lines.push("", `Tool calls: ${tools.map(([k, v]) => `${k}×${v}`).join(", ")}`);

  lines.push(
    "",
    "## Patch",
    "",
    `${stat.files} file(s), +${stat.added} -${stat.removed}: ${stat.paths.map((p) => `\`${p}\``).join(", ") || "(no changes)"}`,
  );
  if (result.diff.trim()) lines.push("", "```diff", result.diff.trimEnd(), "```");
  lines.push("", "## Task", "", "```", input.task.trim().slice(0, 8000), "```");
  return `${lines.join("\n")}\n`;
}

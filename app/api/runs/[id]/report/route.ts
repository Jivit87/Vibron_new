/**
 * GET /api/runs/:id/report[?format=json] → 200 text/markdown | 404
 *   A finished run's report (Pramana Studio's `/api/runs/:id/report`): the
 *   same Markdown the headless CLI writes (result, cost, context, wall time,
 *   gate evidence, recovery, diffstat); a review renders its findings.
 *   `format=json` wraps it as `{ id, markdown }`. 404 "no such run" for an
 *   unknown id, "report not ready" until the run has ended with a result.
 */

import { renderReport } from "@/lib/headless/report";
import type { Review } from "@/lib/review";
import { getTaskQueue, type Task } from "@/lib/tasks";
import { isSolveResult, titleOf } from "../../_history";

export const runtime = "nodejs";

function reviewReport(task: Task, review: Review): string {
  const lines = [
    `# Viberon review: ${titleOf(task)}`,
    "",
    `- Task id: \`${task.id}\``,
    `- Repository: \`${task.repoKey}\``,
    `- Effort: ${review.effort}/5; tests: ${review.tests}`,
    "",
    "## Summary",
    "",
    review.summary || "-",
  ];
  if (review.security) lines.push("", "## Security", "", review.security);
  if (review.findings?.length) {
    lines.push("", "## Findings", "");
    for (const f of review.findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`- **${f.severity}** \`${where}\` ${f.title}${f.detail ? `: ${f.detail}` : ""}`);
    }
  }
  return lines.join("\n") + "\n";
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTaskQueue().get(id);
  if (!task) return Response.json({ error: "no such run" }, { status: 404 });
  if (!task.result || task.state === "queued" || task.state === "running") {
    return new Response("report not ready", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const markdown = isSolveResult(task.result)
    ? renderReport({
        taskId: task.id,
        task: task.task,
        repo: task.repoKey,
        model: task.model ?? "auto",
        result: task.result,
        verifyCommands: [],
        exitCode: task.result.status === "resolved" ? 0 : 1,
      })
    : reviewReport(task, task.result as Review);
  if (new URL(request.url).searchParams.get("format") === "json") return Response.json({ id: task.id, markdown });
  return new Response(markdown, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}

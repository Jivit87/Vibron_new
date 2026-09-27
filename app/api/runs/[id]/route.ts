/**
 * GET /api/runs/:id → 200 { ...RunSummary, task, error, note, result } | 404
 *   One run: its history row plus the full task text and result (the
 *   SolveResult or Review). A live /api/agent run returns its summary only.
 */

import { getTaskQueue } from "@/lib/tasks";
import { liveAgentRuns, summarizeAgentRun, summarizeTask } from "../_history";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTaskQueue().get(id);
  if (task) {
    return Response.json({
      ...summarizeTask(task),
      task: task.task,
      error: task.error ?? null,
      note: task.note ?? null,
      result: task.result ?? null,
    });
  }
  const live = liveAgentRuns().find((r) => r.runId === id);
  if (live) return Response.json({ ...summarizeAgentRun(live), result: null });
  return Response.json({ error: "no such run" }, { status: 404 });
}

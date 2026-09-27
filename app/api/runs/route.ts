/**
 * GET /api/runs?repoKey=&limit=&status= → 200 { runs: RunSummary[] }
 *   Run history, newest first (Pramana Studio's `/api/runs`): fix and review
 *   tasks (past and present) plus live /api/agent runs. Each row carries only
 *   verdict, tokens, cost and wall time; fetch one run's full result with
 *   GET /api/runs/:id and its report with GET /api/runs/:id/report.
 *   `limit` defaults to 50 (max 500); `status` filters on the lifecycle state.
 */

import { getTaskQueue } from "@/lib/tasks";
import { liveAgentRuns, summarizeAgentRun, summarizeTask } from "./_history";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoKey = params.get("repoKey")?.trim() || undefined;
  const status = params.get("status")?.trim() || undefined;
  const rawLimit = Number(params.get("limit") ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.round(rawLimit))) : 50;
  const now = Date.now();
  const tasks = await getTaskQueue().list(repoKey);
  const runs = [
    ...liveAgentRuns(repoKey).map((r) => summarizeAgentRun(r, now)),
    // The queue lists oldest first; reverse so the stable sort keeps same-ms ties newest first.
    ...tasks.reverse().map((t) => summarizeTask(t, now)),
  ]
    .filter((r) => !status || r.status === status)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
  return Response.json({ runs });
}

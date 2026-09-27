/**
 * POST /api/runs/stop { repoKey? } → 200 { tasks, agentRuns, taskIds, runIds }
 *   The big red button (Pramana Studio's `stop_all`): cancel every queued and
 *   running task and abort every live /api/agent run (model streams, tools,
 *   pending approvals, terminal sessions) for one repo, or for every repo
 *   when `repoKey` is omitted. Counts are what was actually stopped.
 */

import { cancelRun } from "@/lib/harness/runs";
import { getTaskQueue } from "@/lib/tasks";
import { liveAgentRuns } from "../_history";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { repoKey?: unknown } = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
    }
  }
  if (!body || typeof body !== "object" || (body.repoKey !== undefined && typeof body.repoKey !== "string")) {
    return Response.json({ error: "repoKey must be a string" }, { status: 400 });
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey.trim() : "";
  const queue = getTaskQueue();
  const repos = repoKey
    ? [repoKey]
    : [
        ...new Set(
          (await queue.list()).filter((t) => t.state === "queued" || t.state === "running").map((t) => t.repoKey),
        ),
      ];
  const stopped = (await Promise.all(repos.map((r) => queue.cancelAll(r)))).flat();
  const runIds = liveAgentRuns(repoKey || undefined)
    .filter((r) => !r.controller.signal.aborted)
    .map((r) => r.runId)
    .filter((id) => cancelRun(id));
  return Response.json({
    tasks: stopped.length,
    agentRuns: runIds.length,
    taskIds: stopped.map((t) => t.id),
    runIds,
  });
}

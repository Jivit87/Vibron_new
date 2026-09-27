/**
 * GET /api/tasks/:id → 200 Task (with its result) · 404 unknown.
 * DELETE /api/tasks/:id → 200 Task (queued: cancelled at once; running: being
 * cancelled) · 404 unknown · 409 already finished.
 */

import { getTaskQueue } from "@/lib/tasks";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const task = await getTaskQueue().get(id);
  return task ? Response.json(task) : Response.json({ error: "Unknown task" }, { status: 404 });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const queue = getTaskQueue();
  const task = await queue.get(id);
  if (!task) return Response.json({ error: "Unknown task" }, { status: 404 });
  if (task.state !== "queued" && task.state !== "running") {
    return Response.json({ error: `Task already ${task.state}` }, { status: 409 });
  }
  return Response.json(await queue.cancel(id));
}

/**
 * POST /api/tasks
 *   { kind: "fix"|"review", repoKey, task?, source?: "ui"|"cli"|"api"|"issue" = "api",
 *     issueUrl?, deliver?, model?, prUrl? }
 *   → 201 Task
 *   "Fix CI": `{ kind: "fix", repoKey, task: <fixTask from GET /api/ci> }`, or send
 *   `prUrl` without `task` and the task is built from the PR's failing checks.
 *   A review task's `task` may be a PR URL (reviews the PR) or instructions
 *   for reviewing the work tree's changes.
 *
 * GET /api/tasks?repoKey=[&full=1] → 200 { tasks: Task[] } (all repos when omitted), oldest first.
 *   Polled every few seconds by the Tasks panel, so each task's `result` (a
 *   whole SolveResult: diff, gate reports, metrics) is left out unless
 *   `full=1`; `resultStatus`, `usage`, `prUrl`, `error` and `note` stay.
 *
 * DELETE /api/tasks?repoKey= → 200 { tasks: Task[] }: Stop all. Every queued
 *   task of the repo is cancelled and every running one aborted.
 */

import { ciFixTask, ciStatus } from "@/lib/deliver";
import { errorResponse, jsonBody, str } from "@/lib/deliver/errors";
import { parseGitHubIssueUrl } from "@/lib/github";
import { getTaskQueue, type TaskSource } from "@/lib/tasks";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const SOURCES: TaskSource[] = ["ui", "cli", "api", "issue"];
const MAX_TASK_CHARS = 40_000;

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const kind = body.kind;
  const repoKey = str(body.repoKey);
  if (kind !== "fix" && kind !== "review") return Response.json({ error: 'kind must be "fix" or "review"' }, { status: 400 });
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const source = SOURCES.includes(body.source as TaskSource) ? (body.source as TaskSource) : "api";
  const issueUrl = str(body.issueUrl);
  if (issueUrl && !parseGitHubIssueUrl(issueUrl)) {
    return Response.json({ error: "issueUrl must be a GitHub issue URL" }, { status: 400 });
  }

  let task = str(body.task);
  try {
    if (!task && kind === "fix" && str(body.prUrl)) {
      task = ciFixTask(await ciStatus({ prUrl: str(body.prUrl) }));
      if (!task) return Response.json({ error: "No failing checks on that PR to fix." }, { status: 409 });
    }
  } catch (error) {
    return errorResponse(error);
  }
  if (!task) return Response.json({ error: "task is required" }, { status: 400 });
  if (task.length > MAX_TASK_CHARS) return Response.json({ error: `task is longer than ${MAX_TASK_CHARS} characters` }, { status: 400 });
  if (kind === "fix" && !(await openWorkspace(repoKey)).rootPath) {
    return Response.json({ error: "Fix tasks need a workspace on disk. Open a local folder or clone the repository." }, { status: 400 });
  }

  const created = await getTaskQueue().enqueue({
    kind,
    repoKey,
    task,
    source,
    ...(issueUrl ? { issueUrl } : {}),
    deliver: body.deliver === true,
    ...(str(body.model) ? { model: str(body.model) } : {}),
  });
  return Response.json(created, { status: 201 });
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const repoKey = params.get("repoKey") ?? undefined;
  const tasks = await getTaskQueue().list(repoKey || undefined);
  if (params.get("full") === "1") return Response.json({ tasks });
  return Response.json({
    tasks: tasks.map(({ result, ...rest }) => ({
      ...rest,
      ...(result ? { resultStatus: (result as { status?: string }).status } : {}),
    })),
  });
}

export async function DELETE(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey")?.trim();
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  return Response.json({ tasks: await getTaskQueue().cancelAll(repoKey) });
}

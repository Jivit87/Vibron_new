/**
 * POST /api/issues/fix { repoKey, numbers?: number[], all?: boolean, combined?: boolean, deliver?: boolean = true, refix?: boolean, model? }
 *   → { tasks: Task[], skipped: { number, reason }[] }
 * Queues one fix task per issue (each in its own worktree of origin/<default>,
 * a draft PR per proven fix), or with `combined` one task that fixes them all
 * on one branch and opens ONE PR. `all` takes every open issue. `refix`: an
 * explicit request to fix an issue again even if it already has a PR (the
 * runner updates that PR, or opens a new one if it was merged).
 */

import { fixIssues } from "@/lib/issues";
import { issuesError } from "@/app/api/issues/errors";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const all = body.all === true;
  if (!all && (!Array.isArray(body.numbers) || !body.numbers.every((n) => Number.isInteger(n) && (n as number) > 0))) {
    return Response.json({ error: "numbers must be an array of issue numbers (or pass all: true)" }, { status: 400 });
  }
  try {
    const result = await fixIssues({
      repoKey,
      ...(all ? { all } : { numbers: body.numbers as number[] }),
      combined: body.combined === true,
      deliver: body.deliver !== false,
      refix: body.refix === true,
      source: "ui",
      ...(typeof body.prompt === "string" ? { prompt: body.prompt.slice(0, 4000) } : {}),
      ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
    });
    return Response.json(result, { status: result.tasks.length ? 201 : 200 });
  } catch (error) {
    return await issuesError(error);
  }
}

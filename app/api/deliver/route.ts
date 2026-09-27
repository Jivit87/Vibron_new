/**
 * POST /api/deliver
 *   { repoKey, title, body?, draft? = true, baseBranch?, branch?, expectedFiles?: string[], allowWorkflowChanges?, pushOnly? }
 *   → 200 { branch, commit, prUrl, prNumber, created }
 *   → 200 { branch, commit, prUrl: "", prNumber: 0, pushedOnly: true }   (pushOnly, remote not on GitHub)
 *   → 4xx/5xx { error, code?, branch?, commit? }   (a failed push keeps its local branch + commit)
 *
 * Branch → commit → push → open/update a draft PR. Refuses changes outside
 * `expectedFiles` and CI workflow changes without `allowWorkflowChanges`.
 */

import { deliver } from "@/lib/deliver";
import { errorResponse, jsonBody, str } from "@/lib/deliver/errors";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const repoKey = str(body.repoKey);
  const title = str(body.title);
  if (!repoKey || !title) return Response.json({ error: "repoKey and title are required" }, { status: 400 });
  if (body.expectedFiles !== undefined && (!Array.isArray(body.expectedFiles) || body.expectedFiles.some((f) => typeof f !== "string"))) {
    return Response.json({ error: "expectedFiles must be an array of paths" }, { status: 400 });
  }
  const handle = await openWorkspace(repoKey);
  if (!handle.rootPath) {
    return Response.json({ error: "Delivery needs a workspace on disk. Open a local folder or clone the repository." }, { status: 400 });
  }
  try {
    return Response.json(
      await deliver({
        root: handle.rootPath,
        title,
        body: typeof body.body === "string" ? body.body : "",
        draft: body.draft !== false,
        baseBranch: str(body.baseBranch) || undefined,
        branch: str(body.branch) || undefined,
        expectedFiles: body.expectedFiles as string[] | undefined,
        allowWorkflowChanges: body.allowWorkflowChanges === true,
        pushOnly: body.pushOnly === true,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

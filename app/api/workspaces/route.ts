/**
 * GET  /api/workspaces → {workspaces: [{repoKey, label, rootPath, repoRef, registeredAt}]} (newest first)
 * POST /api/workspaces {rootPath} → {repoKey, label}
 */

import { registerLocalWorkspace, WorkspacePathError } from "@/lib/local-disk-workspace";
import { listLocalWorkspaces } from "@/lib/store";

export const runtime = "nodejs";

export async function GET() {
  const workspaces = await listLocalWorkspaces();
  return Response.json({
    workspaces: workspaces.map(({ repoKey, label, rootPath, repoRef, registeredAt }) => ({ repoKey, label, rootPath, repoRef, registeredAt })),
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const rootPath =
    typeof (body as { rootPath?: unknown }).rootPath === "string"
      ? (body as { rootPath: string }).rootPath
      : "";
  if (!rootPath) {
    return Response.json({ error: "rootPath is required" }, { status: 400 });
  }

  try {
    const meta = await registerLocalWorkspace(rootPath);
    return Response.json({ repoKey: meta.repoKey, label: meta.label });
  } catch (error) {
    const message = error instanceof WorkspacePathError ? error.message : "Could not open that folder.";
    return Response.json({ error: message }, { status: 400 });
  }
}

/**
 * GET /api/memory/graph?repoKey= → {nodes:[{id, kind:"note"|"code", label, stale?}], links:[{source, target}]}
 *
 * The memory vault as a graph: notes linked to the code they are anchored to.
 * Ids are vault paths (`notes/<slug>`, `code/<path>`), as in Obsidian.
 */

import { vaultGraph } from "@/lib/memory";
import { findWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const repoKey = new URL(request.url).searchParams.get("repoKey");
  if (!repoKey) return Response.json({ error: "repoKey is required" }, { status: 400 });
  const handle = await findWorkspace(repoKey);
  if (!handle) return Response.json({ error: "Unknown workspace" }, { status: 404 });
  if (!handle.rootPath) return Response.json({ nodes: [], links: [] });
  try {
    return Response.json(vaultGraph(handle.rootPath));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

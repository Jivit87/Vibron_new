import { countTokens } from "@/lib/tokens";
import { parseRepo } from "@/lib/parser";
import {
  listLocalWorkspaceFiles,
  readLocalWorkspaceFile,
  WorkspacePathError,
  writeLocalWorkspaceFile,
} from "@/lib/local-disk-workspace";
import {
  getLocalWorkspace,
  getGraph,
  getRawFile,
  getRawFiles,
  putFileInfo,
  putGraph,
  putRawFiles,
} from "@/lib/store";

export const runtime = "nodejs";

/**
 * GET /api/repos/files/<repoKey>
 *   → File tree manifest. Falls back to graph file paths if rawFiles aren't cached.
 *
 * GET /api/repos/files/<repoKey>?path=src/app.ts
 *   → A single file's source.
 *
 * PUT /api/repos/files/<repoKey>?path=src/app.ts
 *   Body: { source: string }
 *   → Replace the in-memory source for one file. Used by the editor's
 *     local-save and by the agent's `write_file` tool.
 *
 *     The repo on disk (the original tarball) is never touched. Edits are
 *     ephemeral — they live in the same in-memory store the dev fallback
 *     persists to the disk store (`.viberon-store/`).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ repoKey: string }> },
) {
  const { repoKey } = await context.params;
  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  const workspace = await getLocalWorkspace(repoKey);

  if (filePath) {
    if (workspace) {
      try {
        const file = await readLocalWorkspaceFile(repoKey, filePath);
        if (file) return Response.json(file);
        return Response.json({ error: "File not found" }, { status: 404 });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : "Invalid file path" },
          { status: error instanceof WorkspacePathError ? 400 : 500 },
        );
      }
    }

    const file = await getRawFile(repoKey, filePath);
    if (file) {
      return Response.json(file);
    }
    const graph = await getGraph(repoKey);
    if (graph?.nodes.some((node) => node.file === filePath)) {
      return Response.json(
        {
          error:
            "Raw source for this file is not cached. Re-ingest the repository to view the real file contents.",
        },
        { status: 404 },
      );
    }
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  if (workspace) {
    const files = await listLocalWorkspaceFiles(repoKey);
    return Response.json({
      files: files.map((f) => ({ path: f.path, size: f.source.length })),
    });
  }

  const all = await getRawFiles(repoKey);
  if (all.length > 0) {
    return Response.json({
      files: all.map((f) => ({ path: f.path, size: f.source.length })),
    });
  }

  // Fallback for older caches: list every unique path mentioned in the graph.
  const graph = await getGraph(repoKey);
  if (graph) {
    const seen = new Map<string, number>();
    for (const node of graph.nodes) {
      seen.set(node.file, (seen.get(node.file) ?? 0) + node.snippet.length);
    }
    return Response.json({
      files: [...seen.entries()].map(([path, size]) => ({ path, size })),
    });
  }

  return Response.json({ files: [] });
}

/**
 * PUT a single file's source. The change is in-memory only — the original
 * repo on disk (the tarball) is never modified.
 *
 * Returns the saved file or 400/404 on bad input.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ repoKey: string }> },
) {
  const { repoKey } = await context.params;
  const url = new URL(request.url);
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    return Response.json(
      { error: "Missing required ?path query parameter" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Body must be valid JSON" },
      { status: 400 },
    );
  }
  const source =
    body && typeof body === "object" && "source" in body
      ? (body as { source?: unknown }).source
      : undefined;
  if (typeof source !== "string") {
    return Response.json(
      { error: "Body must include a `source` string" },
      { status: 400 },
    );
  }

  const workspace = await getLocalWorkspace(repoKey);
  if (workspace) {
    try {
      const saved = await writeLocalWorkspaceFile(repoKey, filePath, source);
      return Response.json(saved);
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "Invalid file path" },
        { status: error instanceof WorkspacePathError ? 400 : 500 },
      );
    }
  }

  const all = await getRawFiles(repoKey);

  const existingIndex = all.findIndex((f) => f.path === filePath);
  if (existingIndex === -1) {
    // New file (the agent might create one). Append.
    all.push({ path: filePath, source });
  } else {
    all[existingIndex] = { ...all[existingIndex], source };
  }

  await putRawFiles(repoKey, all);
  const currentGraph = await getGraph(repoKey);
  const parseResult = parseRepo(all, currentGraph?.meta.repoRef ?? "unknown/repo@local");
  await putGraph(repoKey, parseResult.graph);
  await putFileInfo(
    repoKey,
    all.map((file) => ({
      path: file.path,
      tokenCount: countTokens(file.source),
    })),
  );

  return Response.json({ path: filePath, source });
}

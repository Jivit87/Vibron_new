/**
 * POST /api/clone  { url, ref?, depth?, setup? }
 *
 * Streams SSE:
 *   {type:"progress", text}
 *   {type:"done", repoKey, rootPath, label, issue?: {title, body, url}, setupNotes?, probe?: RepoProbe}
 *   {type:"error", message}
 *
 * Clones into VIBERON_REPOS_DIR (default ~/Viberon/repos/<owner>__<name>),
 * reusing and fetching an existing clone, registers the disk workspace and
 * indexes its graph. `setup` (default true) bootstraps the environment
 * (venv + pip install -e ., npm ci / pnpm i) through the safety classifier.
 */

import { encodeSse, sseHeaders } from "@/lib/sse";
import { cloneToWorkspace, parseCloneTarget } from "@/lib/workspace/clone";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { url?: unknown; ref?: unknown; depth?: unknown; setup?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const allowLocal = process.env.VIBERON_ALLOW_LOCAL_CLONE === "1";
  if (!url || !parseCloneTarget(url, { allowLocal })) {
    return Response.json(
      { error: "Provide an https/ssh repository URL, owner/repo, or a GitHub issue URL." },
      { status: 400 },
    );
  }
  const ref = typeof body.ref === "string" && body.ref ? body.ref : undefined;
  const depth = typeof body.depth === "number" ? body.depth : undefined;
  const setup = body.setup !== false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          // Client went away.
        }
      };
      try {
        const result = await cloneToWorkspace(url, {
          ref,
          depth,
          setup,
          allowLocal,
          signal: request.signal,
          onProgress: (text) => send({ type: "progress", text }),
        });
        send({
          type: "done",
          repoKey: result.repoKey,
          rootPath: result.rootPath,
          label: result.label,
          ...(result.issue ? { issue: result.issue } : {}),
          ...(result.setupNotes ? { setupNotes: result.setupNotes } : {}),
          ...(result.probe ? { probe: result.probe } : {}),
        });
      } catch (error) {
        send({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

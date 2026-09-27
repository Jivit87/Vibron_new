/**
 * The integrated terminal API.
 *
 *   GET  /api/terminal?repoKey=…            → list sessions
 *   GET  /api/terminal?sessionId=…&stream=1 → SSE-stream one session's output
 *   POST /api/terminal                      → start a command
 *        { repoKey, command, cwd? }           cwd: relative to the workspace root
 *   DELETE /api/terminal?sessionId=…        → kill a running session; a finished
 *                                             one is removed from the list
 *   POST /api/terminal/input                → write to a session's stdin
 */

import { encodeSse, sseHeaders } from "@/lib/sse";
import {
  classifyCommand,
  getSession,
  killSession,
  listSessions,
  pruneSessions,
  removeSession,
  resolveSessionCwd,
  serializeSession,
  startCommand,
  subscribe,
} from "@/lib/terminal";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  const repoKey = url.searchParams.get("repoKey") ?? undefined;

  if (sessionId && url.searchParams.get("stream") === "1") {
    const session = getSession(sessionId);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const push = (payload: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encodeSse(payload));
          } catch {
            closed = true;
          }
        };

        // Replay history first so a late subscriber sees the whole session
        // (or, with `since`, only what it missed).
        const sinceParam = Number(url.searchParams.get("since"));
        const since = Number.isFinite(sinceParam) && sinceParam > 0 ? sinceParam : 0;
        const history = session.buffer.since(since);
        push({
          type: "history",
          text: history.text,
          offset: session.buffer.end,
          status: session.status,
          detectedUrl: session.detectedUrl,
          ...(history.complete ? {} : { reset: true }),
        });

        const end = () => {
          push({
            type: "end",
            status: session.status,
            exitCode: session.exitCode,
            detectedUrl: session.detectedUrl,
          });
          closed = true;
          try {
            controller.close();
          } catch {
            // Client already gone.
          }
        };

        if (session.endedAt !== null) {
          end();
          return;
        }

        const unsubscribe = subscribe(sessionId, (chunk) => {
          push({ type: "chunk", stream: chunk.stream, text: chunk.text, offset: chunk.offset });
        });
        // Status flips on close, after the final chunk has been pushed.
        void session.done.then(() => {
          unsubscribe();
          end();
        });

        request.signal.addEventListener("abort", () => {
          closed = true;
          unsubscribe();
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        });
      },
    });

    return new Response(stream, { headers: sseHeaders() });
  }

  if (sessionId) {
    const session = getSession(sessionId);
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    return Response.json(serializeSession(session));
  }

  pruneSessions();
  return Response.json({
    sessions: listSessions(repoKey).map(serializeSession),
  });
}

export async function POST(request: Request) {
  let body: { repoKey?: unknown; command?: unknown; cwd?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!repoKey || !command) {
    return Response.json(
      { error: "repoKey and command are required" },
      { status: 400 },
    );
  }

  const handle = await openWorkspace(repoKey);
  if (!handle.rootPath) {
    return Response.json(
      {
        error:
          "This workspace has no folder on disk. Open a local folder to use the terminal.",
      },
      { status: 400 },
    );
  }

  // The same safety classifier the agent tool uses. A user typing directly
  // into the terminal still cannot run something unrecoverable.
  const verdict = classifyCommand(command);
  if (verdict.allowed === false) {
    return Response.json(
      { error: `Refused: this command ${verdict.reason}.` },
      { status: 400 },
    );
  }

  const where = resolveSessionCwd(handle.rootPath, body.cwd);
  if ("error" in where) {
    return Response.json({ error: where.error }, { status: 400 });
  }

  const session = startCommand({
    repoKey,
    command,
    cwd: where.cwd,
    origin: "user",
  });

  return Response.json(serializeSession(session));
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ ok: false, error: "Session not found" }, { status: 404 });
  }
  if (session.status === "running") {
    return Response.json({ ok: killSession(sessionId), removed: false });
  }
  return Response.json({ ok: removeSession(sessionId), removed: true });
}

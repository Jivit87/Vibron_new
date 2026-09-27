/**
 * Problems API.
 *
 *   GET  /api/problems?repoKey=…          → last cached result (no run)
 *   POST /api/problems { repoKey, files?, tests? } → run tsc + ESLint (single-flight);
 *        `tests: true` also runs the repo's detected test command (whole-repo runs only)
 *
 * Both answer `{ virtual, problems, checkers, finishedAt, running }`.
 * Virtual (no folder on disk) workspaces answer `virtual: true` so the panel
 * can explain why the list is empty.
 */

import { cachedProblems, runChecks } from "@/lib/problems";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 300;

const EMPTY = { problems: [], checkers: [], finishedAt: null, running: false };

async function rootFor(repoKey: unknown): Promise<string | null | Response> {
  if (typeof repoKey !== "string" || !repoKey) {
    return Response.json({ error: "repoKey is required" }, { status: 400 });
  }
  const handle = await openWorkspace(repoKey);
  return handle.rootPath;
}

export async function GET(request: Request) {
  const root = await rootFor(new URL(request.url).searchParams.get("repoKey"));
  if (root instanceof Response) return root;
  if (!root) return Response.json({ virtual: true, ...EMPTY });
  const { result, running } = cachedProblems(root);
  return Response.json({ virtual: false, ...EMPTY, ...(result ?? {}), running });
}

export async function POST(request: Request) {
  let body: { repoKey?: unknown; files?: unknown; tests?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  const root = await rootFor(body.repoKey);
  if (root instanceof Response) return root;
  if (!root) return Response.json({ virtual: true, ...EMPTY });

  let files: string[] | undefined;
  if (body.files !== undefined) {
    if (!Array.isArray(body.files) || body.files.some((f) => typeof f !== "string")) {
      return Response.json({ error: "files must be an array of paths" }, { status: 400 });
    }
    files = (body.files as string[]).slice(0, 2000);
  }

  try {
    const result = await runChecks(root, { files, tests: body.tests === true });
    // A focused run is merged into the cache; answer with the whole list so
    // the panel can replace its state wholesale.
    const cached = cachedProblems(root);
    return Response.json({ virtual: false, ...(cached.result ?? result), running: cached.running });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Checks failed" },
      { status: 500 },
    );
  }
}

import { GitHubApiError, redactSecret } from "@/lib/github-api";

/** A refusal or failure with the HTTP status the routes return as-is. */
export class DeliverError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    /** What was done locally before the failure (a failed push keeps its branch and commit). */
    readonly partial?: { branch: string; commit: string },
  ) {
    super(message);
    this.name = "DeliverError";
  }
}

/** JSON error response for the deliver/CI/tasks routes. Messages never contain the token. */
export function errorResponse(error: unknown): Response {
  // Belt and braces: URL credentials and token-shaped strings never leave in a response.
  const message = redactSecret(error instanceof Error ? error.message : String(error), null);
  if (error instanceof DeliverError) {
    return Response.json({ error: message, code: error.code, ...error.partial }, { status: error.status });
  }
  if (error instanceof GitHubApiError) {
    const status = [401, 403, 404, 409, 422].includes(error.status) ? error.status : 502;
    return Response.json({ error: message, code: "github" }, { status });
  }
  return Response.json({ error: message }, { status: 500 });
}

/** A JSON object body, or a 400 response. */
export async function jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await request.json()) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
}

export const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * Client side of "clone → fix": parse what the user pasted, stream
 * `POST /api/clone`, expand GitHub issues via `GET /api/issue`, and remember
 * cloned repos for the Welcome page.
 *
 * Contracts (docs/PLAN-SOLVE.md, "Routes"):
 *   POST /api/clone {url, ref?, depth?} → SSE
 *     {type:"progress", text} … {type:"done", repoKey, rootPath, label, issue?} | {type:"error", message}
 *   GET /api/issue?url= → {title, body, url}
 */

import { useViberon, type IssueRef } from "@/store/viberon";
import { isMockMode } from "@/lib/client/mock-run";

export type CloneEvent =
  | { type: "progress"; text: string }
  | { type: "done"; repoKey: string; rootPath: string; label: string; issue?: IssueRef }
  | { type: "error"; message: string };

export type CloneTarget =
  | { kind: "repo"; url: string; label: string }
  | { kind: "issue"; url: string; label: string; number: number };

const SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/;
const ISSUE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/i;
const HTTPS = /^https?:\/\/[^\s/]+\/[^\s]+$/i;
const SSH = /^(?:ssh:\/\/)?[\w.-]+@[\w.-]+[:/][^\s]+$/;

/** What a pasted string points at, or null when it is not a clone target. */
export function parseCloneInput(raw: string): CloneTarget | null {
  const input = raw.trim();
  if (!input) return null;
  const issue = ISSUE.exec(input);
  if (issue) {
    return { kind: "issue", url: input, label: `${issue[1]}/${issue[2]}#${issue[3]}`, number: Number(issue[3]) };
  }
  const slug = SLUG.exec(input);
  if (slug && !input.includes(":")) {
    return { kind: "repo", url: input, label: `${slug[1]}/${slug[2]}` };
  }
  if (HTTPS.test(input) || SSH.test(input)) {
    const tail = input.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/");
    return { kind: "repo", url: input, label: tail || input };
  }
  return null;
}

/** A GitHub issue URL anywhere in the text, for the composer's Fix mode. */
export function findIssueUrl(text: string): string | null {
  const match = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/i.exec(text);
  return match ? match[0] : null;
}

/** Stream a clone. Resolves with the terminal event (done or error). */
export async function cloneRepository(
  url: string,
  onEvent: (event: CloneEvent) => void,
  signal?: AbortSignal,
): Promise<CloneEvent> {
  if (isMockMode()) return mockClone(url, onEvent, signal);
  let response: Response;
  try {
    response = await fetch("/api/clone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, depth: 1 }),
      signal,
    });
  } catch (error) {
    return finish(onEvent, error instanceof Error ? error.message : "Network error");
  }
  if (response.status === 404) {
    return finish(onEvent, "Cloning is not available in this build (no /api/clone).");
  }
  if (!response.ok || !response.body) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return finish(onEvent, body?.error ?? `Clone failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const event = parseCloneFrame(frame);
        if (!event) continue;
        onEvent(event);
        if (event.type !== "progress") return event;
      }
    }
  } catch (error) {
    if (signal?.aborted) return finish(onEvent, "Cancelled.");
    return finish(onEvent, error instanceof Error ? error.message : "Stream interrupted");
  }
  return finish(onEvent, "The clone stream ended without a result.");
}

function finish(onEvent: (event: CloneEvent) => void, message: string): CloneEvent {
  const event: CloneEvent = { type: "error", message };
  onEvent(event);
  return event;
}

export function parseCloneFrame(frame: string): CloneEvent | null {
  const payload = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!payload) return null;
  try {
    const event = JSON.parse(payload) as CloneEvent;
    return event && typeof event.type === "string" ? event : null;
  } catch {
    return null;
  }
}

/** Expand a GitHub issue URL. Null when the route is missing or the fetch fails. */
export async function fetchIssue(url: string, signal?: AbortSignal): Promise<IssueRef | null> {
  if (isMockMode()) {
    await new Promise((r) => setTimeout(r, 350));
    return { ...MOCK_ISSUE, url };
  }
  try {
    const response = await fetch(`/api/issue?url=${encodeURIComponent(url)}`, { signal });
    if (!response.ok) return null;
    const body = (await response.json()) as Partial<IssueRef>;
    if (typeof body.title !== "string") return null;
    return { title: body.title, body: typeof body.body === "string" ? body.body : "", url: body.url ?? url };
  } catch {
    return null;
  }
}

/** The prompt a Fix run sends for an issue plus optional extra notes. */
export function issuePrompt(issue: IssueRef, notes: string): string {
  const parts = [`Fix this issue: ${issue.title}`, issue.url];
  if (issue.body.trim()) parts.push(issue.body.trim());
  if (notes.trim()) parts.push(`Notes: ${notes.trim()}`);
  return parts.join("\n\n");
}

/* --------------------------- pending handoff ------------------------------ */

const PENDING_KEY = "viberon.pendingFix.v1";

/** Carry an issue across the navigation to the freshly cloned workspace. */
export function stashPendingFix(repoKey: string, issue: IssueRef): void {
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ repoKey, issue }));
  } catch {
    // Without storage the user pastes the issue again.
  }
}

export function takePendingFix(repoKey: string): IssueRef | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { repoKey?: string; issue?: IssueRef };
    if (parsed.repoKey !== repoKey || !parsed.issue) return null;
    window.sessionStorage.removeItem(PENDING_KEY);
    return parsed.issue;
  } catch {
    return null;
  }
}

const PENDING_GRAPH_KEY = "viberon.pendingGraph.v1";

/** A fresh clone opens on its code graph: remember that across the navigation. */
export function stashPendingGraph(repoKey: string): void {
  try {
    window.sessionStorage.setItem(PENDING_GRAPH_KEY, repoKey);
  } catch {
    // Without storage the workspace opens on its default tabs.
  }
}

export function takePendingGraph(repoKey: string): boolean {
  try {
    if (window.sessionStorage.getItem(PENDING_GRAPH_KEY) !== repoKey) return false;
    window.sessionStorage.removeItem(PENDING_GRAPH_KEY);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------ recent clones ----------------------------- */

export interface RecentClone {
  repoKey: string;
  label: string;
  url: string;
  rootPath?: string;
  clonedAt: number;
}

const RECENT_KEY = "viberon.recentClones.v1";

export function loadRecentClones(): RecentClone[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((c): c is RecentClone => Boolean(c) && typeof c.repoKey === "string" && typeof c.url === "string")
      : [];
  } catch {
    return [];
  }
}

export function recordClone(entry: Omit<RecentClone, "clonedAt">): void {
  try {
    const next = [
      { ...entry, clonedAt: Date.now() },
      ...loadRecentClones().filter((c) => c.repoKey !== entry.repoKey),
    ].slice(0, 8);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Not remembered.
  }
}

/* --------------------------------- mock ----------------------------------- */

export const MOCK_ISSUE: IssueRef = {
  title: "slugify() drops non-ASCII letters instead of transliterating them",
  body:
    "`slugify(\"Crème brûlée\")` returns `\"crme-brle\"`; expected `\"creme-brulee\"`.\n\nSteps:\n```\n>>> from textkit import slugify\n>>> slugify(\"Crème brûlée\")\n'crme-brle'\n```\nRegressed in 2.3.0 when the regex was tightened.",
  url: "https://github.com/acme/textkit/issues/412",
};

async function mockClone(
  url: string,
  onEvent: (event: CloneEvent) => void,
  signal?: AbortSignal,
): Promise<CloneEvent> {
  const target = parseCloneInput(url);
  const name = (target?.label ?? "acme/textkit").split("#")[0];
  const lines = [
    `Cloning https://github.com/${name}.git (depth 1)`,
    "remote: Enumerating objects: 214, done.",
    "Receiving objects: 100% (214/214), 88.1 KiB | 1.9 MiB/s, done.",
    "Resolving deltas: 100% (37/37), done.",
    `Registered workspace ~/Viberon/repos/${name.replace("/", "__")}`,
    "Indexing graph: 61 files, 412 symbols (py 48, toml 2, md 11)",
    "Detected tests: python -m pytest -q",
  ];
  for (const text of lines) {
    await new Promise((r) => setTimeout(r, 280));
    if (signal?.aborted) return finish(onEvent, "Cancelled.");
    onEvent({ type: "progress", text });
  }
  // The mock cannot create a workspace; land on the one already open.
  const repoKey = useViberon.getState().repoKey;
  const done: CloneEvent = {
    type: "done",
    repoKey,
    rootPath: `~/Viberon/repos/${name.replace("/", "__")}`,
    label: name,
    issue: target?.kind === "issue" ? { ...MOCK_ISSUE, url } : undefined,
  };
  onEvent(done);
  return done;
}

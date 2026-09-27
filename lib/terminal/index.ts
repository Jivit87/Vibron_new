/**
 * Integrated terminal.
 *
 * A vibe-coding tool that cannot run `npm install`, start a dev server, or
 * run the test suite is a code *generator*, not a development environment.
 * This module owns real process execution: agents call it through the
 * `run_command` tool, and the terminal panel drives it directly.
 *
 * Design notes:
 *  - `child_process.spawn` rather than a pty. A pty (node-pty) needs native
 *    compilation per platform, which breaks `electron-builder` packaging for
 *    marginal benefit here: we need output streaming and exit codes, not
 *    cursor addressing or interactive TUIs.
 *  - Every process is rooted at the workspace directory and inherits a
 *    scrubbed env (no API keys). Nothing runs outside a workspace.
 *  - Each command gets its own process group (`detached`) so killing it
 *    kills the whole tree — a dev server's workers die with it instead of
 *    orphaning. Every live group is killed when this process exits.
 *  - Long-running processes (dev servers) are kept in a session registry so
 *    the UI can stream, inspect, resume (by offset) and kill them.
 *
 * Safety: commands are classified before running (`./safety.ts`).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import { LineTracker, OutputBuffer, detectLocalUrl } from "./output";
import { classifyCommand, scrubEnv } from "./safety";
import { condenseOutput } from "@/lib/verify/extract";
import { repoEnvPrelude } from "@/lib/verify/env";

export { classifyCommand, scrubEnv, type CommandVerdict } from "./safety";

export type TerminalStatus = "running" | "exited" | "killed" | "failed";
export type TerminalOrigin = "user" | "agent";

export interface TerminalChunk {
  stream: "stdout" | "stderr" | "system";
  text: string;
  at: number;
  /** Absolute buffer offset one past this chunk's last character. */
  offset: number;
}

export interface TerminalSession {
  id: string;
  repoKey: string;
  command: string;
  cwd: string;
  status: TerminalStatus;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Recent chunks (capped). Prefer `buffer` for full output. */
  chunks: TerminalChunk[];
  buffer: OutputBuffer;
  /** Detected `http://localhost:PORT` from the output, for the preview pane. */
  detectedUrl: string | null;
  runId: string | null;
  origin: TerminalOrigin;
  child: ChildProcess | null;
  subscribers: Set<(chunk: TerminalChunk) => void>;
  /** Resolves once the process has closed (or failed to start). */
  done: Promise<void>;
  lineTracker: LineTracker;
}

/**
 * Sessions must outlive a single Next.js request, and dev-mode HMR reloads
 * module scope — so the registry hangs off globalThis.
 */
const REGISTRY_KEY = Symbol.for("viberon.terminal.sessions");
const EXIT_HOOK_KEY = Symbol.for("viberon.terminal.exitHook");
type GlobalWithRegistry = typeof globalThis & {
  [REGISTRY_KEY]?: Map<string, TerminalSession>;
  [EXIT_HOOK_KEY]?: boolean;
};
const registryHost = globalThis as GlobalWithRegistry;
const sessions: Map<string, TerminalSession> =
  registryHost[REGISTRY_KEY] ?? new Map();
registryHost[REGISTRY_KEY] = sessions;

const MAX_CHUNKS_PER_SESSION = 2000;
const IS_WINDOWS = process.platform === "win32";

/* --------------------------- process groups ------------------------------ */

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (!pid) return;
  if (IS_WINDOWS) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill(signal);
    }
    return;
  }
  try {
    // Negative pid = the whole process group (we spawned it `detached`).
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pid : -pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill every live process group, synchronously. Safe to call on exit. */
export function killAllSessions(): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.child?.pid && (session.status === "running" || groupAlive(session.child.pid))) {
      if (session.status === "running") session.status = "killed";
      signalTree(session.child, "SIGKILL");
      count++;
    }
  }
  return count;
}

function installExitHook(): void {
  if (registryHost[EXIT_HOOK_KEY]) return;
  registryHost[EXIT_HOOK_KEY] = true;
  process.on("exit", () => {
    killAllSessions();
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      killAllSessions();
      // If nobody else handles the signal, preserve default "exit" behaviour.
      if (process.listenerCount(signal) <= 1) {
        process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
      }
    };
    process.on(signal, handler);
  }
}

/* ------------------------------ running ---------------------------------- */

export interface RunOptions {
  repoKey: string;
  command: string;
  cwd: string;
  /** Kill the process after this many ms. 0 = run indefinitely. */
  timeoutMs?: number;
  /** Extra env vars, applied on top of the scrubbed environment. */
  env?: Record<string, string>;
  /** Aborting kills the process tree. */
  signal?: AbortSignal;
  /** Agent run that started this command, for `killSessionsByRun`. */
  runId?: string;
  origin?: TerminalOrigin;
  /**
   * Run with the repo's environment: its virtualenv first on PATH, a
   * `python` → `python3` shim when needed, no .pyc files written.
   */
  repoEnv?: boolean;
}

function pushChunk(
  session: TerminalSession,
  stream: TerminalChunk["stream"],
  text: string,
): void {
  session.buffer.append(text);
  const chunk: TerminalChunk = { stream, text, at: Date.now(), offset: session.buffer.end };
  session.chunks.push(chunk);
  if (session.chunks.length > MAX_CHUNKS_PER_SESSION) {
    session.chunks.splice(0, session.chunks.length - MAX_CHUNKS_PER_SESSION);
  }
  if (!session.detectedUrl && stream !== "system") {
    session.detectedUrl = detectLocalUrl(text);
  }
  for (const notify of session.subscribers) {
    try {
      notify(chunk);
    } catch {
      // A dead subscriber must never break the process pipeline.
    }
  }
}

/**
 * Start a command. Returns immediately with a session — callers stream via
 * `subscribe` or await `waitFor`.
 */
export function startCommand(options: RunOptions): TerminalSession {
  installExitHook();
  const id = randomUUID();
  let markDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    markDone = resolve;
  });
  const origin: TerminalOrigin = options.origin ?? "user";
  const session: TerminalSession = {
    id,
    repoKey: options.repoKey,
    command: options.command,
    cwd: options.cwd,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    endedAt: null,
    chunks: [],
    buffer: new OutputBuffer(),
    detectedUrl: null,
    runId: options.runId ?? null,
    origin,
    child: null,
    subscribers: new Set(),
    done,
    lineTracker: new LineTracker(),
  };
  sessions.set(id, session);

  pushChunk(session, "system", `$ ${options.command}\n`);

  if (options.signal?.aborted) {
    session.status = "killed";
    session.endedAt = Date.now();
    pushChunk(session, "system", "[cancelled before start]\n");
    markDone();
    return session;
  }

  // A login shell resolves the user's real PATH — without it, tools
  // installed via nvm/homebrew/asdf are invisible to spawned processes.
  const shell = IS_WINDOWS ? "cmd.exe" : "/bin/bash";
  const command =
    options.repoEnv && !IS_WINDOWS ? repoEnvPrelude(options.cwd) + options.command : options.command;
  const args = IS_WINDOWS ? ["/c", command] : ["-lc", command];

  let child: ChildProcess;
  try {
    child = spawn(shell, args, {
      cwd: options.cwd,
      env: {
        ...scrubEnv(process.env),
        ...options.env,
        // Keep tool output parseable and non-interactive.
        FORCE_COLOR: "0",
        CI: "1",
        NO_COLOR: "1",
      },
      // Users can type into their own sessions; agents get EOF on stdin so
      // an interactive prompt fails fast instead of hanging the run.
      stdio: [origin === "user" ? "pipe" : "ignore", "pipe", "pipe"],
      detached: !IS_WINDOWS,
    });
  } catch (error) {
    session.status = "failed";
    session.endedAt = Date.now();
    pushChunk(
      session,
      "system",
      `failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    markDone();
    return session;
  }

  session.child = child;
  child.stdin?.on("error", () => {
    // EPIPE after the process exits; nothing to do.
  });

  child.stdout?.on("data", (buffer: Buffer) => {
    pushChunk(session, "stdout", buffer.toString("utf8"));
  });
  child.stderr?.on("data", (buffer: Buffer) => {
    pushChunk(session, "stderr", buffer.toString("utf8"));
  });

  child.on("error", (error) => {
    if (session.endedAt !== null) return;
    session.status = "failed";
    session.endedAt = Date.now();
    pushChunk(session, "system", `process error: ${error.message}\n`);
    markDone();
  });

  child.on("close", (code, signal) => {
    if (session.status === "running") {
      session.status = signal ? "killed" : "exited";
    }
    session.exitCode = code;
    session.endedAt = session.endedAt ?? Date.now();
    pushChunk(
      session,
      "system",
      signal ? `\n[killed by ${signal}]\n` : `\n[exited with code ${code ?? 0}]\n`,
    );
    markDone();
  });

  const cleanups: (() => void)[] = [];
  if (options.timeoutMs && options.timeoutMs > 0) {
    const timer = setTimeout(() => {
      if (session.status === "running") {
        pushChunk(
          session,
          "system",
          `\n[timed out after ${Math.round(options.timeoutMs! / 1000)}s]\n`,
        );
        killSession(id);
      }
    }, options.timeoutMs);
    cleanups.push(() => clearTimeout(timer));
  }
  if (options.signal) {
    const onAbort = () => {
      if (session.status === "running") {
        pushChunk(session, "system", "\n[cancelled]\n");
        killSession(id);
      }
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => options.signal!.removeEventListener("abort", onAbort));
  }
  void done.then(() => cleanups.forEach((fn) => fn()));

  return session;
}

/** Await completion (or the timeout). Long-running servers never resolve. */
export function waitFor(
  session: TerminalSession,
  timeoutMs = 120_000,
): Promise<TerminalSession> {
  if (session.status !== "running") return Promise.resolve(session);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(session), timeoutMs);
    void session.done.then(() => {
      clearTimeout(timer);
      resolve(session);
    });
  });
}

/**
 * Run a command and collect its output — the shape the agent tool wants.
 * Output is capped so a chatty build cannot flood the model's context.
 */
export async function runCommand(
  options: RunOptions & {
    maxOutputChars?: number;
    /**
     * Condense instead of a blind head/tail cut: passing output keeps a short
     * head + tail; failing output keeps tracebacks, assertion diffs and FAIL
     * blocks plus the summary tail (`lib/verify` `condenseOutput`).
     */
    condense?: boolean;
  },
): Promise<{
  sessionId: string;
  status: TerminalStatus;
  exitCode: number | null;
  output: string;
  truncated: boolean;
  detectedUrl: string | null;
}> {
  const session = startCommand(options);
  await waitFor(session, options.timeoutMs || 120_000);

  const cap = options.maxOutputChars ?? 12_000;
  const full = session.buffer.toString();
  const truncated = full.length > cap;
  if (options.condense) {
    return {
      sessionId: session.id,
      status: session.status,
      exitCode: session.exitCode,
      output: condenseOutput(full, session.exitCode, cap),
      truncated,
      detectedUrl: session.detectedUrl,
    };
  }
  // Keep the head *and* the tail: the head has the command and early
  // errors, the tail has the summary and exit code.
  const output = truncated
    ? `${full.slice(0, Math.floor(cap * 0.4))}\n… [${full.length - cap} chars trimmed] …\n${full.slice(-Math.floor(cap * 0.6))}`
    : full;

  return {
    sessionId: session.id,
    status: session.status,
    exitCode: session.exitCode,
    output,
    truncated,
    detectedUrl: session.detectedUrl,
  };
}

/* ---------------------------- registry ----------------------------------- */

export function getSession(id: string): TerminalSession | undefined {
  return sessions.get(id);
}

export function listSessions(repoKey?: string): TerminalSession[] {
  return [...sessions.values()]
    .filter((s) => !repoKey || s.repoKey === repoKey)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export function killSession(id: string): boolean {
  const session = sessions.get(id);
  const child = session?.child;
  if (!session || !child || session.status !== "running") return false;
  session.status = "killed";
  signalTree(child, "SIGTERM");
  // Escalate if the group ignores SIGTERM. Check the group, not just the
  // shell: the shell can exit while a server it started keeps running.
  const pid = child.pid;
  const escalate = setTimeout(() => {
    if (pid && groupAlive(pid)) signalTree(child, "SIGKILL");
  }, 4000);
  escalate.unref?.();
  return true;
}

/** Kill every running session started by an agent run. Returns the count. */
export function killSessionsByRun(runId: string): number {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.runId === runId && killSession(session.id)) count++;
  }
  return count;
}

/**
 * Write to a user session's stdin. Submitted lines are still checked
 * against the hard-block list, so `bash` + typed input cannot sidestep it.
 */
export function writeInput(
  id: string,
  data: string,
): { ok: true } | { ok: false; error: string; status: number } {
  const session = sessions.get(id);
  if (!session) return { ok: false, error: "Session not found", status: 404 };
  const stdin = session.child?.stdin;
  if (session.status !== "running" || !stdin || stdin.destroyed || !stdin.writable) {
    return { ok: false, error: "Session is not accepting input", status: 409 };
  }
  for (const { line } of session.lineTracker.feed(data)) {
    const verdict = classifyCommand(line);
    if (line.trim() && verdict.allowed === false) {
      return { ok: false, error: `Refused: this input ${verdict.reason}.`, status: 400 };
    }
  }
  stdin.write(data);
  return { ok: true };
}

export function subscribe(
  id: string,
  handler: (chunk: TerminalChunk) => void,
): () => void {
  const session = sessions.get(id);
  if (!session) return () => {};
  session.subscribers.add(handler);
  return () => session.subscribers.delete(handler);
}

/** Drop finished sessions older than an hour so the map cannot grow forever. */
/** Forget a finished session (the terminal tab's close button). Running sessions stay. */
export function removeSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session || session.status === "running") return false;
  return sessions.delete(id);
}

/**
 * Where a user command runs: the workspace root, or a directory inside it
 * given relative to the root. Returns an error string for anything that
 * escapes the root or is not a directory.
 */
export function resolveSessionCwd(rootPath: string, cwd: unknown): { cwd: string } | { error: string } {
  const root = path.resolve(rootPath);
  if (cwd === undefined || cwd === null || cwd === "" || cwd === ".") return { cwd: root };
  if (typeof cwd !== "string" || cwd.includes("\0") || path.isAbsolute(cwd)) {
    return { error: "cwd must be a path relative to the workspace root" };
  }
  const resolved = path.resolve(root, cwd);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    return { error: "cwd escapes the workspace" };
  }
  try {
    if (!statSync(resolved).isDirectory()) return { error: `cwd is not a directory: ${cwd}` };
  } catch {
    return { error: `cwd does not exist: ${cwd}` };
  }
  return { cwd: resolved };
}

export function pruneSessions(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, session] of sessions) {
    if (session.status !== "running" && (session.endedAt ?? 0) < cutoff) {
      sessions.delete(id);
    }
  }
}

/** Serializable view for API responses. */
export function serializeSession(session: TerminalSession) {
  return {
    id: session.id,
    command: session.command,
    cwd: session.cwd,
    status: session.status,
    exitCode: session.exitCode,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    detectedUrl: session.detectedUrl,
    runId: session.runId ?? undefined,
    origin: session.origin,
    output: session.buffer.toString(),
    offset: session.buffer.end,
  };
}

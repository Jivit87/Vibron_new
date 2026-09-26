/**
 * The harness's view of the terminal.
 *
 * Every command an agent starts is attributed to its run (so cancel can kill
 * it) and labelled `origin: "agent"` unless the caller says otherwise (so the terminal panel can tell it apart
 * from what the user typed).
 *
 * Agent commands also run in the repo's environment (venv first on PATH, a
 * `python` → `python3` shim), the same one the baseline suite runs in. Without
 * it, `python -m pytest` exits 127 on a machine with only `python3`, and the
 * gate reads "fails before and after" instead of the real outcome.
 */

import * as terminal from "@/lib/terminal";
import type { RunOptions, TerminalSession } from "@/lib/terminal";

type AgentRunOptions = RunOptions;

/** Start a command attributed to a run; returns immediately. */
export function startRunCommand(options: AgentRunOptions): TerminalSession {
  return terminal.startCommand({ origin: "agent", repoEnv: true, ...options });
}

/** Run a command to completion (or timeout, or cancellation). */
export function runRunCommand(options: AgentRunOptions & { maxOutputChars?: number }) {
  return terminal.runCommand({ origin: "agent", repoEnv: true, ...options });
}

export function killSessionsByRun(runId: string): number {
  return terminal.killSessionsByRun(runId);
}

/**
 * Failure classification and trajectory guards (ported from Pramana
 * `agent/loop.py` guards + `agent/prompts.py` nudges).
 *
 * The harness watches the trajectory, not the model's claims: repeated
 * identical calls, repeated failed edits to one file, back-and-forth edits,
 * throwaway inline probes instead of a reproduction file, turns without a
 * source change, full-suite runs, and a shrinking budget. Each trigger
 * yields one short nudge; the second stuck event forces a replan. Nudges are
 * appended to the tool_result text rather than sent as new messages, so the
 * cached prefix is untouched.
 */

import type { FailureClass } from "@/lib/agents/events";
import { SCRATCH_DIR } from "@/lib/harness/snapshot";

/* --------------------------- classification ------------------------------ */

const FAILURE_TABLE: [FailureClass, RegExp][] = [
  ["refused", /^Refused\b|user declined|not available to this agent/i],
  ["schema_error", /not valid JSON|malformed arguments|is required\.|must be an array|unknown tool/i],
  ["patch_conflict", /`find` (text )?(was not found|matches \d+ times|is not present)|git apply .*failed|old_str (was )?not found/i],
  ["syntax_error", /SyntaxError|unparseable|JSON error|IndentationError|Unexpected token/i],
  ["missing_file", /file not found|no such file|ENOENT|path does not exist|cannot find module|ModuleNotFoundError/i],
  ["command_not_found", /command not found|not recognized as an internal|exited 127\b|: not found$/im],
  ["timeout", /timed out|timeout|ETIMEDOUT|\bkilled\b/i],
  ["regression", /REGRESSION/],
  ["test_failure", /\bFAIL(ED|URE)?\b|AssertionError|assert |Tests?:\s+\d+ failed|\d+ failed|Error:/],
];

/** Classify a failed tool result or verification output. Null = not a failure we recognise. */
export function classifyFailure(output: string): FailureClass | null {
  const text = output.slice(0, 6000);
  for (const [cls, rx] of FAILURE_TABLE) {
    if (rx.test(text)) return cls;
  }
  return null;
}

/** One class-specific recovery hint, given once per class. */
export const CLASS_HINTS: Partial<Record<FailureClass, string>> = {
  patch_conflict:
    "Your edit did not match. View the exact current lines (view with start_line/end_line) and copy `find` character-for-character, without line numbers; keep it small (2-5 lines) and unique.",
  missing_file:
    "That path does not exist. Locate the right file with find_symbols, or list the repository files with run_command, before retrying.",
  command_not_found:
    "The command is not installed here. Use the project's own runner (e.g. `python -m pytest`, `npx vitest`, `node --test`) or check the scripts in package.json / pyproject.",
  syntax_error:
    "Fix the syntax before anything else: check indentation, brackets and quotes in the text you wrote.",
  timeout:
    "The command timed out. Run a narrower target (one test file or one test) instead of the whole suite.",
  schema_error:
    "The tool call was malformed. Send a single JSON object with exactly the documented argument names.",
};

/* ------------------------------ nudges ----------------------------------- */

export const NUDGES = {
  noFinish:
    "You stopped without calling `finish`. The run only ends through `finish`: if the fix is complete and verified, call `finish` with a summary and your reproduction command; otherwise continue working with a tool.",
  repeat: (name: string, n: number) =>
    `You have made the exact same \`${name}\` call ${n} times and got the same result. Repeating it will not help. Step back: re-read the relevant code, question your assumption, and try a different approach.`,
  editFail: (n: number, path: string) =>
    `Your last ${n} edits to ${path} failed. View the exact current lines first (view with start_line/end_line) and copy \`find\` character-for-character, without the line-number column. Use a smaller, unique \`find\` (2-5 lines).`,
  inlineScript: (n: number) =>
    `You have run ${n} one-off inline scripts (python -c / node -e / heredocs) and have not written a reproduction file. Throwaway commands cannot be used as proof, because the harness has to re-run your check on the ORIGINAL code and on your patched code. Write ONE file now - e.g. create_file ${SCRATCH_DIR}/repro.py (or .mjs) - that asserts the behaviour the task expects (it must exit non-zero while the bug is present), run it, and keep extending that same file.`,
  noEdit: (used: number, total: number) =>
    `You have used ${used} of ${total} steps without changing any source file. Commit to the most likely fix location now, make the edit, and verify it.`,
  stalled: (turns: number) =>
    `${turns} turns have passed since your last source change. If the fix is done, verify it and call \`finish\`; if not, decide what is blocking you and act on it instead of exploring further.`,
  fullSuite: (n: number) =>
    `You have run the entire test suite ${n} times. It is slow and its failures are often pre-existing. Run only the test files for the code you changed, and use \`compare\` to check whether a failure also happens on the original code.`,
  oscillation:
    "Your edits are going back and forth between versions of the same file. Stop editing: re-read the task, restate the root cause, and use `compare` to check whether the failure you are chasing already existed before your changes.",
  budget: (left: number, what: string) => `Budget: ${left} steps left. ${what}`,
  replan:
    "You appear to be stuck. Stop and re-plan: restate what the task expects versus what happens now, list the two most likely root causes, pick one, and change your approach.",
};

/* ------------------------------ guards ----------------------------------- */

export interface TrackedCall {
  name: string;
  input: Record<string, unknown>;
  output: string;
  failed: boolean;
}

export interface GuardNote {
  text: string;
  failureClass: FailureClass;
  action: "hint" | "replan";
}

function callKey(name: string, input: Record<string, unknown>): string {
  let args: string;
  try {
    args = JSON.stringify(input, Object.keys(input ?? {}).sort()).slice(0, 2000);
  } catch {
    args = String(input).slice(0, 2000);
  }
  return `${name}:${args}`;
}

const INLINE_RE = /<<\s*['"]?\w+|python3?\s+-c\b|node\s+-e\b/;
const MUTATING = new Set(["edit_file", "multi_edit", "create_file", "write_file", "append_file", "delete_file", "rename_file"]);
const FULL_SUITE_RE =
  /^(python3? -m )?(pytest|py\.test)(\s+(-q|-qq|-x|-v|-vv|-rA|-ra|-s|--tb=\w+))*\s*$|^(npm|yarn|pnpm) (run )?test\s*$|^go test \.\/\.\.\.\s*$|^cargo test\s*$/;
const STALL_TURNS = 10;

/* ---------------------------- give-up rules ------------------------------ */

/**
 * The token burners (measured: 4 unproven issues on a 120B model each ran
 * ~2 attempts x up to 40 turns without ever producing a verified edit).
 * An attempt ends early instead of spending its whole turn budget.
 */
export const GIVE_UP = {
  /** End the attempt when no source file was edited by this turn. */
  noEditTurns: 12,
  /** The same, for the agent that runs after the one-call fast path failed (it has already seen the code). */
  noEditTurnsAfterFastPath: 6,
  /** Turn cap for the agent that runs after the one-call fast path failed. */
  maxTurnsAfterFastPath: 12,
  /** End the attempt when nothing was verified (finish / compare / checkpoint) by this turn. */
  noProofTurns: 20,
};

/** Default per-issue budget, input + output tokens. */
export const DEFAULT_ISSUE_TOKEN_BUDGET = 150_000;

/** The per-issue token budget: explicit option, then VIBERON_ISSUE_TOKEN_BUDGET, then the default. */
export function issueTokenBudget(explicit?: number, env: Record<string, string | undefined> = process.env): number {
  if (explicit && explicit > 0) return explicit;
  const fromEnv = Number(env.VIBERON_ISSUE_TOKEN_BUDGET);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_ISSUE_TOKEN_BUDGET;
}

export function gaveUpAfterTokens(tokens: number): string {
  return `gave up after ${tokens} tokens without proof`;
}

/** A command that runs the whole test suite rather than a targeted file. */
export function isFullSuiteCommand(command: string): boolean {
  return FULL_SUITE_RE.test(command.trim());
}

/**
 * Trajectory guards for one attempt. `track` every tool result; call
 * `guards` once per turn for the notes to append.
 */
export class TrajectoryGuards {
  private history: string[] = [];
  private nudged = new Set<string>();
  private editFail = new Map<string, number>();
  private hintedClasses = new Set<FailureClass>();
  private sameError = new Map<string, number>();
  private turnsSinceEdit = 0;
  private stuckFlag = false;
  edits = 0;
  fullSuiteRuns = 0;
  oscillations = 0;
  inlineScripts = 0;
  scratchFiles = 0;
  stuckEvents = 0;
  readonly failureClasses: Partial<Record<FailureClass, number>> = {};

  constructor(private readonly maxSteps: number) {}

  /** Record a tool result. Returns a class-specific hint to append, if one is due. */
  track(call: TrackedCall): GuardNote | null {
    if (call.name !== "finish") {
      this.history.push(callKey(call.name, call.input) + (call.failed ? "#ERR" : ""));
      if (this.history.length > 12) this.history.shift();
    }
    if (call.name === "run_command" && typeof call.input.command === "string") {
      if (INLINE_RE.test(call.input.command) && !call.input.command.includes(SCRATCH_DIR)) {
        this.inlineScripts += 1;
      }
      if (isFullSuiteCommand(call.input.command)) this.fullSuiteRuns += 1;
    }
    if ((call.name === "edit_file" || call.name === "multi_edit") && /going back and forth/.test(call.output)) {
      this.oscillations += 1;
      this.stuckFlag = true;
    }
    if (MUTATING.has(call.name)) {
      const path = String(call.input.path ?? call.input.to ?? "");
      if (call.failed) this.editFail.set(path, (this.editFail.get(path) ?? 0) + 1);
      else {
        this.editFail.set(path, 0);
        if (path.startsWith(SCRATCH_DIR)) this.scratchFiles += 1;
        else {
          this.edits += 1;
          this.turnsSinceEdit = 0;
        }
      }
    }
    if (!call.failed) return null;

    const cls = classifyFailure(call.output);
    if (!cls) return null;
    this.failureClasses[cls] = (this.failureClasses[cls] ?? 0) + 1;

    // The same error twice is a stuck signal.
    const errorKey = call.output.slice(0, 200);
    const seen = (this.sameError.get(errorKey) ?? 0) + 1;
    this.sameError.set(errorKey, seen);
    if (seen === 2) this.stuckFlag = true;

    const hint = CLASS_HINTS[cls];
    if (hint && !this.hintedClasses.has(cls)) {
      this.hintedClasses.add(cls);
      return { text: hint, failureClass: cls, action: "hint" };
    }
    return null;
  }

  private once(tag: string): boolean {
    if (this.nudged.has(tag)) return false;
    this.nudged.add(tag);
    return true;
  }

  /**
   * The no-progress guard's hard stop: after `turns` completed turns, a
   * reason to END the attempt (no source edit by GIVE_UP.noEditTurns, or no
   * verification by GIVE_UP.noProofTurns), else null. Only applies when the
   * attempt has turns left beyond the threshold.
   */
  giveUp(turns: number, verified: boolean, noEditTurns = GIVE_UP.noEditTurns): string | null {
    if (this.edits === 0 && turns >= noEditTurns && this.maxSteps > noEditTurns) {
      return `no source edit after ${turns} turns`;
    }
    if (!verified && turns >= GIVE_UP.noProofTurns && this.maxSteps > GIVE_UP.noProofTurns) {
      return `no verification after ${turns} turns`;
    }
    return null;
  }

  /** Notes due after the turn at `step` (1-based). */
  guards(step: number): GuardNote[] {
    const notes: GuardNote[] = [];
    const hint = (text: string, failureClass: FailureClass = "no_progress") =>
      notes.push({ text, failureClass, action: "hint" });
    this.turnsSinceEdit += 1;

    const counts = new Map<string, number>();
    for (const key of this.history) counts.set(key, (counts.get(key) ?? 0) + 1);
    for (const [key, n] of counts) {
      if (n >= 3 && this.once(key)) {
        this.stuckFlag = true;
        hint(NUDGES.repeat(key.split(":", 1)[0], n));
      }
    }
    for (const [path, n] of this.editFail) {
      if (n >= 3 && this.once(`editfail:${path}:${Math.floor(n / 3)}`)) {
        hint(NUDGES.editFail(n, path || "(no path given - always pass path)"), "patch_conflict");
      }
    }
    for (const threshold of [4, 10]) {
      if (this.inlineScripts >= threshold && this.scratchFiles === 0 && this.once(`inline${threshold}`)) {
        hint(NUDGES.inlineScript(this.inlineScripts));
      }
    }
    for (const threshold of [2, 4]) {
      if (this.fullSuiteRuns >= threshold && this.once(`suite${threshold}`)) hint(NUDGES.fullSuite(this.fullSuiteRuns));
    }
    if (this.oscillations > 0 && this.once(`oscillation${this.oscillations}`)) hint(NUDGES.oscillation);
    if (this.edits === 0 && step >= Math.max(8, Math.floor(this.maxSteps * 0.5)) && this.once("noedit")) {
      hint(NUDGES.noEdit(step, this.maxSteps));
    }
    if (this.edits > 0 && this.turnsSinceEdit >= STALL_TURNS) {
      hint(NUDGES.stalled(this.turnsSinceEdit));
      this.turnsSinceEdit = 0;
      this.stuckFlag = true;
    }

    if (this.stuckFlag) {
      this.stuckFlag = false;
      this.stuckEvents += 1;
      // The second stuck event forces a replan.
      if (this.stuckEvents === 2) notes.push({ text: NUDGES.replan, failureClass: "no_progress", action: "replan" });
    }

    const left = this.maxSteps - step;
    if (left === 10 && this.once("b10")) hint(NUDGES.budget(left, "Converge: complete the fix, verify it, and call finish."));
    if (left === 3 && this.once("b3")) hint(NUDGES.budget(left, "Call finish now with your best verified change."));
    return notes;
  }
}

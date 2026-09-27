/**
 * The blind independent test writer (ported from Pramana
 * `agent/testwriter.py` and `_independent`).
 *
 * After the gate accepts a change with strong evidence, a second agent that
 * never sees the patch gets the task, the predicted acceptance criteria, a
 * repository summary and the related test names. It reads the code, writes
 * the regression test a maintainer would add (only under
 * `.viberon/scratch/`, so it is never part of the patch) and calls `done`
 * with the command. The harness runs that command on the original and the
 * patched code: evidence that does not come from the solver's own reading.
 * Anything the writer changed outside the scratch dir is undone, restoring
 * the accepted patch exactly.
 */

import path from "node:path";

import type { EventSink } from "@/lib/agents/events";
import { runAgent, type AgentRunResult, type RunController } from "@/lib/agents/runner";
import type { EngineInput } from "@/lib/context/engine";
import { renderCriteria } from "@/lib/harness/criteria";
import { rootRelative } from "@/lib/harness/gate";
import { restore, SCRATCH_DIR, snapshot } from "@/lib/harness/snapshot";
import type { WorkspaceHandle } from "@/lib/workspace";

export const WRITER_MAX_STEPS = 12;

export interface IndependentComparison {
  beforePassed: boolean;
  afterPassed: boolean;
  beforeOutput: string;
  afterOutput: string;
}

export interface IndependentTestOutcome {
  status: "fixes" | "passes" | "still_failing" | "regression" | "inconclusive";
  command?: string;
  output?: string;
  reason?: string;
}

export interface TestWriterOptions {
  root: string;
  /** The accepted change's snapshot: the work tree is put back to it exactly afterwards. */
  acceptedTree: string;
  task: string;
  criteria: string[];
  /** Repository overview (stack, file count, test command). */
  summary: string;
  relatedTests: string[];
  model: string;
  handle: WorkspaceHandle;
  engine: EngineInput;
  emit: EventSink;
  signal?: AbortSignal;
  runId?: string;
  maxSteps?: number;
  /** Runs the command on the original and on the patched code (`Gate.compareIndependent`). */
  compare: (command: string) => Promise<IndependentComparison>;
  /** The writer's agent run, for cost accounting. */
  onRun?: (run: AgentRunResult) => void;
}

/** An assertion failed, as opposed to an import error or a crash in the test itself. */
export function assertionFailure(output: string): boolean {
  return /AssertionError|ERR_ASSERTION|assertion failed|Expected values to be strictly equal|\bassert\b.*\bfailed\b/i.test(output);
}

/** Classify a blind test's runs on the original and the patched code. */
export function classifyIndependent(command: string, result: IndependentComparison): IndependentTestOutcome {
  if (result.afterPassed) return { status: result.beforePassed ? "passes" : "fixes", command };
  if (assertionFailure(result.afterOutput)) {
    return { status: result.beforePassed ? "regression" : "still_failing", command, output: result.afterOutput.slice(-3000) };
  }
  return { status: "inconclusive", command, reason: "The test did not run cleanly on the patched code (no assertion failed)." };
}

function inScratch(root: string, raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  return path.resolve(root, raw.trim()).startsWith(`${path.join(path.resolve(root), SCRATCH_DIR)}${path.sep}`);
}

function writerTask(options: TestWriterOptions): string {
  const criteria = renderCriteria(options.criteria);
  const related = options.relatedTests.length ? `\nExisting related tests: ${options.relatedTests.slice(0, 6).join(", ")}` : "";
  return `<task>\n${options.task.slice(0, 12_000)}\n</task>\n\n${criteria ? `${criteria}\n\n` : ""}<repository>\n${options.summary}${related}\n</repository>\n\nWrite the independent regression test now, in ${SCRATCH_DIR}/.`;
}

export async function writeIndependentTest(options: TestWriterOptions): Promise<IndependentTestOutcome> {
  const { root, emit } = options;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  let command: string | null = null;
  let nudged = false;
  const refusal = `Refused: you may only create or edit files under ${SCRATCH_DIR}/. Never modify source files.`;
  const controller: RunController = {
    isDone: () => command !== null,
    beforeMutation: async ({ input }) => (inScratch(root, input.path) ? null : refusal),
    onFinishAttempt: async () => {
      if (command !== null || nudged) return null;
      nudged = true;
      return { feedback: "Use a tool, or call `done` with the command that runs your test." };
    },
  };

  let run: AgentRunResult | null = null;
  try {
    run = await runAgent({
      agentId: "test_writer",
      stepId: "independent-test",
      role: "test_writer",
      model: options.model,
      task: writerTask(options),
      title: "Independent test (blind)",
      files: [`${SCRATCH_DIR}/**`],
      handle: options.handle,
      engine: options.engine,
      memory: options.engine.memory,
      commandPolicy: "auto",
      emit,
      signal: options.signal,
      maxIterations: options.maxSteps ?? WRITER_MAX_STEPS,
      runId: options.runId,
      showThinking: false,
      controller,
      mcp: false,
      harness: {
        done: async (input) => {
          command = rootRelative(input.command, root);
          return "Recorded. The harness runs it on the original and the patched code.";
        },
      },
    });
    options.onRun?.(run);
  } finally {
    // The writer may only add scratch files (never in a snapshot): put the accepted patch back exactly.
    if ((await snapshot(root).catch(() => null)) !== options.acceptedTree) {
      await restore(root, options.acceptedTree);
      emit({ type: "agent_text", agentId: "test_writer", text: "\n[harness] The test writer changed files outside the scratch dir; the accepted patch was restored.\n" });
    }
  }

  if (command === null) {
    emit({ type: "independent_test", status: "gave_up", seconds: seconds() });
    return { status: "inconclusive", reason: run?.error ?? "The independent writer gave up without a test command." };
  }
  const written: string = command;
  emit({ type: "independent_test", status: "written", command: written, seconds: seconds() });
  const outcome = classifyIndependent(written, await options.compare(written));
  emit({ type: "independent_test", status: "ran", command: written, verdict: outcome.status, seconds: seconds() });
  return outcome;
}

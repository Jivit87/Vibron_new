/**
 * The blind independent test writer (ported from Pramana
 * `agent/testwriter.py` and `_independent`).
 *
 * A second agent that never sees the patch gets the task, the predicted
 * acceptance criteria, a repository summary and the related test names. It
 * reads the code, writes the regression test a maintainer would add (only
 * under `.viberon/scratch/`, so it is never part of the patch) and calls
 * `done` with the command. The harness runs that command on the original and
 * the patched code: evidence that does not come from the solver's own reading.
 *
 * Because it is blind, it does not wait for the patch: `draftIndependentTest`
 * runs *during* the solve, in a throwaway checkout of the original code (so
 * nothing it does can touch the solver's tree), and `runIndependentTest`
 * runs the drafted test once the gate accepts. On a real run this took the
 * writer's ~40 s off the critical path.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EventSink } from "@/lib/agents/events";
import { runAgent, type AgentRunResult, type RunController } from "@/lib/agents/runner";
import type { EngineInput } from "@/lib/context/engine";
import { renderCriteria } from "@/lib/harness/criteria";
import { rootRelative } from "@/lib/harness/gate";
import { SCRATCH_DIR, withOriginal } from "@/lib/harness/snapshot";
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

export interface DraftOptions {
  /** The solver's work tree; the writer runs in a throwaway checkout of `baseRef` instead. */
  root: string;
  baseRef: string;
  task: string;
  criteria: string[];
  /** Repository overview (stack, file count, test command). */
  summary: string;
  relatedTests: string[];
  model: string;
  /** Workspace and engine for a directory (the isolated original checkout). */
  open: (dir: string) => Promise<{ handle: WorkspaceHandle; engine: EngineInput }>;
  emit: EventSink;
  signal?: AbortSignal;
  runId?: string;
  maxSteps?: number;
  /** The writer's agent run, for cost accounting. */
  onRun?: (run: AgentRunResult) => void;
}

/** A written test: its command (root-relative) and the scratch files it needs. */
export interface IndependentDraft {
  command: string;
  files: { path: string; content: string }[];
  started: number;
}

const MAX_DRAFT_FILES = 20;
const MAX_DRAFT_BYTES = 256 * 1024;

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

function writerTask(options: DraftOptions): string {
  const criteria = renderCriteria(options.criteria);
  const related = options.relatedTests.length ? `\nExisting related tests: ${options.relatedTests.slice(0, 6).join(", ")}` : "";
  return `<task>\n${options.task.slice(0, 12_000)}\n</task>\n\n${criteria ? `${criteria}\n\n` : ""}<repository>\n${options.summary}${related}\n</repository>\n\nWrite the independent regression test now, in ${SCRATCH_DIR}/.`;
}

/** Scratch files with their mtimes, to tell what the writer added or changed. */
async function scratchFiles(dir: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const base = path.join(dir, SCRATCH_DIR);
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(base, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(child);
      else if (e.isFile()) out.set(child, (await stat(path.join(base, child))).mtimeMs);
    }
  };
  await walk("");
  return out;
}

/**
 * Run the blind writer in a throwaway checkout of the original code, while
 * the solver works. Returns null when it gives up (and says so).
 */
export async function draftIndependentTest(options: DraftOptions): Promise<IndependentDraft | null> {
  const { emit } = options;
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 100) / 10;
  const draft = await withOriginal(options.root, options.baseRef, async (dir) => {
    const before = await scratchFiles(dir);
    const { handle, engine } = await options.open(dir);
    let command: string | null = null;
    let nudged = false;
    const refusal = `Refused: you may only create or edit files under ${SCRATCH_DIR}/. Never modify source files.`;
    const controller: RunController = {
      isDone: () => command !== null,
      beforeMutation: async ({ input }) => (inScratch(dir, input.path) ? null : refusal),
      onFinishAttempt: async () => {
        if (command !== null || nudged) return null;
        nudged = true;
        return { feedback: "Use a tool, or call `done` with the command that runs your test." };
      },
    };
    const run = await runAgent({
      agentId: "test_writer",
      stepId: "independent-test",
      role: "test_writer",
      model: options.model,
      task: writerTask(options),
      title: "Independent test (blind)",
      files: [`${SCRATCH_DIR}/**`],
      handle,
      engine,
      memory: engine.memory,
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
          command = rootRelative(input.command, dir);
          return "Recorded. The harness runs it on the original and the patched code.";
        },
      },
    });
    options.onRun?.(run);
    if (command === null) return null;
    const files: IndependentDraft["files"] = [];
    for (const [rel, mtime] of await scratchFiles(dir)) {
      if (before.get(rel) === mtime || files.length >= MAX_DRAFT_FILES) continue;
      const full = path.join(dir, SCRATCH_DIR, rel);
      if ((await stat(full)).size > MAX_DRAFT_BYTES) continue;
      files.push({ path: `${SCRATCH_DIR}/${rel}`, content: await readFile(full, "utf8") });
    }
    return { command: command as string, files };
  });
  if (!draft) {
    emit({ type: "independent_test", status: "gave_up", seconds: seconds() });
    return null;
  }
  emit({ type: "independent_test", status: "written", command: draft.command, seconds: seconds() });
  return { ...draft, started };
}

/** Put a drafted test into the real scratch dir and run it on the original and the patched code. */
export async function runIndependentTest(
  root: string,
  draft: IndependentDraft,
  compare: (command: string) => Promise<IndependentComparison>,
  emit: EventSink,
): Promise<IndependentTestOutcome> {
  for (const file of draft.files) {
    const target = path.join(root, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  const outcome = classifyIndependent(draft.command, await compare(draft.command));
  const seconds = Math.round((Date.now() - draft.started) / 100) / 10;
  emit({ type: "independent_test", status: "ran", command: draft.command, verdict: outcome.status, seconds });
  return outcome;
}

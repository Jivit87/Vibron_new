/**
 * Acceptance-criteria prediction (ported from Pramana `_predict_criteria`):
 * one cheap call, before any code is read, lists what a maintainer's
 * regression test would assert. The solver, the blind test writer and the
 * reviewer all get the list, framed as a prediction that may be wrong.
 */

import { runTurn } from "@/lib/ai";
import { reviewModel, type RunTurnFn, type TurnOutcome } from "@/lib/review";

export const MAX_CRITERIA = 8;

const PROMPT = (issue: string) => `You are preparing the acceptance checklist for this issue before anyone writes code.

<issue>
${issue}
</issue>

List the concrete, observable behaviours a maintainer's regression test would assert once the issue is resolved:
- item 1: the general invariant the issue implies, stated in full generality (not only for the example's data);
- every example in the issue, with its expected result;
- sibling cases that vary the KIND of input, not just its shape: other value types or containers the same rule applies to (lists, sets, objects, not only the type in the example), other entry points or arguments that share the code path, and boundary values (empty, single, nested, None);
- existing behaviour that must remain unchanged.
Write at most ${MAX_CRITERIA} lines, each formatted "N. <inputs/situation> -> <expected observable result>". Be specific. Do not propose an implementation. If an expected result cannot be determined from the issue, write "unspecified" for it.`;

/** Numbered lines only, numbers stripped, at most MAX_CRITERIA. */
export function parseCriteria(text: string): string[] {
  return text
    .split("\n")
    .map((line) => /^\s*\d+[.)]\s+(\S.*)$/.exec(line)?.[1].trim())
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_CRITERIA)
    .map((item) => item.slice(0, 300));
}

export async function predictCriteria(input: {
  task: string;
  /** Default: `reviewModel()`, the cheapest agentic model available. */
  model?: string;
  signal?: AbortSignal;
  runTurn?: RunTurnFn;
  onTurn?: (turn: TurnOutcome) => void;
}): Promise<string[]> {
  const run = input.runTurn ?? runTurn;
  const turn = await run({
    model: await reviewModel(input.model),
    system: [{ text: "You are a meticulous senior maintainer." }],
    messages: [{ role: "user", content: [{ type: "text", text: PROMPT(input.task.slice(0, 12_000)) }] }],
    maxTokens: 800,
    effort: "low",
    signal: input.signal,
  });
  input.onTurn?.(turn);
  return parseCriteria(turn.text);
}

/** The block for a first message; empty when there are no criteria. */
export function renderCriteria(items: string[], tag = "predicted_acceptance_criteria"): string {
  if (!items.length) return "";
  return `<${tag}>\nPredicted by the harness from the task text alone, before any code was read: a maintainer's-eye checklist that MAY BE WRONG. Check each item against the task and drop any that contradict it; make your reproduction check the rest.\n${items.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</${tag}>`;
}

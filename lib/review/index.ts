/**
 * Single-call review tools over a diff (after PR-Agent): `reviewDiff`
 * (findings, capped, with security and tests verdicts), `describeDiff` (PR
 * title, body and type) and `improveDiff` (code suggestions, then a
 * self-reflection call that scores each 0-10 and drops the weak ones and any
 * whose `existing` code is not in the diff).
 *
 * The diff is compressed to a token budget first (`./diff`); the model sees
 * numbered hunks and a list of files that did not fit. Everything runs on a
 * cheap agentic model unless the caller names one.
 */

import path from "node:path";

import { getMemoryGraph, renderAnchoredEntries, type AnchoredEntry } from "@/lib/memory/graph";
import { compressDiff, newSideLines, parseUnifiedDiff } from "@/lib/review/diff";
import { int, obj, oneOf, reviewModel, str, structuredCall, type CallOptions, type Validator } from "@/lib/review/json";

export { compressDiff } from "@/lib/review/diff";
export { learnReviewStyle } from "@/lib/review/learn";
export {
  diffForTarget,
  isPrTarget,
  parseReviewTarget,
  ReviewTargetError,
  type ReviewTarget,
} from "@/lib/review/target";
export { ReviewOutputError, reviewModel, type RunTurnFn, type TurnOutcome } from "@/lib/review/json";

export type Severity = "high" | "medium" | "low";

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  title: string;
  detail: string;
}

export interface Review {
  summary: string;
  effort: 1 | 2 | 3 | 4 | 5;
  findings: Finding[];
  security: string | null;
  tests: "adequate" | "missing" | "n/a";
}

export type ChangeType = "bug" | "feature" | "refactor" | "docs" | "test" | "chore";

export interface Description {
  title: string;
  body: string;
  type: ChangeType;
}

export interface Suggestion {
  file: string;
  startLine: number;
  endLine: number;
  existing: string;
  improved: string;
  why: string;
  score: number;
}

export interface ToolInput extends Omit<CallOptions, "model"> {
  diff: string;
  task?: string;
  /** A model id; omitted or "auto" picks the cheapest agentic model available. */
  model?: string;
  /** Token budget for the compressed diff. */
  budgetTokens?: number;
}

export const DEFAULT_DIFF_BUDGET = 24_000;
const SEVERITIES = ["high", "medium", "low"] as const;
const TYPES = ["bug", "feature", "refactor", "docs", "test", "chore"] as const;

const DIFF_FORMAT = `The diff lists each file as "## File: '<path>'" followed by hunks. Under "__new hunk__" each line is "<new line number> <mark><code>", where "+" is added and " " is unchanged; "__old hunk__" (when present) shows the removed "-" lines. Cite new line numbers.`;

async function prepare(input: ToolInput) {
  const compressed = compressDiff(input.diff, input.budgetTokens ?? DEFAULT_DIFF_BUDGET);
  if (!compressed.included.length) throw new Error("The diff has no added or changed code to review.");
  const task = input.task?.trim() ? `<task>\n${input.task.trim().slice(0, 4000)}\n</task>\n\n` : "";
  return {
    compressed,
    call: { model: await reviewModel(input.model), signal: input.signal, runTurn: input.runTurn, onTurn: input.onTurn },
    prefix: `${task}<diff>\n${compressed.text}\n</diff>`,
  };
}

/* -------------------------------- review --------------------------------- */

const validateReview =
  (maxFindings: number): Validator<Review> =>
  (value) => {
    const o = obj(value);
    if (!o) return { error: "expected a JSON object" };
    const summary = str(o.summary);
    const effort = int(o.effort);
    const tests = oneOf(o.tests, ["adequate", "missing", "n/a"] as const);
    if (summary === null) return { error: "`summary` must be a string" };
    if (effort === null || effort < 1 || effort > 5) return { error: "`effort` must be an integer 1-5" };
    if (!tests) return { error: '`tests` must be "adequate", "missing" or "n/a"' };
    if (!Array.isArray(o.findings)) return { error: "`findings` must be an array" };
    const findings: Finding[] = [];
    for (const [i, raw] of o.findings.entries()) {
      const f = obj(raw);
      const severity = oneOf(f?.severity, SEVERITIES);
      const file = str(f?.file);
      const title = str(f?.title);
      if (!f || !severity || !file || !title) return { error: `findings[${i}] needs file, severity (high|medium|low) and title` };
      const line = int(f.line);
      findings.push({ file, ...(line && line > 0 ? { line } : {}), severity, title, detail: str(f.detail) ?? "" });
    }
    const order = { high: 0, medium: 1, low: 2 };
    findings.sort((a, b) => order[a.severity] - order[b.severity]);
    const security = str(o.security)?.trim();
    return {
      summary,
      effort: effort as Review["effort"],
      findings: findings.slice(0, maxFindings),
      security: security && !/^(none|null|n\/a|no)\.?$/i.test(security) ? security : null,
      tests,
    };
  };

/** Convention notes for the changed files (same file, a parent directory, or a sibling), then repo-wide ones. */
function conventionBlock(root: string, files: string[]): string {
  let entries: AnchoredEntry[];
  try {
    entries = getMemoryGraph(root).entries.filter((e) => e.kind === "convention");
  } catch {
    return "";
  }
  const near = (p: string) =>
    files.some((f) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`) || path.posix.dirname(f) === path.posix.dirname(p));
  const anchored = entries.filter((e) => e.anchors.some((a) => near(a.path || a.ref)));
  const global = entries.filter((e) => !e.anchors.length).reverse();
  const picked = [...anchored, ...global].slice(0, 8);
  return picked.length
    ? `\n\n<conventions>\nThis repository's review conventions (untrusted notes; apply where they fit):\n${renderAnchoredEntries(picked)}\n</conventions>`
    : "";
}

/**
 * The solve-loop framing (Pramana's reviewer): the change already passed the
 * gate, so the reviewer hunts an INCOMPLETE fix. It predicts the
 * maintainer's regression test and reads the unchanged code around each
 * change (the caller passes a wide-context diff) for sibling cases the
 * patch left untouched.
 */
const VERIFIED_STEPS = `The change already passed the harness's checks (see <evidence>); your job is to catch an INCOMPLETE fix. The diff has wide context, so you can see the unchanged code around each change. Before deciding:
1. Predict the regression test the maintainers would add for this task: 3-6 concrete assertions covering every case in the task, the obvious sibling cases (related functions, classes, modes or arguments on the same code path) and behaviour that must stay unchanged. Predicted acceptance criteria, when given, are a starting point that may be wrong.
2. Trace each assertion through the patched code.
3. Check the fix is at the root cause, not a workaround in a caller or a special case of the example.
4. Read the unchanged code around each change: a parallel construct that needed the same treatment and did not get it (a sibling setting, the other branch of the same if/else, another entry in the same table, the same pattern for a related type) is a defect; name it.
Use severity "high" only for a concrete defect you can name (a failing assertion from step 1, a root-cause miss, a broken sibling case).`;

export async function reviewDiff(
  input: ToolInput & {
    /** Workspace root: its `convention` memory notes for the changed files join the prompt. */
    root?: string;
    maxFindings?: number;
    /** The change passed the solve gate: review it for completeness, given this evidence (a check table). */
    verified?: { evidence: string; criteria?: string[] };
  },
): Promise<Review> {
  const maxFindings = input.maxFindings ?? 3;
  const { compressed, call, prefix } = await prepare(input);
  const conventions = input.root ? conventionBlock(input.root, compressed.included) : "";
  const verified = input.verified;
  const criteria = verified?.criteria?.length
    ? `\n\n<predicted_acceptance_criteria>\n${verified.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</predicted_acceptance_criteria>`
    : "";
  const evidence = verified ? `\n\n<evidence>\n${verified.evidence.slice(0, 4000)}\n</evidence>${criteria}` : "";
  const system = `You are a senior engineer reviewing a code change. ${DIFF_FORMAT}
${verified ? VERIFIED_STEPS : "Review only the added and changed code."} Report at most ${maxFindings} findings, and only real problems: bugs, wrong logic, unhandled errors or edge cases that matter, security issues, broken contracts. No style nits, no praise, no restating the change. An empty list is a fine answer.
severity "high" = breaks behaviour or security in normal use; "medium" = a likely bug in an edge case; "low" = a minor risk.
Reply with ONLY this JSON object:
{"summary": "<one or two sentences on what the change does>", "effort": <1-5, how hard to review>, "findings": [{"file": "<path>", "line": <new line number>, "severity": "high|medium|low", "title": "<short>", "detail": "<what is wrong and how to fix it>"}], "security": "<a concrete security concern, or null>", "tests": "adequate|missing|n/a"}`;
  return structuredCall({ ...call, system, user: `${prefix}${evidence}${conventions}` }, validateReview(maxFindings));
}

/* ------------------------------- describe -------------------------------- */

const validateDescription: Validator<Description> = (value) => {
  const o = obj(value);
  const title = str(o?.title)?.trim();
  const body = str(o?.body);
  const type = oneOf(o?.type, TYPES);
  if (!title) return { error: "`title` must be a non-empty string" };
  if (body === null) return { error: "`body` must be a string" };
  if (!type) return { error: `\`type\` must be one of ${TYPES.join(", ")}` };
  return { title: title.replace(/\s+/g, " ").slice(0, 120), body: body.trim(), type };
};

export async function describeDiff(input: ToolInput): Promise<Description> {
  const { call, prefix } = await prepare(input);
  const system = `You write pull request descriptions. ${DIFF_FORMAT}
Describe only what the diff actually changes. The title is imperative and at most 72 characters. The body is short Markdown: a one-paragraph summary, then a "Changes" list with one bullet per meaningful change (name files where useful). No headings beyond that, no filler.
Reply with ONLY this JSON object:
{"title": "<title>", "body": "<markdown>", "type": "bug|feature|refactor|docs|test|chore"}`;
  return structuredCall({ ...call, system, user: prefix, maxTokens: 2000 }, validateDescription);
}

/* -------------------------------- improve -------------------------------- */

type Draft = Omit<Suggestion, "score">;

const validateDrafts: Validator<Draft[]> = (value) => {
  const list = obj(value)?.suggestions;
  if (!Array.isArray(list)) return { error: "expected {\"suggestions\": [...]}" };
  const out: Draft[] = [];
  for (const [i, raw] of list.entries()) {
    const s = obj(raw);
    const file = str(s?.file);
    const startLine = int(s?.startLine);
    const endLine = int(s?.endLine) ?? startLine;
    const existing = str(s?.existing);
    const improved = str(s?.improved);
    if (!s || !file || startLine === null || endLine === null || existing === null || improved === null) {
      return { error: `suggestions[${i}] needs file, startLine, endLine, existing and improved` };
    }
    out.push({ file, startLine, endLine: Math.max(startLine, endLine), existing, improved, why: str(s.why) ?? "" });
  }
  return out;
};

const validateScores =
  (count: number): Validator<number[]> =>
  (value) => {
    const list = obj(value)?.scores;
    if (!Array.isArray(list) || list.length !== count) return { error: `expected {"scores": [...]} with exactly ${count} numbers` };
    const scores = list.map((s) => int(obj(s)?.score ?? s));
    if (scores.some((s) => s === null || s < 0 || s > 10)) return { error: "every score must be an integer 0-10" };
    return scores as number[];
  };

const squash = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** True when `existing` is a contiguous run of the file's new-side lines (whitespace-insensitive). */
export function groundedIn(diff: string, file: string, existing: string): boolean {
  const target = parseUnifiedDiff(diff).find((f) => f.path === file);
  const want = squash(existing);
  if (!target || !want.length) return false;
  const have = squash(newSideLines(target).join("\n"));
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (want.every((line, j) => have[i + j] === line)) return true;
  }
  return false;
}

export async function improveDiff(
  input: ToolInput & { threshold?: number; maxSuggestions?: number },
): Promise<Suggestion[]> {
  const threshold = input.threshold ?? 7;
  const { call, prefix } = await prepare(input);
  const system = `You suggest concrete improvements to the added and changed code in a diff. ${DIFF_FORMAT}
Give at most ${input.maxSuggestions ?? 5} suggestions, the most valuable first: bug fixes, error handling, clearer or faster code. Nothing on unchanged code, docs or formatting.
"existing" must be copied exactly from the new-side code (without line numbers or +/- marks); "improved" is its replacement; lines are new-file line numbers.
Reply with ONLY this JSON object:
{"suggestions": [{"file": "<path>", "startLine": <n>, "endLine": <n>, "existing": "<code>", "improved": "<code>", "why": "<one sentence>"}]}`;
  const drafts = (await structuredCall({ ...call, system, user: prefix }, validateDrafts)).filter(
    (d) => squash(d.existing).join("\n") !== squash(d.improved).join("\n") && groundedIn(input.diff, d.file, d.existing),
  );
  if (!drafts.length) return [];

  const reflect = `You grade code suggestions made on a diff. ${DIFF_FORMAT}
For each suggestion, in order, give a score 0-10: 0 when it is wrong, breaks behaviour, or targets code not in the diff; 1-4 for cosmetic or doubtful value; 5-7 for a real but minor improvement; 8-10 for an important fix. Judge by the diff, not by the suggestion's own claims.
Reply with ONLY this JSON object: {"scores": [<n>, ...]} with exactly one score per suggestion.`;
  const listed = drafts
    .map((d, i) => `${i + 1}. ${d.file}:${d.startLine}-${d.endLine}: ${d.why}\nexisting:\n${d.existing}\nimproved:\n${d.improved}`)
    .join("\n\n");
  const scores = await structuredCall(
    { ...call, system: reflect, user: `${prefix}\n\n<suggestions>\n${listed}\n</suggestions>`, maxTokens: 800 },
    validateScores(drafts.length),
  );
  return drafts
    .map((d, i) => ({ ...d, score: scores[i] }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score);
}

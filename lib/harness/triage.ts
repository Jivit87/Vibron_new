/**
 * Zero-token issue sizing (ported from Pramana `agent/orchestrator.py`
 * `triage`). A guess at how big the task looks, used only to decide whether
 * the one-call fast path is worth trying first; the proof gate, not this
 * guess, decides when to stop.
 */

export type IssueSize = "small" | "medium" | "large";

export interface TriageInput {
  /** The rendered issue / task text. */
  text: string;
  /** Issue labels, when known (GitHub). */
  labels?: string[];
  /** Localized source candidates, best first, with their scores. */
  files: { path: string; score: number }[];
  /** Output of running the issue's own code snippet on the original code. */
  snippetOutput?: string;
}

export interface Triage {
  size: IssueSize;
  reasons: string[];
}

const FEATURE_WORDS =
  /\b(feature request|add support|implement|new option|new endpoint|allow users? to|would be nice|enhancement)\b/i;
const SECURITY_WORDS = /\b(xss|injection|csrf|vulnerab)/i;

export function triage(input: TriageInput): Triage {
  const reasons: string[] = [];
  const labels = new Set((input.labels ?? []).map((l) => l.toLowerCase()));
  let score = 0;
  if (["enhancement", "feature", "feature request"].some((l) => labels.has(l)) || FEATURE_WORDS.test(input.text)) {
    score += 2;
    reasons.push("asks for new behaviour");
  }
  if (labels.has("security") || SECURITY_WORDS.test(input.text)) {
    score += 1;
    reasons.push("security fix");
  }
  if (input.text.length > 6000) {
    score += 2;
    reasons.push("long report");
  }
  const top = input.files[0]?.score ?? 0;
  const strong = input.files.slice(0, 8).filter((f) => f.score >= (top ? top * 0.6 : 1));
  if (strong.length >= 4) {
    score += 1;
    reasons.push(`${strong.length} files look involved`);
  }
  if (input.snippetOutput && /Traceback|Error/.test(input.snippetOutput)) {
    score -= 1;
    reasons.push("the issue's own code reproduces the error");
  }
  if (!reasons.length) reasons.push("a focused bug report");
  return { size: score <= 1 ? "small" : score <= 3 ? "medium" : "large", reasons };
}

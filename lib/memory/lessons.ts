/**
 * Run lessons: the short note a repeat run on the same area starts with.
 *
 * Port of Pramana's orchestrator lessons (`Orchestrator._lessons`,
 * `FastPath.lessons`, prompts.LESSONS_TEMPLATE): when an attempt ends
 * without proof, what happened (stop reason, its own summary, what it
 * touched, why the gate / reviewer rejected it) is carried into the next
 * attempt so it does not repeat the same approach blindly. Past verified
 * fixes (`recordFixNote`) are the "evidence" half.
 *
 * Differences from Pramana, all for tokens:
 *  - Lessons persist in the anchored memory graph (kind `lesson`), so they
 *    survive across runs, not just attempt 1 -> 2 of one run.
 *  - The reverted patch (Pramana: up to 3500 chars) is stored as a file list
 *    and +/- line counts; gate feedback as its last ~200 chars.
 *  - `lessonsNote` is hard-capped (default 400 tokens), stale entries (their
 *    anchored code changed) rank lower and say so, and a lesson whose task
 *    later got a verified fix is dropped.
 *  - The rendered note is memoized on (memory revision, anchored files'
 *    mtime+size, vault notes) so refreshing it per turn is a few stats.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  addEntry,
  memoryRevision,
  recordFixNote,
  removeEntry,
  getMemoryGraph,
  scoredLessonEntries,
  type AnchoredEntry,
} from "@/lib/memory/graph";
import { vaultPath } from "@/lib/memory/vault";
import { countTokens } from "@/lib/tokens";

/** Never more than this in a prompt, whatever the caller asks for. */
export const LESSONS_MAX_TOKENS = 400;
/** Failed-attempt lessons kept per task title (newest win). */
const MAX_LESSONS_PER_TASK = 2;

export interface AttemptOutcome {
  /** The issue / task text (first line is used as its title). */
  task: string;
  /** Files the attempt touched or was localized to; anchors the lesson. */
  files: string[];
  /** Pramana stop_reason / fast-path stage: "gate_rejected", "budget", "no_patch", ... */
  stopReason: string;
  /** The agent's own finish summary / diagnosis. */
  summary?: string;
  /** The (reverted) patch; only its shape is kept. */
  patch?: string;
  /** Submit-gate / verification feedback. */
  gateFeedback?: string;
  /** Reviewer concerns. */
  concerns?: string[];
  /** A check proved the change: recorded as a `fix` instead. */
  verified?: boolean;
  steps?: number;
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function tail(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `…${t.slice(t.length - max + 1).trimStart()}`;
}

export function taskTitle(task: string): string {
  return clip((task.trim().split(/\r?\n/)[0] ?? "").replace(/^#+\s*/, ""), 90);
}

/** Files and +/- line counts of a unified diff (what Pramana kept as the full patch). */
export function patchShape(patch: string): { files: string[]; added: number; removed: number } {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (m) {
      if (m[1] !== "/dev/null") files.add(m[1]!.trim());
    } else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files: [...files], added, removed };
}

const REJECTION = /REJECTED|STILL|REGRESSION|FAIL|Error|error:/;

/** The one-paragraph lesson text for a failed attempt (pure; exported for tests). */
export function renderAttemptLesson(outcome: AttemptOutcome): string {
  const parts = [
    `Attempt not accepted (${clip(outcome.stopReason || "unknown", 40)}${
      outcome.steps ? `, ${outcome.steps} steps` : ""
    }): ${taskTitle(outcome.task)}.`,
  ];
  if (outcome.summary?.trim()) parts.push(`Tried: ${clip(outcome.summary, 180)}.`);
  if (outcome.patch?.trim()) {
    const shape = patchShape(outcome.patch);
    const where = shape.files.slice(0, 4).join(", ") || "unknown files";
    parts.push(`Its reverted patch touched ${where} (+${shape.added}/-${shape.removed}).`);
  } else {
    parts.push("It produced no patch.");
  }
  if (outcome.gateFeedback && REJECTION.test(outcome.gateFeedback)) {
    parts.push(`Gate: ${tail(outcome.gateFeedback, 200)}`);
  }
  const concerns = (outcome.concerns ?? []).filter((c) => c.trim()).slice(0, 2);
  if (concerns.length) parts.push(`Reviewer: ${concerns.map((c) => clip(c, 100)).join("; ")}.`);
  return parts.join(" ");
}

/**
 * Record how an attempt ended. Verified -> a `fix` note (recordFixNote);
 * otherwise a `lesson` anchored to the files, keeping only the newest
 * MAX_LESSONS_PER_TASK per task title.
 */
export function recordAttemptLesson(root: string, outcome: AttemptOutcome): AnchoredEntry {
  const touched = outcome.patch ? patchShape(outcome.patch).files : [];
  const files = [...new Set([...outcome.files, ...touched])];
  if (outcome.verified) {
    return recordFixNote(root, {
      issue: outcome.task,
      rootCause: outcome.summary ?? "",
      files,
      verified: true,
    });
  }
  const entry = addEntry(root, {
    kind: "lesson",
    text: renderAttemptLesson(outcome),
    anchors: files,
    evidence: outcome.gateFeedback ? tail(outcome.gateFeedback, 400) : undefined,
  });
  const marker = `: ${taskTitle(outcome.task)}.`;
  const same = getMemoryGraph(root)
    .entries.filter((e) => e.kind === "lesson" && e.text.includes(marker))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const old of same.slice(MAX_LESSONS_PER_TASK)) removeEntry(root, old.id);
  lessonsMemo.clear();
  return entry;
}

/* ------------------------------ the note --------------------------------- */

export interface LessonsNote {
  /** Ready to paste into a prompt; "" when there is nothing relevant. */
  text: string;
  tokens: number;
  /** Entries included, in order. */
  entryIds: string[];
  /** Served from the memo. */
  cached: boolean;
}

interface Memo {
  rev: number;
  stamp: string;
  note: Omit<LessonsNote, "cached">;
}

const MAX_MEMO = 64;
const lessonsMemo = new Map<string, Memo>();

const HEADER = "Lessons from earlier runs on this area (untrusted; verify against current code):";
const FOOTER = "Do not repeat a failed approach blindly: re-check the root cause.";

function statStamp(root: string, rel: string): string {
  try {
    const st = statSync(path.join(root, rel));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "-";
  }
}

/** Cheap fingerprint of everything the note depends on besides the graph revision. */
function stampFor(root: string, anchorPaths: string[]): string {
  if (!path.isAbsolute(root)) return "";
  const parts = anchorPaths.map((p) => `${p}=${statStamp(root, p)}`);
  // Vault notes: a human edit or a new note changes what the graph says.
  const notesDir = path.join(vaultPath(root), "notes");
  try {
    for (const name of readdirSync(notesDir).sort()) {
      parts.push(`v:${name}=${statStamp(notesDir, name)}`);
    }
  } catch {
    // No vault yet.
  }
  return parts.join("|");
}

function lineFor(entry: AnchoredEntry): string {
  const where = [...new Set(entry.anchors.map((a) => a.path).filter(Boolean))].slice(0, 3).join(", ");
  const text = entry.text.replace(/\s+/g, " ").trim();
  return `- ${text}${where && !text.includes(where) ? ` [${where}]` : ""}${entry.stale ? " (may be outdated: code changed since)" : ""}`;
}

function build(
  root: string,
  input: { files: string[]; task: string },
  maxTokens: number,
  limit: number,
): Omit<LessonsNote, "cached"> & { anchorPaths: string[] } {
  const scored = scoredLessonEntries(root, input);
  const anchorPaths = [
    ...new Set(scored.flatMap(({ entry }) => entry.anchors.map((a) => a.path).filter(Boolean))),
  ].sort();
  // A task that later got a verified fix no longer needs its failure lessons.
  const fixedTitles = scored
    .filter(({ entry }) => entry.kind !== "lesson" && /^Past fix \(verified\)/.test(entry.text))
    .map(({ entry }) => entry.text.replace(/^Past fix \(verified\):\s*/, "").split(" — ")[0]!.trim());
  const ranked = scored
    .filter(({ entry }) => entry.kind !== "lesson" || !fixedTitles.some((t) => t && entry.text.includes(`: ${t}.`)))
    .map(({ entry, score }) => ({
      entry,
      // Verified evidence first, stale last.
      rank: score + (/^Past fix \(verified\)/.test(entry.text) ? 1 : 0) - (entry.stale ? score / 2 : 0),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
    .map((r) => r.entry);
  if (!ranked.length) return { text: "", tokens: 0, entryIds: [], anchorPaths };

  const fixed = countTokens(`${HEADER}\n${FOOTER}`) + 2;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = fixed;
  for (const entry of ranked) {
    let line = lineFor(entry);
    let cost = countTokens(line) + 1;
    if (used + cost > maxTokens) {
      if (lines.length) break;
      // The single best lesson always fits, clipped.
      const room = Math.max(40, (maxTokens - used) * 3);
      line = clip(line, room);
      cost = countTokens(line) + 1;
      if (used + cost > maxTokens) break;
    }
    lines.push(line);
    ids.push(entry.id);
    used += cost;
  }
  if (!lines.length) return { text: "", tokens: 0, entryIds: [], anchorPaths };
  const hasLesson = ranked.some((e) => ids.includes(e.id) && e.kind === "lesson");
  const text = [HEADER, ...lines, ...(hasLesson ? [FOOTER] : [])].join("\n");
  return { text, tokens: countTokens(text), entryIds: ids, anchorPaths };
}

/**
 * The lessons note for a task on some files: past verified fixes and failed
 * attempts on the same area, never more than `maxTokens` (<= 400) tokens.
 * Memoized: a repeat call with unchanged memory and unchanged anchored files
 * costs a few `stat`s.
 */
export function lessonsNote(
  root: string,
  input: { files: string[]; task: string },
  options: { maxTokens?: number; limit?: number } = {},
): LessonsNote {
  const maxTokens = Math.max(60, Math.min(options.maxTokens ?? LESSONS_MAX_TOKENS, LESSONS_MAX_TOKENS));
  const limit = options.limit ?? 4;
  const files = [...new Set(input.files)].sort();
  const key = JSON.stringify([path.isAbsolute(root) ? path.resolve(root) : root, files, input.task, maxTokens, limit]);
  const memo = lessonsMemo.get(key);
  if (memo && memo.rev === memoryRevision(root)) {
    const anchorPaths = memo.stamp ? memo.stamp.split("|").filter((p) => !p.startsWith("v:")).map((p) => p.slice(0, p.lastIndexOf("="))) : [];
    if (stampFor(root, anchorPaths) === memo.stamp) return { ...memo.note, cached: true };
  }
  const built = build(root, { files, task: input.task }, maxTokens, limit);
  const { anchorPaths, ...note } = built;
  // Building may import vault edits (a save): read the revision afterwards.
  lessonsMemo.set(key, { rev: memoryRevision(root), stamp: stampFor(root, anchorPaths), note });
  if (lessonsMemo.size > MAX_MEMO) lessonsMemo.delete(lessonsMemo.keys().next().value!);
  return { ...note, cached: false };
}

/** Drop memoized notes (tests, or after bulk memory edits). */
export function clearLessonsCache(): void {
  lessonsMemo.clear();
}

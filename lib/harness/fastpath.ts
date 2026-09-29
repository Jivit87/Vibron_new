/**
 * Fast path: solve an easy issue in ONE model call, then prove it the same
 * way the agent is proven (ported from Pramana `agent/fastpath.py`).
 *
 * The model gets the issue, the likely files in full (within a budget), the
 * project overview, the output of the issue's own snippet and an example test
 * from the project. It answers once with SEARCH/REPLACE edits plus a small
 * test that must FAIL on the current code. The harness applies the edits with
 * the same tolerant editor the agent uses, then the submit gate runs that test
 * and the related existing tests on the original and on the patched code.
 * Proven (fail -> pass, nothing regressed): done, one call. Otherwise one
 * more round carries the exact rejection reason, and anything still unproven
 * goes to the agent loop, told what the quick attempt tried and why it was
 * not accepted.
 */

import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import type { EventSink } from "@/lib/agents/events";
import { runTurn, type EnrichedTurnResult } from "@/lib/ai";
import type { AiMessage, AiTurnRequest } from "@/lib/ai/types";
import { isTestPath, renderChecks, type Gate, type GateResult } from "@/lib/harness/gate";
import { changedFiles, diff, restore, SCRATCH_DIR } from "@/lib/harness/snapshot";
import { strReplace } from "@/lib/tools/editor";

/* ------------------------------- prompt ---------------------------------- */

export const FAST_SYSTEM = "You are an expert software engineer. Answer in the exact format requested.";

function fastPrompt(p: {
  root: string;
  issue: string;
  overview: string;
  errorBlock: string;
  files: string;
  exampleTest: string;
  testCommand: string;
  ext: string;
  examplePath: string;
}): string {
  return `You are fixing a GitHub issue in the repository at ${p.root}. You get ONE reply: no tools, no follow-up questions.

<issue>
${p.issue}
</issue>

<repository_overview>
${p.overview}
</repository_overview>
${p.errorBlock}
<files>
${p.files}
</files>
${p.exampleTest}
The project's tests run with: ${p.testCommand}

Reply in exactly this format, starting directly with "DIAGNOSIS:" (no preamble, no thinking out loud).

DIAGNOSIS: <one or two sentences: the root cause>

Then every source edit, each as (the file path alone on the line above the block, e.g. ${p.examplePath}):
${p.examplePath}
<<<<<<< SEARCH
exact lines copied from the file above (enough lines to be unique)
=======
the replacement lines
>>>>>>> REPLACE

Then ONE new test file that FAILS on the current code and PASSES after your edits. Use the project's own test
framework and imports, and test the behaviour the issue describes (including sibling cases of the same bug):
${SCRATCH_DIR}/test_issue${p.ext}
<<<<<<< SEARCH
=======
<the whole test file>
>>>>>>> REPLACE

TEST_COMMAND: <the one command that runs just that test>

Rules: fix the root cause in the source code; never edit existing tests; keep the change as small as the issue
allows; if the same bug appears in several places, include every edit.
`;
}

export const FINISH_NOW =
  "You ran out of space while thinking. Stop analysing now. Reply with ONLY the final answer in the exact format: DIAGNOSIS:, then each edit (file path line, SEARCH text copied exactly from the files you were shown, REPLACE), then the test file, then TEST_COMMAND. No explanation.";

/* --------------------------- difflib (port) ------------------------------ */

type Block = [number, number, number];
type Opcode = ["replace" | "delete" | "insert" | "equal", number, number, number, number];

/** Python's `difflib.SequenceMatcher` with autojunk off, over strings or string arrays. */
export class SequenceMatcher<T extends string> {
  private b2j = new Map<T, number[]>();
  private blocks: Block[] | null = null;

  constructor(
    private readonly a: ArrayLike<T>,
    private readonly b: ArrayLike<T>,
  ) {
    for (let j = 0; j < b.length; j += 1) {
      const list = this.b2j.get(b[j]);
      if (list) list.push(j);
      else this.b2j.set(b[j], [j]);
    }
  }

  private longest(alo: number, ahi: number, blo: number, bhi: number): Block {
    let [besti, bestj, bestsize] = [alo, blo, 0];
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i += 1) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(this.a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) [besti, bestj, bestsize] = [i - k + 1, j - k + 1, k];
      }
      j2len = next;
    }
    return [besti, bestj, bestsize];
  }

  matchingBlocks(): Block[] {
    if (this.blocks) return this.blocks;
    const queue: [number, number, number, number][] = [[0, this.a.length, 0, this.b.length]];
    const found: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const [i, j, k] = this.longest(alo, ahi, blo, bhi);
      if (k) {
        found.push([i, j, k]);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    found.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    const merged: Block[] = [];
    let [i1, j1, k1] = [0, 0, 0];
    for (const [i2, j2, k2] of found) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) merged.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) merged.push([i1, j1, k1]);
    merged.push([this.a.length, this.b.length, 0]);
    this.blocks = merged;
    return merged;
  }

  opcodes(): Opcode[] {
    let [i, j] = [0, 0];
    const out: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      const tag = i < ai && j < bj ? "replace" : i < ai ? "delete" : j < bj ? "insert" : null;
      if (tag) out.push([tag, i, ai, j, bj]);
      [i, j] = [ai + size, bj + size];
      if (size) out.push(["equal", ai, i, bj, j]);
    }
    return out;
  }

  ratio(): number {
    const matches = this.matchingBlocks().reduce((n, [, , k]) => n + k, 0);
    const total = this.a.length + this.b.length;
    return total ? (2 * matches) / total : 1;
  }

  quickRatio(): number {
    const avail = new Map<T, number>();
    for (let j = 0; j < this.b.length; j += 1) avail.set(this.b[j], (avail.get(this.b[j]) ?? 0) + 1);
    let matches = 0;
    for (let i = 0; i < this.a.length; i += 1) {
      const n = avail.get(this.a[i]) ?? 0;
      if (n > 0) matches += 1;
      avail.set(this.a[i], n - 1);
    }
    const total = this.a.length + this.b.length;
    return total ? (2 * matches) / total : 1;
  }

  realQuickRatio(): number {
    const total = this.a.length + this.b.length;
    return total ? (2 * Math.min(this.a.length, this.b.length)) / total : 1;
  }
}

/** `str.splitlines(keepends=True)` for `\n` text. */
function linesKeep(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/**
 * Apply a SEARCH/REPLACE whose SEARCH is a slightly misremembered copy of the
 * file (measured on real repos: 5 of 13 edits were 82-95% similar to the real
 * code). Only when one region is >= minRatio similar AND every line the edit
 * changes matches the file exactly: the real text is kept for the
 * misremembered context lines. Returns [newText, firstLine] or null. The proof
 * still has to pass afterwards.
 */
export function nearMissApply(text: string, search: string, replace: string, minRatio = 0.9): [string, number] | null {
  const lines = linesKeep(text);
  const sLines = search.split("\n");
  const rLines = replace === "" ? [] : replace.split("\n");
  const n = sLines.length;
  if (n < 2 || lines.length > 8000) return null;
  const norm = sLines.map((l) => l.trim());
  const real = lines.map((l) => l.trim());
  const target = norm.join("\n");
  const scored: [number, number, number][] = [];
  const sizes = [...new Set([-2, -1, 0, 1, 2].map((d) => Math.max(1, n + d)))].sort((x, y) => x - y);
  for (const size of sizes) {
    for (let st = 0; st <= lines.length - size; st += 1) {
      const sm = new SequenceMatcher(target, real.slice(st, st + size).join("\n")); // character level
      if (sm.realQuickRatio() >= minRatio && sm.quickRatio() >= minRatio) {
        const r = sm.ratio();
        if (r >= minRatio) scored.push([r, st, size]);
      }
    }
  }
  if (!scored.length) return null;
  scored.sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2]);
  const [, st, size] = scored[0];
  // A second, separate region matches as well: ambiguous.
  if (scored.slice(1).some(([, st2, size2]) => st2 + size2 <= st || st2 >= st + size)) return null;
  const window = real.slice(st, st + size);
  const exact = new Map<number, number>(); // SEARCH line index -> file line index, exact matches only
  for (const [a, b, k] of new SequenceMatcher(norm, window).matchingBlocks()) {
    for (let t = 0; t < k; t += 1) exact.set(a + t, st + b + t);
  }
  const edits = new SequenceMatcher(sLines, rLines).opcodes().filter((op) => op[0] !== "equal");
  if (!edits.length) return null;
  const out = [...lines];
  for (const [tag, i1, i2, j1, j2] of [...edits].reverse()) {
    const fresh = rLines.slice(j1, j2).map((l) => `${l}\n`);
    if (tag === "insert") {
      let at: number;
      if (exact.has(i1)) at = exact.get(i1)!;
      else if (exact.has(i1 - 1)) at = exact.get(i1 - 1)! + 1;
      else return null;
      out.splice(at, 0, ...fresh);
      continue;
    }
    const idx: (number | undefined)[] = [];
    for (let i = i1; i < i2; i += 1) idx.push(exact.get(i));
    if (idx.some((x) => x === undefined) || idx.some((x, k) => x !== idx[0]! + k)) return null; // changed lines misremembered
    out.splice(idx[0]!, idx.length, ...fresh);
  }
  return [out.join(""), st + 1];
}

/* ------------------------------- parsing --------------------------------- */

export interface FastEdit {
  path: string;
  search: string;
  replace: string;
}

const BLOCK_RE = /<<<<<<< SEARCH\n([\s\S]*?)\n?=======\n([\s\S]*?)\n?>>>>>>> REPLACE/g;
const PATHISH = /^[\w@.+-][\w@.+/-]*\.[A-Za-z0-9]{1,8}$|^[\w@.+-]+(?:\/[\w@.+-]+)+$/;

/** The file path written above an edit block, tolerating blank lines, markdown and labels. */
function pathAbove(before: string): string {
  for (const line of before.split("\n").slice(-6).reverse()) {
    const raw = line.trim();
    if (!raw || raw.startsWith("```")) continue;
    let cand = raw.replace(/^(?:#+\s*|[-*]\s+|\d+[.)]\s+)/, "");
    cand = cand.replace(/^[*_` ]+|[*_` ]+$/g, "");
    cand = cand.replace(/^(?:file(?:name)?|path)\s*[:=]\s*/i, "").replace(/^[*_` ]+|[*_` ]+$/g, "");
    cand = cand.replace(/:+$/, "").replace(/^[*_` ]+|[*_` ]+$/g, "");
    if (cand.startsWith("./")) cand = cand.slice(2);
    if (PATHISH.test(cand)) return cand;
    if (raw.split(/\s+/).length > 3) return ""; // a sentence: the path is not above this block
  }
  return "";
}

export function parseReply(reply: string): { diagnosis: string; edits: FastEdit[]; testCommand: string } {
  const text = (reply ?? "").replace(/```[\w+-]*\n?/g, "");
  const m = /DIAGNOSIS:\s*([\s\S]+?)(?:\n\s*\n|\n(?=\S+\n<<<<<<<))/.exec(text);
  const diagnosis = m ? m[1].split(/\s+/).filter(Boolean).join(" ") : "";
  const edits: FastEdit[] = [];
  for (const bm of text.matchAll(BLOCK_RE)) {
    edits.push({ path: pathAbove(text.slice(0, bm.index)), search: bm[1], replace: bm[2] });
  }
  const mc = /TEST_COMMAND:\s*`?([^\n`]+)`?/.exec(text);
  return { diagnosis, edits, testCommand: mc ? mc[1].trim() : "" };
}

/* ------------------------------ the result ------------------------------- */

export type FastStage = "" | "no-reply" | "parse" | "apply" | "proof" | "accepted";

export interface FastResult {
  ok: boolean;
  stage: FastStage;
  reason: string;
  diagnosis: string;
  patch: string;
  testPath: string;
  testCommand: string;
  verification: GateResult | null;
  edits: FastEdit[];
  calls: number;
  elapsedMs: number;
}

/** What the agent loop is told when the fast path is not enough. */
export function fastLessons(res: FastResult): string {
  const out = [`- A one-shot attempt (${res.stage}) was not accepted: ${res.reason}`];
  if (res.diagnosis) out.push(`- Its diagnosis: ${res.diagnosis.slice(0, 600)}`);
  if (res.patch.trim()) {
    const p = res.patch.length < 3500 ? res.patch : `${res.patch.slice(0, 3500)}\n[... truncated ...]`;
    out.push(`- Its patch (now reverted):\n\`\`\`diff\n${p}\n\`\`\``);
  }
  if (res.verification) out.push(`- Proof result:\n${renderChecks(res.verification.checks)}`);
  return out.join("\n");
}

/* ---------------------------- source change ------------------------------ */

const CODE_EXT = /\.(py|pyi|pyx|js|jsx|mjs|cjs|ts|tsx|mts|cts|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|vue|svelte|ex|exs|clj|lua|dart|m|mm|sh|pl|r|jl|hs|ml|fs|zig|nim|sql)$/i;
const NON_SOURCE = /(^|\/)(\.github|\.circleci|\.gitlab|docs?|\.vscode|\.idea)(\/|$)|(^|\/)(Dockerfile|Makefile|\.gitlab-ci\.yml|\.travis\.yml)$/i;

/** A file whose change a behavioural test can prove: source code, not docs, config or CI. */
export function isSourceFile(p: string): boolean {
  return CODE_EXT.test(p) && !NON_SOURCE.test(p) && !p.startsWith(`${SCRATCH_DIR}/`);
}

/**
 * Whether a patch changes behaviour-bearing code (Pramana `touches_code`):
 * at least one source file that is not a test. A docs-, config-, CI- or
 * test-only patch can make checks pass without fixing anything, so it is
 * never reported as verified.
 */
export function touchesCode(files: string[]): boolean {
  return files.some((f) => isSourceFile(f) && !isTestPath(f));
}

/* ------------------------------- the run --------------------------------- */

export interface FastPathOptions {
  root: string;
  baseRef: string;
  task: string;
  model: string;
  overview: string;
  /** Localized source files, best first. */
  sources: string[];
  /** Existing tests near the code (the first readable one is the example). */
  tests: string[];
  testCommand: string | null;
  /** The issue's own snippet, run on the original code. */
  snippet?: string;
  /** Every tracked file (to resolve an edit's wrong path from its SEARCH text). */
  allFiles: () => Promise<string[]>;
  gate: Gate;
  emit: EventSink;
  agentId: string;
  signal?: AbortSignal;
  /** Every model turn, for the run's usage and cost. */
  onTurn?: (turn: EnrichedTurnResult) => void;
  /** Test seam. */
  runTurn?: (request: AiTurnRequest) => Promise<EnrichedTurnResult>;
}

function block(p: string, text: string, limit: number): string {
  const body = text.length <= limit ? text : `${text.slice(0, limit)}\n[... ${text.length - limit} more characters not shown ...]`;
  return `<file path="${p}">\n${body}\n</file>`;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Only the localized files, within a small budget (~6k tokens): the fast path must stay cheap. */
export async function gatherFiles(root: string, candidates: string[], budget = 24_000, perFile = 12_000): Promise<string> {
  const parts: string[] = [];
  let used = 0;
  for (const rel of candidates) {
    const text = await readText(path.join(root, rel));
    if (text === null) continue;
    const chunk = block(rel, text, Math.min(perFile, Math.max(2000, budget - used)));
    if (used + chunk.length > budget && parts.length) break;
    parts.push(chunk);
    used += chunk.length;
  }
  return parts.join("\n");
}

const text = (t: string): AiMessage["content"] => [{ type: "text", text: t }];
const BAD = new Set(["regression", "still_failing", "fails_after", "timeout", "fails_both"]);

export async function runFastPath(o: FastPathOptions): Promise<FastResult> {
  const started = Date.now();
  const res: FastResult = {
    ok: false,
    stage: "",
    reason: "",
    diagnosis: "",
    patch: "",
    testPath: "",
    testCommand: "",
    verification: null,
    edits: [],
    calls: 0,
    elapsedMs: 0,
  };
  const note = (msg: string) => o.emit({ type: "agent_text", agentId: o.agentId, text: `\n[harness] ${msg}\n` });
  note("fast path: one call with the likely files, then prove it");

  let example = "";
  let ext = o.sources[0]?.endsWith(".py") ? ".py" : ".js";
  for (const rel of o.tests.slice(0, 3)) {
    const t = await readText(path.join(o.root, rel));
    if (t !== null) {
      example = `<example_test path="${rel}">\n${t.slice(0, 3500)}\n</example_test>\n`;
      ext = path.extname(rel) || ext;
      break;
    }
  }
  if (![".py", ".js", ".ts", ".mjs", ".cjs", ".go", ".rs", ".rb", ".java"].includes(ext)) ext = ".py";
  const prompt = fastPrompt({
    root: o.root,
    issue: o.task.slice(0, 14_000),
    overview: o.overview.slice(0, 5000),
    errorBlock: o.snippet
      ? `\n<what_happens_when_the_issue_code_runs>\n${o.snippet.slice(0, 4000)}\n</what_happens_when_the_issue_code_runs>\n`
      : "",
    files: await gatherFiles(o.root, o.sources),
    exampleTest: example,
    testCommand: o.testCommand ?? "(unknown)",
    ext,
    // A real path: weak models copy placeholders verbatim.
    examplePath: o.sources[0] ?? `src/module${ext}`,
  });
  const call = o.runTurn ?? ((req: AiTurnRequest) => runTurn(req));
  const ask = async (messages: AiMessage[]): Promise<{ text: string; cut: boolean } | null> => {
    try {
      const turn = await call({
        model: o.model,
        system: [{ text: FAST_SYSTEM }],
        messages,
        maxTokens: 8000,
        effort: "medium",
        signal: o.signal,
      });
      res.calls += 1;
      o.onTurn?.(turn);
      return { text: turn.text ?? "", cut: turn.stopReason === "max_tokens" };
    } catch (error) {
      if (o.signal?.aborted) throw error;
      res.stage = "no-reply";
      res.reason = (error instanceof Error ? error.message : String(error)).slice(0, 160);
      return null;
    }
  };

  let messages: AiMessage[] = [{ role: "user", content: text(prompt) }];
  for (const round of [1, 2]) {
    let answer = await ask(messages);
    if (!answer) return done(res, started, note);
    if (!answer.text.includes("<<<<<<< SEARCH") && (answer.cut || answer.text.length > 12_000)) {
      // Measured on real repos: a model that reasons in its answer ran out of
      // room before any edit. Its reasoning is kept; one short call turns it into the answer.
      await keep(o.root, answer.text, round * 10);
      note("fast path: the reply ran out of room while reasoning; asking for the final answer");
      const finished = await ask([
        ...messages,
        { role: "assistant", content: text(answer.text) },
        { role: "user", content: text(FINISH_NOW) },
      ]);
      if (!finished) return done(res, started, note);
      answer = finished;
    }
    await keep(o.root, answer.text, round);
    const feedback = await attempt(o, answer.text, res, note);
    if (res.ok || round === 2 || !feedback) return done(res, started, note);
    note(`fast path round 2 (${res.stage}): ${res.reason.slice(0, 140)}`);
    messages = [...messages, { role: "assistant", content: text(answer.text) }, { role: "user", content: text(feedback) }];
    res.stage = "";
    res.reason = "";
    res.testPath = "";
  }
  return done(res, started, note);
}

function done(res: FastResult, started: number, note: (m: string) => void): FastResult {
  res.elapsedMs = Date.now() - started;
  note(
    `fast path ${res.ok ? "accepted" : "not accepted"} (${res.stage || "?"}): ${res.reason} · ${res.calls} call${res.calls === 1 ? "" : "s"}`,
  );
  return res;
}

/** The full reply goes into the run's scratch folder (kept with the evidence). */
async function keep(root: string, reply: string, round: number): Promise<void> {
  try {
    const dir = path.join(root, SCRATCH_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `fastpath_reply_${round}.txt`), reply);
  } catch {
    // Evidence only.
  }
}

/** No usable path given: the SEARCH text is copied from a file, so find the file that contains it. */
async function resolvePath(o: FastPathOptions, search: string): Promise<string> {
  const body = search.trim();
  if (!body) return "";
  const first = body.split("\n")[0].trim();
  const files = (await o.allFiles().catch((): string[] => [])).slice(0, 5000);
  for (const rel of files) {
    const abs = path.join(o.root, rel);
    const info = await stat(abs).catch(() => null);
    if (!info?.isFile() || info.size > 500_000) continue;
    const t = await readText(abs);
    if (t !== null && t.includes(first) && (t.includes(body) || body.split("\n").length === 1)) return rel;
  }
  return "";
}

async function contains(root: string, rel: string, search: string): Promise<boolean> {
  const t = await readText(path.join(root, rel));
  return t !== null && t.includes(search.trim());
}

async function applyEdit(root: string, rel: string, search: string, replace: string, note: (m: string) => void): Promise<void> {
  const abs = path.join(root, rel);
  if (!search.trim()) {
    const exists = await stat(abs).then(() => true, () => false);
    if (exists && !rel.startsWith(`${SCRATCH_DIR}/`)) throw new Error(`${rel} already exists; an empty SEARCH only creates new files`);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, replace.endsWith("\n") ? replace : `${replace}\n`);
    return;
  }
  const content = await readText(abs);
  if (content === null) throw new Error(`file not found: ${rel}`);
  const out = strReplace(content, search, replace, { path: rel });
  if (out.ok) {
    await writeFile(abs, out.after);
    return;
  }
  const near = nearMissApply(content, search, replace);
  if (!near) throw new Error((out as { error: string }).error);
  await writeFile(abs, near[0]);
  note(`edit to ${rel}: SEARCH text was a near miss; applied to the matching region at line ${near[1]} (real text kept)`);
}

/** Apply and prove one reply. "" when accepted (or not worth a retry), else the feedback for round 2. */
async function attempt(o: FastPathOptions, reply: string, res: FastResult, note: (m: string) => void): Promise<string> {
  const parsed = parseReply(reply);
  res.diagnosis = parsed.diagnosis;
  res.testCommand = parsed.testCommand;
  if (!parsed.edits.length) {
    res.stage = "parse";
    res.reason = "the reply contained no SEARCH/REPLACE edits";
    res.edits = [];
    return "Your reply contained no edits in the required format. Reply again: DIAGNOSIS:, then each edit as a file path line directly followed by a <<<<<<< SEARCH / ======= / >>>>>>> REPLACE block, then TEST_COMMAND:.";
  }
  const fixed: FastEdit[] = [];
  for (const e of parsed.edits) {
    let p = e.path;
    if (p && e.search.trim() && !(await contains(o.root, p, e.search))) {
      p = (await resolvePath(o, e.search)) || p; // wrong or invented path, but the text exists elsewhere
    }
    if (!p) {
      p = e.search.trim() ? await resolvePath(o, e.search) : "";
      if (!p && !e.search.trim()) p = `${SCRATCH_DIR}/test_issue${o.sources[0]?.endsWith(".py") ? ".py" : ".js"}`;
    }
    fixed.push({ path: p, search: e.search, replace: e.replace });
  }
  // Measured on real repos: 5 of 13 replies repeated an edit verbatim; the copy failed and sank the whole answer.
  const same = (a: FastEdit, b: FastEdit) => a.path === b.path && a.search === b.search && a.replace === b.replace;
  res.edits = fixed.filter((e, i) => !fixed.slice(0, i).some((f) => same(e, f)));
  for (const e of res.edits) {
    try {
      if (!e.path) throw new Error("no file path was given for this edit and its SEARCH text is not in any file");
      await applyEdit(o.root, e.path, e.search, e.replace, note);
      if (!e.search.trim() && e.path.startsWith(`${SCRATCH_DIR}/`) && !res.testPath) res.testPath = e.path;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      res.stage = "apply";
      res.reason = `edit to ${e.path || "(no path)"} could not be applied: ${msg.slice(0, 200)}`;
      res.patch = await diff(o.root, o.baseRef).catch(() => "");
      await restore(o.root, o.baseRef);
      return `This edit could not be applied to ${e.path || "(no path given)"}:\n${msg.slice(0, 1500)}\n\nNothing was changed. Reply again with ALL edits (SEARCH text copied exactly from the current file, the file path on the line directly above each block), the test file, and TEST_COMMAND.`;
    }
  }
  res.patch = await diff(o.root, o.baseRef).catch(() => "");
  const changed = (await changedFiles(o.root, o.baseRef).catch(() => [])).map((c) => c.path);
  // An empty patch, or one that only touches docs/config/CI, is never verified:
  // a test that reads back a file the model just wrote proves nothing about behaviour.
  if (!changed.some(isSourceFile)) {
    res.stage = "proof";
    res.reason = changed.length
      ? `only docs/config/CI files changed (${changed.slice(0, 4).join(", ")}): no behavioural proof is possible`
      : "the patch changes no source file";
    await restore(o.root, o.baseRef);
    return changed.length ? "" : "Your reply changed no source file. Reply again with the source edits that fix the issue, the test and TEST_COMMAND.";
  }
  let command = res.testCommand;
  if (!command && res.testPath) command = res.testPath.endsWith(".py") ? `python -m pytest -q ${res.testPath}` : `node ${res.testPath}`;
  const v = await o.gate.verify({ summary: res.diagnosis || "fast path", reproduction: command || undefined }, { dry: true });
  res.verification = v;
  o.gate.emitResult(v);
  const bad = v.checks.filter((c) => BAD.has(c.verdict));
  if (v.strength === "strong" && !bad.length) {
    await o.gate.trackBest(v);
    res.ok = true;
    res.stage = "accepted";
    res.reason = "proven";
    return "";
  }
  const noFail = v.checks.some((c) => c.verdict === "passes_both") && !v.checks.some((c) => c.verdict === "fixes");
  res.stage = "proof";
  res.reason = noFail
    ? "its test did not fail on the original code, so nothing proves the fix"
    : (v.feedback || "the checks did not pass").slice(0, 600);
  await restore(o.root, o.baseRef);
  if (noFail) {
    return "Your test PASSED on the original, unfixed code, so it does not show the bug. The edits were reverted. Write a test that FAILS on the current code for exactly the reason in the issue (check the concrete behaviour the issue describes), then give the source edits, the test and TEST_COMMAND again.";
  }
  const broken = v.checks.filter((c) => (c.verdict === "still_failing" || c.verdict === "fails_both") && c.origin !== "related-tests");
  if (broken.length && !v.checks.some((c) => c.verdict === "fixes")) {
    // Measured: a model re-sent the same broken test when this was buried under the output table.
    return `Your test FAILS EVEN WITH YOUR FIX, so the TEST ITSELF is most likely broken: it errors before it reaches the behaviour. First error: ${broken[0].after?.summary ?? ""}\nCopy how the project's own tests set things up (their imports, fixtures, helpers that start servers or build objects) and write the test the same way. The edits were reverted: reply again with the source edits, the corrected test and TEST_COMMAND.\n\nFull output:\n${(v.feedback || "").slice(-2500)}`;
  }
  return `Your change was run on the original and on the patched code and was not accepted:\n${(v.feedback || "").slice(-2500)}\n\nThe edits were reverted. Reply again with corrected edits, the test and TEST_COMMAND.`;
}

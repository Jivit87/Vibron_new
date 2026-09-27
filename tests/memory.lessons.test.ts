import { mkdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearLessonsCache,
  clearMemoryGraphCache,
  getMemoryGraph,
  lessonsNote,
  LESSONS_MAX_TOKENS,
  patchShape,
  recordAttemptLesson,
  recordFixNote,
} from "@/lib/memory";
import { countTokens } from "@/lib/tokens";

const PATCH = [
  "--- a/src/slug.ts",
  "+++ b/src/slug.ts",
  "@@ -1,3 +1,3 @@",
  ...Array.from(
    { length: 60 },
    (_, i) => `-  const old${i} = legacySlug(input, ${i});\n+  const next${i} = slugify(input, ${i});`,
  ),
].join("\n");
const FEEDBACK = `${"noise line from the test runner\n".repeat(40)}REJECTED: tests/slug.test.ts still fails: expected "a-b" got "a_b"`;

async function repo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-lessons-"));
  mkdirSync(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/slug.ts"), "export const slug = (s: string) => s.toLowerCase();\n");
  await writeFile(path.join(root, "src/other.ts"), "export const x = 1;\n");
  return root;
}

/** What Pramana's Orchestrator._lessons would put in the prompt for the same attempt. */
function pramanaLessons(): string {
  return [
    "- It stopped because: gate_rejected after 14 steps.",
    "- Its own summary: Replaced legacySlug with slugify in the slug helper.",
    `- Its patch (now reverted):\n\`\`\`diff\n${PATCH.slice(0, 3500)}\n[... truncated ...]\n\`\`\``,
    `- Gate feedback: ${FEEDBACK.slice(-1500)}`,
  ].join("\n");
}

describe("run lessons", () => {
  beforeEach(() => {
    clearMemoryGraphCache();
    clearLessonsCache();
  });

  it("patchShape counts files and lines", () => {
    expect(patchShape(PATCH)).toEqual({ files: ["src/slug.ts"], added: 60, removed: 60 });
  });

  it("a repeat run on the same area starts with a short, capped lessons note", async () => {
    const root = await repo();
    recordAttemptLesson(root, {
      task: "Slugs use underscores instead of dashes\nmore detail",
      files: [],
      stopReason: "gate_rejected",
      steps: 14,
      summary: "Replaced legacySlug with slugify in the slug helper.",
      patch: PATCH,
      gateFeedback: FEEDBACK,
      concerns: ["does not handle unicode"],
    });
    const note = lessonsNote(root, { files: ["src/slug.ts"], task: "Slugs use underscores instead of dashes" });
    expect(note.text).toContain("Attempt not accepted (gate_rejected, 14 steps)");
    expect(note.text).toContain("+60/-60");
    expect(note.text).toContain("REJECTED: tests/slug.test.ts still fails");
    expect(note.text).toContain("Do not repeat");
    expect(note.tokens).toBeLessThanOrEqual(LESSONS_MAX_TOKENS);
    const before = countTokens(pramanaLessons());
    console.log(`[lessons] pramana-style=${before} tokens, note=${note.tokens} tokens`);
    expect(note.tokens * 5).toBeLessThan(before);
    expect(lessonsNote(root, { files: ["lib/zzz.ts"], task: "dark mode toggle" }).text).toBe("");
  });

  it("is memoized, and goes stale when the anchored code changes", async () => {
    const root = await repo();
    recordAttemptLesson(root, { task: "Slug bug", files: ["src/slug.ts"], stopReason: "budget" });
    const input = { files: ["src/slug.ts"], task: "Slug bug" };
    const a = lessonsNote(root, input);
    expect(a.cached).toBe(false);
    let t = performance.now();
    const b = lessonsNote(root, input);
    const hitMs = performance.now() - t;
    expect(b.cached).toBe(true);
    expect(b.text).toBe(a.text);
    clearLessonsCache();
    t = performance.now();
    lessonsNote(root, input);
    const missMs = performance.now() - t;
    console.log(`[lessons] memo hit=${hitMs.toFixed(3)}ms miss=${missMs.toFixed(3)}ms`);

    await new Promise((r) => setTimeout(r, 15));
    await writeFile(path.join(root, "src/slug.ts"), "export const slug = (s: string) => s.replace(/_/g, '-');\n");
    const c = lessonsNote(root, input);
    expect(c.cached).toBe(false);
    expect(c.text).toContain("may be outdated");
  });

  it("caps many lessons at the budget, prefers verified fixes, drops failures of a fixed task", async () => {
    const root = await repo();
    for (let i = 0; i < 6; i++) {
      recordAttemptLesson(root, {
        task: `Slug variant ${i} breaks`,
        files: ["src/slug.ts"],
        stopReason: "gate_rejected",
        summary: "x ".repeat(200),
        gateFeedback: `REJECTED ${"y ".repeat(200)}`,
      });
    }
    recordFixNote(root, {
      issue: "Slug variant 5 breaks",
      rootCause: "regex was greedy",
      files: ["src/slug.ts"],
      verified: true,
    });
    const note = lessonsNote(root, { files: ["src/slug.ts"], task: "slug" }, { maxTokens: 10_000, limit: 10 });
    expect(note.tokens).toBeLessThanOrEqual(LESSONS_MAX_TOKENS);
    expect(note.text.split("\n")[1]).toContain("Past fix (verified)");
    expect(note.text).not.toContain("Slug variant 5 breaks.");
  });

  it("keeps only the newest two lessons per task; verified outcomes become fixes", async () => {
    const root = await repo();
    for (const reason of ["aa", "bb", "cc"]) {
      recordAttemptLesson(root, { task: "Same task", files: ["src/slug.ts"], stopReason: reason });
    }
    const lessons = getMemoryGraph(root).entries.filter((e) => e.kind === "lesson");
    expect(lessons.map((e) => /\((\w+)\)/.exec(e.text)![1]).sort()).toEqual(["bb", "cc"]);
    const fix = recordAttemptLesson(root, { task: "Same task", files: ["src/slug.ts"], stopReason: "done", verified: true });
    expect(fix.kind).toBe("fix");
  });
});

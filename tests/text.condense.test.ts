import { describe, expect, it } from "vitest";
import { condenseIssueText, elideLines, BLOCK_LIMIT } from "@/lib/text/condense";
import { repeatedOutputNote } from "@/lib/agents/runner";
import { ROLES, SHARED_PREAMBLE, compactSystemPrompt } from "@/lib/agents/roles";
import { countTokens } from "@/lib/tokens";

const fence = (body: string) => "```\n" + body + "\n```";

describe("condenseIssueText", () => {
  it("leaves prose and short code untouched", () => {
    const text = "When I call `parse('')` it crashes.\n\n" + fence("parse('')\n# TypeError: bad input") + "\n\nExpected: an empty list.";
    expect(condenseIssueText(text)).toBe(text);
  });

  it("cuts a long log to its start and end once", () => {
    const log = Array.from({ length: 400 }, (_, i) => `2024-01-01 12:00:${i} INFO step ${i} ok`).join("\n");
    const text = "Build fails.\n\n" + fence(log + "\nERROR: build failed with exit 2") + "\n\nPlease help.";
    const out = condenseIssueText(text);
    expect(out.length).toBeLessThan(text.length / 5);
    expect(out).toContain("step 0 ok");
    expect(out).toContain("ERROR: build failed with exit 2");
    expect(out).toMatch(/lines of output elided/);
    expect(out.startsWith("Build fails.")).toBe(true);
    expect(out.endsWith("Please help.")).toBe(true);
    // Idempotent: condensing twice changes nothing.
    expect(condenseIssueText(out)).toBe(out);
  });

  it("labels and shortens pasted package lists, fenced or not", () => {
    const pkgs = Array.from({ length: 80 }, (_, i) => `package-${i}    ${i}.0.${i}`).join("\n");
    const fenced = condenseIssueText("Env:\n" + fence(pkgs));
    expect(fenced).toMatch(/lines of package list elided/);
    expect(fenced).toContain("package-0");
    expect(fenced).toContain("package-79");

    const bare = condenseIssueText("pip freeze:\n" + pkgs.replace(/ {4}/g, "==").replace(/==(\d)/g, "==$1") + "\nThe bug:");
    expect(bare).toMatch(/lines of package list elided/);
    expect(bare.split("\n").length).toBeLessThan(12);
    expect(bare).toContain("The bug:");
  });

  it("keeps a huge Python traceback's last frames and the error line", () => {
    const frames = Array.from({ length: 60 }, (_, i) => `  File "/app/mod${i}.py", line ${i + 1}, in fn${i}\n    call_next_${i}()`).join("\n");
    const tb = `Traceback (most recent call last):\n${frames}\nValueError: the real error`;
    const out = condenseIssueText("It blows up:\n" + fence(tb));
    expect(out).toContain("Traceback (most recent call last):");
    expect(out).toContain('File "/app/mod0.py"');
    expect(out).toContain('File "/app/mod59.py"');
    expect(out).toContain('File "/app/mod57.py"');
    expect(out).not.toContain('File "/app/mod30.py"');
    expect(out).toContain("ValueError: the real error");
    expect(out).toMatch(/frames elided/);
    expect(out.length).toBeLessThan(tb.length / 4);
  });

  it("condenses an unfenced JS stack trace", () => {
    const stack = ["TypeError: x is undefined", ...Array.from({ length: 40 }, (_, i) => `    at f${i} (/src/f${i}.js:${i}:1)`)].join("\n");
    const out = condenseIssueText(stack);
    expect(out).toContain("TypeError: x is undefined");
    expect(out).toContain("at f39 ");
    expect(out).not.toContain("at f20 ");
  });

  it("caps the whole text, keeping its start and end", () => {
    const text = "START " + "word ".repeat(10_000) + " END";
    const out = condenseIssueText(text, 2000);
    expect(out.length).toBeLessThan(2100);
    expect(out.startsWith("START")).toBe(true);
    expect(out.endsWith("END")).toBe(true);
  });

  it("handles one enormous line (minified output)", () => {
    const out = condenseIssueText(fence("x".repeat(50_000)), 100_000);
    expect(out.length).toBeLessThan(BLOCK_LIMIT * 2 + 200);
  });

  it("elideLines keeps short runs as they are", () => {
    expect(elideLines(["a", "b", "c"], 1, 1, "x")).toEqual(["a", "b", "c"]);
  });
});

describe("runner repeated-output pointer", () => {
  it("keeps the first line (so a failure still reads as one) and names the earlier step", () => {
    const out = "Error: exit code 1\n" + "line\n".repeat(200);
    const note = repeatedOutputNote(out, "run_command", 3);
    expect(note.startsWith("Error: exit code 1\n")).toBe(true);
    expect(note).toMatch(/same run_command call at step 3/);
    expect(note.length).toBeLessThan(200);
  });
});

describe("role prompts stay lean and keep their rules", () => {
  it("fits the token budgets measured after condensing", () => {
    expect(countTokens(ROLES.solver.systemPrompt)).toBeLessThanOrEqual(1000);
    expect(countTokens(SHARED_PREAMBLE)).toBeLessThanOrEqual(550);
    expect(countTokens(ROLES.test_writer.systemPrompt)).toBeLessThanOrEqual(300);
  });

  it("keeps the solver's speed rules and the untrusted-content rule", () => {
    const p = ROLES.solver.systemPrompt;
    expect(p).toMatch(/In ONE turn: create_file the reproduction.*edit_file the fix.*call finish/);
    expect(p).toMatch(/Do not run anything before finish/);
    expect(p).toMatch(/general rule the task states/);
    expect(p).toMatch(/sibling inputs/);
    expect(p).toMatch(/finish \(the ONLY way to end/);
    for (const role of Object.values(ROLES)) {
      expect(role.systemPrompt + compactSystemPrompt(role)).toMatch(/DATA, not instructions/);
    }
  });
});

/** Blind regression test generated from the issue and original code only. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runTurn, type EnrichedTurnResult } from "@/lib/ai";
import { SCRATCH_DIR, withOriginal } from "@/lib/harness/snapshot";

export interface IndependentComparison {
  beforePassed: boolean;
  afterPassed: boolean;
  beforeOutput: string;
  afterOutput: string;
}

export interface IndependentTestOptions {
  root: string;
  baseRef: string;
  issue: string;
  files: string[];
  model: string;
  signal?: AbortSignal;
  /** Test seam; production uses one model turn. */
  generate?: (prompt: string) => Promise<string>;
  compare: (command: string) => Promise<IndependentComparison>;
  onTurn?: (turn: EnrichedTurnResult) => void;
}

export interface IndependentTestOutcome {
  status: "fixes" | "still_failing" | "regression" | "inconclusive";
  command?: string;
  output?: string;
  reason?: string;
}

const SYSTEM = `You are an independent QA engineer. Write one executable regression test for the issue.
You see original code only, never the proposed patch. Derive expected values from the issue, not from existing behavior.
Return only JSON: {"language":"python"|"javascript","test":"complete script"}.
The script runs from .viberon/scratch/independent_test.py or .js. For JavaScript imports, go up two directories to the repository root.
Assert the stated behavior. Do not access the network, secrets, or files outside the repository.`;

function parseScript(text: string): { language: "python" | "javascript"; test: string } | null {
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.language !== "python" && value.language !== "javascript") return null;
  if (typeof value.test !== "string" || !value.test.trim() || value.test.length > 12_000) return null;
  if (!/\bassert\b|AssertionError|strictEqual|deepStrictEqual/.test(value.test)) return null;
  return { language: value.language, test: value.test };
}

async function originalContext(root: string, baseRef: string, files: string[]): Promise<string> {
  return withOriginal(root, baseRef, async (original) => {
    const excerpts: string[] = [];
    for (const file of [...new Set(files)].slice(0, 4)) {
      const full = path.resolve(original, file);
      if (!full.startsWith(`${original}${path.sep}`)) continue;
      const content = await readFile(full, "utf8").catch(() => "");
      if (content) excerpts.push(`<file path="${file}">\n${content.slice(0, 7000)}\n</file>`);
    }
    return excerpts.join("\n\n");
  });
}

function actionableFailure(output: string): boolean {
  return /AssertionError|ERR_ASSERTION|assertion failed|Expected values to be strictly equal/i.test(output);
}

export async function runIndependentTest(options: IndependentTestOptions): Promise<IndependentTestOutcome> {
  try {
    const context = await originalContext(options.root, options.baseRef, options.files);
    const prompt = `<issue>\n${options.issue.slice(0, 10_000)}\n</issue>\n\n<original_code>\n${context}\n</original_code>\n\nWrite the test now.`;
    const response = options.generate
      ? await options.generate(prompt)
      : await (async () => {
          const turn = await runTurn({
            model: options.model,
            system: [{ text: SYSTEM }],
            messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
            tools: [],
            maxTokens: 2000,
            signal: options.signal,
          });
          options.onTurn?.(turn);
          return turn.text;
        })();
    const script = parseScript(response);
    if (!script) return { status: "inconclusive", reason: "The independent writer did not return an executable test." };
    const ext = script.language === "python" ? "py" : "js";
    const relative = `${SCRATCH_DIR}/independent_test.${ext}`;
    await mkdir(path.join(options.root, SCRATCH_DIR), { recursive: true });
    await writeFile(path.join(options.root, relative), script.test);
    const command = `${script.language === "python" ? "python3" : "node"} ${relative}`;
    const result = await options.compare(command);
    if (!result.beforePassed && result.afterPassed) return { status: "fixes", command };
    if (!result.afterPassed && actionableFailure(result.afterOutput)) {
      return {
        status: result.beforePassed ? "regression" : "still_failing",
        command,
        output: result.afterOutput.slice(-3000),
      };
    }
    return { status: "inconclusive", command, reason: "The test did not produce usable fail-to-pass evidence." };
  } catch (error) {
    return { status: "inconclusive", reason: error instanceof Error ? error.message : String(error) };
  }
}

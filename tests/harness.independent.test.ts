import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextLedger, type EngineInput } from "@/lib/context/engine";
import { snapshot } from "@/lib/harness/snapshot";
import { classifyIndependent, draftIndependentTest, runIndependentTest, type DraftOptions } from "@/lib/harness/testwriter";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { getFileInfo, resetMemoryStoreForTests } from "@/lib/store";
import { fullReindex, openWorkspace, readFile } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const TEST_PATH = ".viberon/scratch/test_independent.js";
const COMMAND = `node ${TEST_PATH}`;
const PATCHED = "exports.answer = () => 2;\n";

let repo: TmpRepo;
let log: ReturnType<typeof eventLog>;

beforeEach(() => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({ "lib.js": "exports.answer = () => 1;\n" });
  log = eventLog();
});
afterEach(() => {
  uninstallFakeProvider();
  repo.cleanup();
});

async function engineFor(dir: string) {
  const handle = await openWorkspace((await registerLocalWorkspace(dir)).repoKey);
  const { graph, memory } = await fullReindex(handle);
  const engine: EngineInput = {
    graph,
    memory,
    fileInfo: await getFileInfo(handle.repoKey),
    readFile: (p) => readFile(handle, p),
    ledger: new ContextLedger(),
  };
  return { handle, engine };
}

/** The original is committed; the solver's patch sits in the work tree while the writer drafts. */
async function writerOptions(overrides: Partial<DraftOptions> = {}): Promise<DraftOptions> {
  const baseRef = await snapshot(repo.root);
  repo.write("lib.js", PATCHED);
  return {
    root: repo.root,
    baseRef,
    task: "answer() should return 2.",
    criteria: ["answer() -> 2"],
    summary: "Files: 1",
    relatedTests: ["test/lib.test.js"],
    model: "claude-opus-5",
    open: engineFor,
    emit: log.emit,
    ...overrides,
  };
}

describe("blind independent test writer", () => {
  it("drafts blind in a throwaway checkout of the original; nothing it does reaches the solver's tree", async () => {
    const options = await writerOptions();
    let writerDir = "";
    const fake = installFakeProvider([
      (req) => {
        const prompt = JSON.stringify(req.messages);
        expect(prompt).toContain("answer() should return 2.");
        expect(prompt).toContain("predicted_acceptance_criteria");
        expect(prompt).toContain("test/lib.test.js");
        expect(prompt).not.toContain(PATCHED.trim());
        expect((req.tools ?? []).map((t) => t.name).sort()).toEqual(
          ["create_file", "done", "edit_file", "find_symbols", "run_command", "view"],
        );
        return { calls: [{ name: "edit_file", input: { path: "lib.js", find: "1", replace: "3", summary: "cheat" } }] };
      },
      (req) => {
        expect(JSON.stringify(req.messages.at(-1))).toContain("Refused: you may only create or edit files under .viberon/scratch/");
        return {
          calls: [{
            name: "create_file",
            input: { path: TEST_PATH, content: "const assert = require('node:assert/strict');\nassert.equal(require('../../lib').answer(), 2);\n" },
          }],
        };
      },
      { calls: [{ name: "done", input: { command: COMMAND, notes: "answer is 2" } }] },
    ]);
    const draft = await draftIndependentTest({
      ...options,
      open: async (dir) => {
        writerDir = dir;
        // The writer sees the ORIGINAL code, not the solver's patch.
        expect(readFileSync(path.join(dir, "lib.js"), "utf8")).toBe("exports.answer = () => 1;\n");
        // A shell side effect (what run_command could do) lands in the throwaway checkout only.
        writeFileSync(path.join(dir, "lib.js"), "exports.answer = () => 99;\n");
        return engineFor(dir);
      },
    });

    expect(fake.remaining).toBe(0);
    expect(draft?.command).toBe(COMMAND);
    expect(draft?.files.map((f) => f.path)).toEqual([TEST_PATH]);
    expect(repo.read("lib.js")).toBe(PATCHED);
    expect(existsSync(path.join(repo.root, TEST_PATH))).toBe(false);
    expect(existsSync(writerDir)).toBe(false);

    let compared = "";
    const outcome = await runIndependentTest(repo.root, draft!, async (command) => {
      compared = command;
      return { beforePassed: false, afterPassed: true, beforeOutput: "AssertionError", afterOutput: "" };
    }, log.emit);
    expect(outcome).toEqual({ status: "fixes", command: COMMAND });
    expect(compared).toBe(COMMAND);
    expect(existsSync(path.join(repo.root, TEST_PATH))).toBe(true);
    expect(log.of("independent_test").map((e) => [e.status, e.command, e.verdict])).toEqual([
      ["written", COMMAND, undefined],
      ["ran", COMMAND, "fixes"],
    ]);
  });

  it("gives up without a command and says so", async () => {
    const options = await writerOptions({ maxSteps: 3 });
    installFakeProvider([{ text: "I cannot." }, { text: "Still no." }]);
    expect(await draftIndependentTest(options)).toBeNull();
    expect(log.of("independent_test")).toEqual([expect.objectContaining({ status: "gave_up" })]);
  });

  it("classifies runs: only an assertion failure on the patched code counts against it", () => {
    const run = (beforePassed: boolean, afterPassed: boolean, afterOutput = "") => ({ beforePassed, afterPassed, beforeOutput: "", afterOutput });
    expect(classifyIndependent("c", run(false, true)).status).toBe("fixes");
    expect(classifyIndependent("c", run(true, true)).status).toBe("passes");
    expect(classifyIndependent("c", run(false, false, "AssertionError [ERR_ASSERTION]")).status).toBe("still_failing");
    expect(classifyIndependent("c", run(true, false, "AssertionError")).status).toBe("regression");
    expect(classifyIndependent("c", run(false, false, "Cannot find module '../lib'")).status).toBe("inconclusive");
  });
});

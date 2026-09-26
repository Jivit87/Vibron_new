import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runIndependentTest } from "@/lib/harness/independent-test";
import { snapshot } from "@/lib/harness/snapshot";
import { makeTmpRepo } from "./helpers/tmp-repo";

describe("blind independent test", () => {
  it("shows only original code to the writer and stores the test outside the patch", async () => {
    const repo = makeTmpRepo({ "lib.py": "def answer(): return 1\n" });
    try {
      const baseRef = await snapshot(repo.root);
      repo.write("lib.py", "def answer(): return 2\n");
      let prompt = "";
      let command = "";
      const outcome = await runIndependentTest({
        root: repo.root,
        baseRef,
        issue: "answer() should return 2",
        files: ["lib.py"],
        model: "test-model",
        generate: async (text) => {
          prompt = text;
          return JSON.stringify({ language: "python", test: "from lib import answer\nassert answer() == 2\n" });
        },
        compare: async (cmd) => {
          command = cmd;
          return { beforePassed: false, afterPassed: true, beforeOutput: "AssertionError", afterOutput: "" };
        },
      });
      expect(prompt).toContain("return 1");
      expect(prompt).not.toContain("def answer(): return 2");
      expect(command).toBe("python3 .viberon/scratch/independent_test.py");
      expect(await readFile(path.join(repo.root, ".viberon/scratch/independent_test.py"), "utf8"))
        .toContain("assert answer() == 2");
      expect(outcome.status).toBe("fixes");
    } finally {
      repo.cleanup();
    }
  });

  it("treats malformed and non-executable tests as inconclusive", async () => {
    const repo = makeTmpRepo({ "lib.js": "module.exports = 1;\n" });
    try {
      const baseRef = await snapshot(repo.root);
      const common = { root: repo.root, baseRef, issue: "x", files: ["lib.js"], model: "test-model" };
      expect((await runIndependentTest({ ...common, generate: async () => "not json", compare: async () => {
        throw new Error("must not run");
      } })).status).toBe("inconclusive");
      expect((await runIndependentTest({ ...common, generate: async () =>
        JSON.stringify({ language: "javascript", test: "console.log('hi')" }), compare: async () => {
        throw new Error("must not run");
      } })).status).toBe("inconclusive");
    } finally {
      repo.cleanup();
    }
  });
});

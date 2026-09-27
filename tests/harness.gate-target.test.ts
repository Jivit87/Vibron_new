import { afterEach, describe, expect, it } from "vitest";

import { changedPythonSymbols, Gate, pythonTestIds, RELATED_TIMEOUT_MS, type CheckRunner } from "@/lib/harness/gate";
import { snapshot } from "@/lib/harness/snapshot";
import { eventLog } from "./helpers/harness-workspace";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const SRC = "class Poly:\n    def degree(self):\n        return 1\n\n\ndef expand(x):\n    return x\n";
const TESTS = [
  "from pkg.core import Poly, expand",
  "",
  "def test_expand():",
  "    assert expand(1) == 1",
  "",
  "def test_unrelated():",
  "    assert 1 + 1 == 2",
  "",
  "class TestPoly:",
  "    def test_degree(self):",
  "        assert Poly().degree() == 1",
  "",
  "    def test_other(self):",
  "        assert True",
  "",
].join("\n");

let repo: TmpRepo | null = null;
afterEach(() => repo?.cleanup());

describe("gate: related tests targeted to the changed symbols", () => {
  it("finds the enclosing def/class of changed lines and the tests that reference them", () => {
    const patch =
      "diff --git a/pkg/core.py b/pkg/core.py\n--- a/pkg/core.py\n+++ b/pkg/core.py\n@@ -3 +3 @@ class Poly:\n-        return 1\n+        return 2\n";
    const symbols = changedPythonSymbols(patch, "pkg/core.py", SRC.replace("return 1", "return 2"));
    expect(symbols.sort()).toEqual(["Poly", "degree"]);
    expect(pythonTestIds("tests/test_core.py", TESTS, new Set(["degree"]))).toEqual(["tests/test_core.py::TestPoly::test_degree"]);
    expect(pythonTestIds("tests/test_core.py", TESTS, new Set(["expand"]))).toEqual(["tests/test_core.py::test_expand"]);
  });

  it("runs node ids on both sides with a capped timeout, and whole files when nothing matches", async () => {
    repo = makeTmpRepo({ "pkg/__init__.py": "", "pkg/core.py": SRC, "tests/test_core.py": TESTS });
    const seen: { command: string; timeoutMs: number }[] = [];
    const runner: CheckRunner = async (command, { timeoutMs }) => {
      seen.push({ command, timeoutMs });
      return { exitCode: 0, output: "1 passed", timedOut: false, durationMs: 1 };
    };
    const gate = new Gate({
      root: repo.root,
      baseRef: await snapshot(repo.root),
      suite: [{ command: "python -m pytest -q", framework: "pytest", kind: "test", source: "detected" }],
      graph: null,
      timeoutMs: 900_000,
      emit: eventLog().emit,
      agentId: "solver",
      runner,
      services: { relatedTestFiles: async () => ["tests/test_core.py"] },
    });
    repo.write("pkg/core.py", SRC.replace("return 1", "return 2"));
    await gate.verify({ summary: "x" }, { dry: true });
    const related = seen.filter((s) => s.command.includes("tests/test_core.py"));
    expect(related.length).toBe(2); // original + patched
    for (const r of related) {
      expect(r.command).toBe("python -m pytest -q -rA tests/test_core.py::TestPoly::test_degree");
      expect(r.timeoutMs).toBe(RELATED_TIMEOUT_MS);
    }

    // A change no test references: the whole related file runs.
    seen.length = 0;
    repo.write("pkg/core.py", `${SRC}\n\ndef helper_zzz():\n    return 0\n`);
    await gate.verify({ summary: "y" }, { dry: true });
    expect(seen.some((s) => s.command === "python -m pytest -q -rA tests/test_core.py")).toBe(true);
  });
});

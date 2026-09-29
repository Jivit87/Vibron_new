import { describe, expect, it } from "vitest";
import { outputCounts } from "@/lib/harness/gate";

// The final check of an eval run (config-merge) re-ran two tests by node id;
// the report said "1 passed" because the output was never parsed.
const TARGETED = `$ python -m pytest -q -rA -p no:cacheprovider tests/test_loader.py::test_later_layer_wins tests/test_loader.py::test_nested
..                                                                       [100%]
==================================== PASSES ====================================
=========================== short test summary info ============================
PASSED tests/test_loader.py::test_later_layer_wins
PASSED tests/test_loader.py::test_nested
2 passed in 0.00s

[exited with code 0]`;

describe("outputCounts (reporting for non-suite gate runs)", () => {
  it("counts what the runner printed", () => {
    expect(outputCounts(TARGETED, true)).toEqual({ passed: 2, failed: 0 });
    const mixed = [
      "F.                                                                       [100%]",
      "=========================== short test summary info ============================",
      "PASSED tests/t.py::b",
      "FAILED tests/t.py::a - AssertionError: boom",
      "========================= 1 failed, 1 passed in 0.01s ==========================",
    ].join("\n");
    expect(outputCounts(mixed, false)).toEqual({ passed: 1, failed: 1 });
  });

  it("falls back to one per command when nothing parses", () => {
    expect(outputCounts("ok", true)).toEqual({ passed: 1, failed: 0 });
    expect(outputCounts("Traceback ...\nKeyError: 'x'", false)).toEqual({ passed: 0, failed: 1 });
  });
});

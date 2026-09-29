import { describe, expect, it } from "vitest";
import { touchesCode } from "@/lib/harness/fastpath";

describe("touchesCode (a patch must change source to count as verified)", () => {
  it("accepts a patch that changes a source file", () => {
    expect(touchesCode(["src/slugify.py"])).toBe(true);
    expect(touchesCode(["README.md", "lib/semver.js"])).toBe(true);
    expect(touchesCode(["pkg/server/handler.go", "tests/test_handler.py"])).toBe(true);
  });

  it("rejects docs-, config- and CI-only patches", () => {
    expect(touchesCode(["README.md"])).toBe(false);
    expect(touchesCode(["docs/usage.md", "CHANGELOG.md"])).toBe(false);
    expect(touchesCode(["package.json", "tsconfig.json", "setup.cfg"])).toBe(false);
    expect(touchesCode([".github/workflows/ci.yml", "Makefile"])).toBe(false);
    expect(touchesCode(["docs/conf.py"])).toBe(false);
  });

  it("rejects a patch that only edits tests", () => {
    expect(touchesCode(["tests/test_slugify.py"])).toBe(false);
    expect(touchesCode(["src/slugify.test.ts", "lib/__tests__/x.js"])).toBe(false);
  });

  it("rejects harness scratch files and an empty patch", () => {
    expect(touchesCode([".viberon/scratch/repro.py"])).toBe(false);
    expect(touchesCode([])).toBe(false);
  });
});

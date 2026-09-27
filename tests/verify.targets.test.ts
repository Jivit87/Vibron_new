import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isTestPath, relatedTestTargets, type VerifyCommand } from "@/lib/verify";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-targets-"));
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), source);
  }
  return root;
}

const pytest: VerifyCommand = {
  command: "python -m pytest -q -rA -p no:cacheprovider",
  framework: "pytest",
  kind: "test",
  targetTemplate: "python -m pytest -q -rA -p no:cacheprovider {files}",
  source: "t",
};
const vitest: VerifyCommand = { command: "pnpm test", framework: "vitest", kind: "test", targetTemplate: "npx vitest run {files}", source: "t" };
const nodeTest: VerifyCommand = { command: "node --test", framework: "node-test", kind: "test", targetTemplate: "node --test {files}", source: "t" };

const PY = {
  "textkit/__init__.py": "",
  "textkit/slug.py": "def slugify(s):\n    return s\n",
  "textkit/wrap.py": "def wrap(s):\n    return s\n",
  "tests/test_slug.py":
    "from textkit.slug import slugify\n\ndef test_slugify_basic():\n    pass\n\nclass TestSlug:\n    def test_slugify_sep(self):\n        pass\n    def test_other(self):\n        pass\n\ndef test_unrelated():\n    pass\n",
  "tests/test_wrap.py": "from textkit.wrap import wrap\n\ndef test_wrap():\n    pass\n",
  "tests/test_misc.py": "import textkit.slug\n\ndef test_misc():\n    pass\n",
};

describe("relatedTestTargets", () => {
  it("isTestPath follows Pramana conventions", () => {
    expect(isTestPath("tests/test_a.py")).toBe(true);
    expect(isTestPath("pkg/a_test.go")).toBe(true);
    expect(isTestPath("src/a.spec.ts")).toBe(true);
    expect(isTestPath("src/testing_utils.py")).toBe(false);
  });

  it("picks the convention test first, then importers, and narrows to pytest node ids", async () => {
    const root = await repo(PY);
    const t = await relatedTestTargets(root, ["textkit/slug.py"], ["slugify"], { command: pytest });
    expect(t.files).toEqual(["tests/test_slug.py", "tests/test_misc.py"]);
    // test_misc has no test named after slugify -> file-level, no node ids.
    expect(t.testIds).toEqual([]);
    expect(t.command).toBe("python -m pytest -q -rA -p no:cacheprovider tests/test_slug.py tests/test_misc.py");
    const one = await relatedTestTargets(root, ["textkit/slug.py"], ["slugify"], { command: pytest, limit: 1 });
    expect(one.testIds).toEqual(["tests/test_slug.py::test_slugify_basic", "tests/test_slug.py::TestSlug::test_slugify_sep"]);
    expect(one.command).toContain("tests/test_slug.py::TestSlug::test_slugify_sep");
    expect(one.timeoutMs).toBe(40_000);
  });

  it("does not select unrelated tests and returns null when nothing matches", async () => {
    const root = await repo(PY);
    const t = await relatedTestTargets(root, ["textkit/wrap.py"], [], { command: pytest });
    expect(t.files).toEqual(["tests/test_wrap.py"]);
    const none = await relatedTestTargets(root, ["README.md"], [], { command: pytest });
    expect(none.command).toBeNull();
  });

  it("includes a changed test file directly", async () => {
    const root = await repo(PY);
    const t = await relatedTestTargets(root, ["tests/test_wrap.py"], [], { command: pytest, limit: 1 });
    expect(t.files).toEqual(["tests/test_wrap.py"]);
  });

  it("targets JS tests by relative import and adds a name filter", async () => {
    const root = await repo({
      "src/semver.js": "exports.compare = () => 0;\n",
      "src/other.js": "",
      "test/semver.test.js": "const { compare } = require('../src/semver');\nit('compare orders', () => {});\n",
      "test/misc.test.js": "import x from '../src/other.js';\nit('x', () => {});\n",
    });
    const v = await relatedTestTargets(root, ["src/semver.js"], ["compare"], { command: vitest });
    expect(v.files).toEqual(["test/semver.test.js"]);
    expect(v.command).toBe("npx vitest run test/semver.test.js -t 'compare orders'");
    const n = await relatedTestTargets(root, ["src/semver.js"], ["compare"], { command: nodeTest });
    expect(n.command).toBe("node --test --test-name-pattern='compare orders' test/semver.test.js");
    const o = await relatedTestTargets(root, ["src/other.js"], [], { command: vitest });
    expect(o.files).toEqual(["test/misc.test.js"]);
  });

  it("resolves @/ aliases", async () => {
    const root = await repo({
      "lib/verify/run.ts": "",
      "tests/verify.run.test.ts": "import { x } from \"@/lib/verify/run\";\n",
      "tests/other.test.ts": "import { y } from \"@/lib/other\";\n",
    });
    const t = await relatedTestTargets(root, ["lib/verify/run.ts"], [], { command: vitest });
    expect(t.files).toEqual(["tests/verify.run.test.ts"]);
  });
});

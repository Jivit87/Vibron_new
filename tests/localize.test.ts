import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractSignals, extractSnippets, localize, renderLocalization, tokenize } from "@/lib/localize";
import { clearMemoryGraphCache, recordFixNote } from "@/lib/memory";
import type { ShellRunner } from "@/lib/verify";

const dirs: string[] = [];

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "viberon-localize-"));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  return root;
}

const FILES = {
  "textkit/__init__.py": "from textkit.slug import slugify\nfrom textkit.wrap import wrap\n",
  "textkit/slug.py": "import re\n\ndef slugify(text, sep='-'):\n    return re.sub(r'[^a-z0-9]', sep, text.lower())\n",
  "textkit/wrap.py": "def wrap(text, width=70):\n    return text\n",
  "textkit/cli.py": "import sys\n\ndef main():\n    print(sys.argv)\n",
  "tests/test_slug.py": "from textkit.slug import slugify\n\ndef test_basic():\n    assert slugify('a b') == 'a-b'\n",
  "tests/test_wrap.py": "from textkit.wrap import wrap\n\ndef test_wrap():\n    assert wrap('x') == 'x'\n",
};

beforeEach(() => clearMemoryGraphCache());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("issue signals", () => {
  it("extracts identifiers, dotted names, traceback frames and paths", () => {
    const s = extractSignals(
      'Calling `slugify()` in textkit.slug fails:\nTraceback (most recent call last):\n  File "/home/u/proj/textkit/slug.py", line 4, in slugify\nValueError\nSee textkit/wrap.py too',
    );
    expect(s.strong).toContain("slugify");
    expect(s.dotted).toContain("textkit.slug");
    expect(s.frames).toEqual([{ file: "/home/u/proj/textkit/slug.py", line: 4, func: "slugify" }]);
    expect(s.paths).toContain("textkit/wrap.py");
    expect(tokenize("slugifyText my_helper")).toEqual(expect.arrayContaining(["slugifytext", "slugify", "text", "helper"]));
  });

  it("pulls runnable Python (doctest and fenced) and JS out of an issue, skipping output and shell", () => {
    const issue = [
      "```python\n>>> from textkit import slugify\n>>> slugify('Crème')\n'crme'\n```",
      "```\n$ pip install textkit\n```",
      "```\nTraceback (most recent call last):\n  ...\n```",
      "```js\nconst s = require('./src/semver');\nconsole.log(s.compare('1.0.0-a', '1.0.0'))\n```",
    ].join("\n\n");
    const snippets = extractSnippets(issue);
    expect(snippets).toHaveLength(2);
    expect(snippets[0]).toMatchObject({ lang: "python", source: "doctest" });
    expect(snippets[0]!.code).toBe("from textkit import slugify\nprint(repr(slugify('Crème')))");
    // JS runs from .viberon/scratch/, so relative requires are re-rooted at the repo.
    expect(snippets[1]).toMatchObject({ lang: "js" });
    expect(snippets[1]!.code).toContain("require('../../src/semver')");
  });
});

describe("localize", () => {
  it("ranks the file named by the issue first, with reasons, symbols and related tests", async () => {
    const root = repo(FILES);
    const res = await localize(root, "`slugify` produces '--' for 'a  b'; it should collapse separators.", null, { runSnippets: false });
    expect(res.files[0]!.path).toBe("textkit/slug.py");
    expect(res.files[0]!.why.join(" ")).toContain("defines `slugify`");
    expect(res.symbols.some((s) => s.startsWith("slugify"))).toBe(true);
    expect(res.testFiles).toContain("tests/test_slug.py");
    expect(res.files.some((f) => f.path.startsWith("tests/"))).toBe(false);
    expect(renderLocalization(res)).toContain("1. textkit/slug.py");
  });

  it("runs the issue's snippet on the original code and uses its traceback", async () => {
    const root = repo(FILES);
    const commands: string[] = [];
    const run: ShellRunner = async (cwd, command) => {
      commands.push(command);
      expect(cwd).toBe(path.join(root, ".viberon", "scratch"));
      return {
        exitCode: 1,
        timedOut: false,
        durationMs: 5,
        output: `Traceback (most recent call last):\n  File "${root}/textkit/wrap.py", line 2, in wrap\nTypeError: boom`,
      };
    };
    const res = await localize(root, "Crash:\n```python\nfrom textkit import wrap\nwrap(None)\n```", null, { run });
    expect(commands).toEqual(["python issue_snippet_1.py"]);
    expect(readFileSync(path.join(root, ".viberon", "scratch", "issue_snippet_1.py"), "utf8")).toContain("wrap(None)");
    expect(res.snippetRun).toMatchObject({ exitCode: 1, code: "from textkit import wrap\nwrap(None)" });
    expect(res.snippetRun!.output).toContain("TypeError: boom");
    expect(res.files[0]).toMatchObject({ path: "textkit/wrap.py" });
    expect(res.files[0]!.why).toContain("in traceback");
  });

  it("returns past fix notes on the same area as lessons", async () => {
    const root = repo(FILES);
    recordFixNote(root, { issue: "slugify kept accents", rootCause: "missing NFKD normalization", files: ["textkit/slug.py"], verified: true });
    const res = await localize(root, "`slugify` mangles accented letters", null, { runSnippets: false });
    expect(res.lessons).toEqual(["Past fix (verified): slugify kept accents — missing NFKD normalization"]);
    expect(renderLocalization(res)).toContain("Past fixes nearby");
  });
});

describe("localize seeds and index cache", () => {
  const MORE = {
    ...FILES,
    "textkit/money.py":
      'def round_half(value):\n    """Round a currency amount to cents using banker rounding."""\n    return round(value, 2)\n\n\ndef add(a, b):\n    return a + b\n',
  };

  it("names the symbol around a traceback frame, with its line range", async () => {
    const root = repo(MORE);
    const res = await localize(
      root,
      'Crash:\nTraceback (most recent call last):\n  File "textkit/money.py", line 3, in round_half\nTypeError: bad',
      null,
      { runSnippets: false },
    );
    expect(res.files[0]!.path).toBe("textkit/money.py");
    expect(res.symbols[0]).toBe("round_half (textkit/money.py:1-3)");
  });

  it("matches symbol docstrings when the issue never names the function", async () => {
    const root = repo(MORE);
    const res = await localize(root, "Currency amounts are rounded wrong: banker rounding to cents is off.", null, { runSnippets: false });
    expect(res.files[0]!.path).toBe("textkit/money.py");
    expect(res.files[0]!.why.join(" ")).toContain("round_half");
  });

  it("reuses its index across calls and sees edited files", async () => {
    const root = repo(MORE);
    const first = await localize(root, "`slugify` collapses separators", null, { runSnippets: false });
    const again = await localize(root, "`slugify` collapses separators", null, { runSnippets: false });
    expect(again).toEqual(first);
    writeFileSync(path.join(root, "textkit/wrap.py"), "def wrap(text, width=70):\n    # zebra zebra zebra\n    return text\n");
    const edited = await localize(root, "zebra zebra", null, { runSnippets: false });
    expect(edited.files[0]!.path).toBe("textkit/wrap.py");
  });

  it("stops on abort", async () => {
    const root = repo(MORE);
    const ctl = new AbortController();
    ctl.abort();
    await expect(localize(root, "slugify", null, { runSnippets: false, signal: ctl.signal })).rejects.toThrow();
  });
});

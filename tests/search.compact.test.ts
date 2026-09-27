import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { findFiles, formatHits, searchCode, type Hit } from "@/lib/search/compact";
import { findDefinition, pythonSymbols, regexSymbols, SymbolIndex } from "@/lib/search/symbols";

function repo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vib-search-"));
  const w = (rel: string, s: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), s);
  };
  w("src/a.ts", "export function alpha(x: number) {\n  return x;\n}\nexport const beta = (y) => y;\nexport interface Gamma {}\n");
  w("src/b.py", "MAX = 3\nclass Foo(Base):\n    def bar(self, a, b=1):\n        return a\n\n    async def baz(self):\n        pass\n\ndef top(*args, **kw):\n    pass\n");
  w("src/a.test.ts", "alpha(1);\nalpha(2);\n");
  w("node_modules/x/index.js", "alpha\n");
  w("go/m.go", "package m\nfunc (r *R) Run() error {\n}\ntype R struct {}\n");
  return root;
}

describe("compact search (Pramana search.py port)", () => {
  for (const backend of ["rg", "js"] as const) {
    it(`groups per file with non-test files first [${backend}]`, async () => {
      const root = repo();
      const out = await searchCode(root, "alpha", { backends: [backend] });
      const lines = out.split("\n");
      expect(lines[0]).toMatch(/^3 matches in 2 files/);
      expect(lines[1]).toMatch(/^src\/a\.ts {2}\(1 match\)/);
      expect(out.indexOf("src/a.test.ts")).toBeGreaterThan(out.indexOf("src/a.ts "));
      expect(out).not.toContain("node_modules");
    });
  }

  it("caps matches per file and total, listing the rest", () => {
    const hits: Hit[] = [];
    for (let f = 0; f < 20; f++) for (let l = 1; l <= 20; l++) hits.push([`f${f}.ts`, l, `line ${l}`]);
    const out = formatHits(hits, "x");
    expect(out).toContain("... 8 more in this file");
    expect(out).toMatch(/results capped; 13 more files matched/);
    expect(out.split("\n").length).toBeLessThan(110);
  });

  it("falls back to literal on bad regex and validates path", async () => {
    const root = repo();
    expect(await searchCode(root, "alpha(", { backends: ["js"] })).toMatch(/matches/);
    expect(await searchCode(root, "x", { path: "nope" })).toMatch(/does not exist/);
    expect(await searchCode(root, "x", { path: "/etc" })).toMatch(/outside the repository/);
    expect(await searchCode(root, "zzzq", { glob: "*.ts", backends: ["js"] })).toMatch(/^No matches for "zzzq" \(glob \*\.ts\)\.$/);
  });

  it("findFiles lists by glob", async () => {
    const root = repo();
    const out = await findFiles(root, "*.py", { backends: ["js"] });
    expect(out).toBe('1 files match "*.py":\nsrc/b.py');
  });
});

describe("symbols (Pramana symbols.py port)", () => {
  it("python: qualnames, spans, signatures", () => {
    const syms = pythonSymbols("MAX = 3\nclass Foo(Base):\n    def bar(self, a, b=1):\n        return a\n\n    async def baz(self):\n        pass\n\ndef top(*args, **kw):\n    pass\n", "b.py");
    const by = Object.fromEntries(syms.map((s) => [s.qualname, s]));
    expect(by.MAX.kind).toBe("var");
    expect(by.Foo).toMatchObject({ kind: "class", line: 2, endLine: 7, signature: "(Base)" });
    expect(by["Foo.bar"]).toMatchObject({ kind: "method", line: 3, endLine: 4, signature: "(self, a, b)" });
    expect(by["Foo.baz"].kind).toBe("method");
    expect(by.top).toMatchObject({ kind: "def", signature: "(*args, **kw)" });
  });

  it("regex: ts/go", () => {
    const ts = regexSymbols("export function alpha(x) {}\nexport const beta = (y) => y;\nexport interface Gamma {}\nif (x) {}\n", "a.ts");
    expect(ts.map((s) => `${s.kind}:${s.name}`)).toEqual(["function:alpha", "function:beta", "type:Gamma"]);
    const go = regexSymbols("func (r *R) Run() error {\n}\ntype R struct {}\n", "m.go");
    expect(go.map((s) => s.name)).toEqual(["Run", "R"]);
  });

  it("findDefinition ranks and narrows qualified queries", async () => {
    const root = repo();
    const idx = await SymbolIndex.forRoot(root);
    expect(await findDefinition(idx, "Foo.bar")).toMatch(/^src\/b\.py:3-4 {2}method Foo\.bar/);
    expect(await findDefinition(idx, "ALPHA")).toMatch(/^src\/a\.ts:1 {2}function alpha/);
    expect(await findDefinition(idx, "nothing")).toMatch(/No definition/);
  });
});

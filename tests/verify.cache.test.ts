/**
 * W6: `detectVerifyCommands` is cached per root, keyed on manifest mtimes.
 * Measures the uncached and cached call on a Python repo (where the pytest
 * probe spawns the interpreter) and checks that a manifest edit invalidates.
 */

import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { detectVerifyCommands } from "@/lib/verify";

async function repo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "viberon-detect-cache-"));
  for (const [rel, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), source);
  }
  return root;
}

describe("detectVerifyCommands cache (W6)", () => {
  it("answers a repeat call from the cache and re-detects after a manifest changes", async () => {
    const root = await repo({
      "pyproject.toml": "[project]\nname='x'\n",
      "x/__init__.py": "",
      "tests/test_x.py": "def test_x():\n    pass\n",
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    });

    let t = performance.now();
    const first = await detectVerifyCommands(root);
    const coldMs = performance.now() - t;
    t = performance.now();
    const second = await detectVerifyCommands(root);
    const warmMs = performance.now() - t;
    process.stdout.write(`detectVerifyCommands: cold ${coldMs.toFixed(1)} ms, cached ${warmMs.toFixed(2)} ms\n`);

    expect(second).toEqual(first);
    expect(warmMs).toBeLessThan(Math.max(5, coldMs / 5));
    // Callers get a copy: mutating it cannot poison the cache.
    second[0]!.command = "mutated";
    expect((await detectVerifyCommands(root))[0]!.command).toBe(first[0]!.command);

    // A manifest edit (new mtime) invalidates the entry.
    await writeFile(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const later = new Date(Date.now() + 5_000);
    await utimes(path.join(root, "package.json"), later, later);
    const after = await detectVerifyCommands(root);
    expect(after.find((c) => c.source.startsWith("package.json"))?.framework).toBe("vitest");
  });
});

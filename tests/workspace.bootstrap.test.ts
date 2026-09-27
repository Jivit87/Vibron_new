import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  bootstrapEnvironment,
  manifestHash,
  probeRepo,
  probeSummary,
  requirementFiles,
} from "@/lib/workspace/bootstrap";
import { cloneRepository } from "@/lib/workspace/clone";

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function tmp(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

function bareRepo(commits = 3): string {
  const base = tmp("viberon-boot-src-");
  const work = path.join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  for (let i = 0; i < commits; i++) {
    writeFileSync(path.join(work, "a.py"), `x = ${i}\n`);
    execFileSync("git", ["add", "-A"], { cwd: work });
    execFileSync("git", ["commit", "-q", "-m", `c${i}`], { cwd: work, env: gitEnv });
  }
  execFileSync("git", ["tag", "v0", "HEAD~1"], { cwd: work });
  const bare = path.join(base, "demo.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

describe("probeRepo", () => {
  it("detects language and vitest command in one pass", () => {
    const root = tmp("viberon-probe-");
    write(root, { "package.json": JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }), "pnpm-lock.yaml": "" });
    const probe = probeRepo(root, ["package.json", "pnpm-lock.yaml", "src/a.ts", "src/b.ts", "x.js"]);
    expect(probe).toMatchObject({ primaryLanguage: "TypeScript", testFramework: "vitest", testCommand: "pnpm test", packageManager: "pnpm" });
    expect(probeSummary(probe)).toContain("npx vitest run {files}");
  });

  it("detects pytest, go, and unknown", () => {
    const root = tmp("viberon-probe-");
    expect(probeRepo(root, ["pkg/__init__.py"]).testCommand).toBe("python -m pytest -q");
    expect(probeRepo(root, ["go.mod", "main.go"]).testFramework).toBe("go test");
    expect(probeRepo(root, ["README.md"]).testFramework).toBe("unknown");
  });
});

describe("requirementFiles", () => {
  it("finds fixed and globbed test/dev requirement files", () => {
    const root = tmp("viberon-reqs-");
    write(root, { "requirements.txt": "", "requirements/requirements-tests.txt": "", "requirements/docs.txt": "", "dev-requirements.txt": "" });
    expect(requirementFiles(root)).toEqual(["requirements.txt", "requirements/requirements-tests.txt"]);
  });
});

describe("bootstrapEnvironment caching", () => {
  it("respects a node_modules it did not create and skips when the stamp matches", async () => {
    const root = tmp("viberon-boot-");
    write(root, { "package.json": "{}", "package-lock.json": "{}", "node_modules/x/index.js": "" });
    expect(await bootstrapEnvironment(root)).toEqual([]);
    writeFileSync(path.join(root, "node_modules", ".viberon-bootstrap"), manifestHash(root, ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "npm-shrinkwrap.json"]));
    expect(await bootstrapEnvironment(root)).toEqual(["node deps: cached (lockfile unchanged)"]);
  });

  it("skips python setup when the venv stamp matches the manifests", async () => {
    const root = tmp("viberon-boot-");
    write(root, { "pyproject.toml": "[project]\nname='x'\n", ".venv/bin/python": "" });
    writeFileSync(path.join(root, ".venv", ".viberon-bootstrap"), manifestHash(root, ["pyproject.toml", "setup.py", "setup.cfg"]));
    expect(await bootstrapEnvironment(root)).toEqual(["python deps: cached (manifests unchanged)"]);
  });
});

describe("cloneRepository fast paths", () => {
  it("clones shallow by default, skips a recent fetch, and checks out a ref on a shallow reuse", async () => {
    const bare = bareRepo();
    const baseDir = tmp("viberon-boot-dst-");
    const target = { cloneUrl: `file://${bare}`, owner: "local", name: "demo" };
    const first = await cloneRepository(target, { baseDir });
    expect(existsSync(path.join(first.rootPath, ".git", "shallow"))).toBe(true);
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: first.rootPath, encoding: "utf8" }).trim();
    expect(count).toBe("1");

    const lines: string[] = [];
    await cloneRepository(target, { baseDir, onProgress: (l) => lines.push(l) });
    await cloneRepository(target, { baseDir, onProgress: (l) => lines.push(l) });
    expect(lines.some((l) => l.includes("fetched recently"))).toBe(true);

    const withRef = await cloneRepository(target, { baseDir, ref: "v0" });
    expect(withRef.reused).toBe(true);
    const head = execFileSync("git", ["log", "-1", "--format=%s"], { cwd: withRef.rootPath, encoding: "utf8" }).trim();
    expect(head).toBe("c1");
  });
});

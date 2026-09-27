/**
 * Gap fixes from the end-to-end audit (docs/GAPS.md): CLI, terminal cwd and
 * session removal, Problems test runs, MCP edits, memory notes, push-only
 * delivery to a non-GitHub remote.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DELETE as memoryDelete, PATCH as memoryPatch } from "@/app/api/memory/route";
import { checkRepoDir, main, parseCliArgs, throttledProgress } from "@/cli/viberon";
import { deliver, DeliverError } from "@/lib/deliver";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { keepRedactedSecrets } from "@/lib/mcp/config";
import { clearMemoryGraphCache, getMemoryGraph } from "@/lib/memory/graph";
import { runChecks } from "@/lib/problems";
import { testFailureProblems, testIdFile } from "@/lib/problems/parse";
import { searchFiles, SearchInputError } from "@/lib/search";
import { resetMemoryStoreForTests } from "@/lib/store";
import { getSession, removeSession, resolveSessionCwd, startCommand } from "@/lib/terminal";
import { makeTmpRepo, type TmpRepo } from "@/tests/helpers/tmp-repo";

describe("cli", () => {
  it("parses --version", () => {
    expect(parseCliArgs(["--version"])).toEqual({ command: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ command: "version" });
  });

  it("keeps the first and final line of each clone progress phase", () => {
    const out: string[] = [];
    const log = throttledProgress((l) => out.push(l));
    for (const l of [
      "Cloning into 'x'...",
      "Receiving objects:   6% (1/17)",
      "Receiving objects:  50% (9/17)",
      "Receiving objects: 100% (17/17), 11.50 KiB | 2.87 MiB/s, done.",
      "Resolving deltas:   0% (0/1)",
      "Resolving deltas: 100% (1/1), done.",
      "Indexing code graph…",
    ]) log(l);
    expect(out).toEqual([
      "Cloning into 'x'...",
      "Receiving objects:   6% (1/17)",
      "Receiving objects: 100% (17/17), 11.50 KiB | 2.87 MiB/s, done.",
      "Resolving deltas:   0% (0/1)",
      "Resolving deltas: 100% (1/1), done.",
      "Indexing code graph…",
    ]);
  });

  it("explains a missing repo instead of crashing", async () => {
    expect(await checkRepoDir("/definitely/not/here")).toMatch(/repository not found/);
    expect(await checkRepoDir(os.tmpdir())).toBeNull();
  });

  it("rejects unknown eval tasks with the available names (exit 2)", async () => {
    const lines: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await main(["eval", "--only", "no-such-task"])).toBe(2);
    } finally {
      process.stderr.write = write;
    }
    expect(lines.join("")).toMatch(/unknown task no-such-task\. Available: .*slugify/);
  });
});

describe("terminal", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "vb-term-"));
    mkdirSync(path.join(root, "sub"));
    writeFileSync(path.join(root, "file.txt"), "x");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("resolves cwd inside the workspace only", () => {
    expect(resolveSessionCwd(root, undefined)).toEqual({ cwd: path.resolve(root) });
    expect(resolveSessionCwd(root, "sub")).toEqual({ cwd: path.join(path.resolve(root), "sub") });
    expect(resolveSessionCwd(root, "../..")).toEqual({ error: "cwd escapes the workspace" });
    expect(resolveSessionCwd(root, "/etc")).toMatchObject({ error: expect.stringMatching(/relative/) });
    expect(resolveSessionCwd(root, "file.txt")).toMatchObject({ error: expect.stringMatching(/not a directory/) });
    expect(resolveSessionCwd(root, "nope")).toMatchObject({ error: expect.stringMatching(/does not exist/) });
  });

  it("removes finished sessions but not running ones", async () => {
    const running = startCommand({ repoKey: "t", command: "sleep 5", cwd: root, origin: "user" });
    expect(removeSession(running.id)).toBe(false);
    const done = startCommand({ repoKey: "t", command: "true", cwd: root, origin: "user" });
    await done.done;
    expect(removeSession(done.id)).toBe(true);
    expect(getSession(done.id)).toBeUndefined();
    expect(removeSession("missing")).toBe(false);
    running.child?.kill("SIGKILL");
  });
});

describe("search", () => {
  it("reports an invalid regex once", () => {
    let message = "";
    try {
      searchFiles([], { query: "(", regex: true });
    } catch (error) {
      expect(error).toBeInstanceOf(SearchInputError);
      message = (error as Error).message;
    }
    expect(message.match(/Invalid regular expression/g)).toHaveLength(1);
  });
});

describe("problems: tests", () => {
  it("maps test ids to files", () => {
    expect(testIdFile("tests/test_a.py::test_x")).toBe("tests/test_a.py");
    expect(testIdFile("src/a.test.ts > suite > name")).toBe("src/a.test.ts");
    expect(testIdFile("adds numbers")).toBe("");
  });

  it("turns failing tests into problems, with a line from the excerpt", () => {
    const problems = testFailureProblems({
      command: "pytest",
      tests: { "tests/test_a.py::test_x": "fail", "tests/test_a.py::test_y": "pass", "x > y": "error" },
      failed: true,
      excerpt: "tests/test_a.py:12: AssertionError",
    });
    expect(problems).toEqual([
      { file: "tests/test_a.py", line: 12, col: 1, severity: "error", message: "Test failed: tests/test_a.py::test_x", source: "tests" },
      { file: "", line: 1, col: 1, severity: "error", message: "Test error: x > y", source: "tests" },
    ]);
  });

  it("reports an unattributable failure as one project-wide problem", () => {
    const [problem] = testFailureProblems({
      command: "npm test",
      tests: {},
      failed: true,
      excerpt: "> pkg@1.0.0 test\n> xo && ava\n\nsh: xo: command not found",
    });
    expect(problem!.message).toBe("`npm test` failed: sh: xo: command not found");
  });

  it("runs the detected test command on request and keeps its results on later runs", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "vb-problems-tests-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      writeFileSync(
        path.join(root, "math.test.js"),
        `const test = require("node:test"); const assert = require("node:assert");
         test("adds", () => assert.strictEqual(1 + 1, 2));
         test("breaks", () => assert.strictEqual(1 + 1, 3));`,
      );
      const withTests = await runChecks(root, { tests: true });
      const tests = withTests.checkers.find((c) => c.checker === "tests");
      expect(tests).toMatchObject({ ran: true, count: 1 });
      expect(withTests.problems.filter((p) => p.source === "tests").map((p) => p.message)).toEqual([
        "Test failed: breaks",
      ]);
      const later = await runChecks(root);
      expect(later.checkers.map((c) => c.checker)).toEqual(["tsc", "eslint", "tests"]);
      expect(later.problems.some((p) => p.source === "tests")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("mcp", () => {
  it("keeps stored secrets for values still redacted", () => {
    expect(keepRedactedSecrets({ A: "su••••", B: "new", C: "••••" }, { A: "supersecret", B: "old" })).toEqual({
      A: "supersecret",
      B: "new",
      C: "••••",
    });
    expect(keepRedactedSecrets(undefined, { A: "x" })).toBeUndefined();
  });
});

describe("memory route", () => {
  let repo: TmpRepo;
  let repoKey: string;
  beforeEach(async () => {
    resetMemoryStoreForTests();
    repo = makeTmpRepo({ "src/a.ts": "export function a() { return 1; }\n" });
    repoKey = (await registerLocalWorkspace(repo.root)).repoKey;
  });
  afterEach(() => {
    clearMemoryGraphCache();
    repo.cleanup();
  });

  const patch = async (body: unknown) => {
    const res = await memoryPatch(new Request("http://localhost/api/memory", { method: "PATCH", body: JSON.stringify(body) }));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("rejects invalid entries instead of dropping them", async () => {
    expect((await patch({ repoKey, entry: { kind: "bogus", text: "x" } })).status).toBe(400);
    expect((await patch({ repoKey, entry: { kind: "fact", text: " " } })).status).toBe(400);
    expect((await patch({ repoKey, note: { text: "" } })).status).toBe(400);
    expect((await patch({ repoKey, note: { text: "x", anchors: "src/a.ts" } })).status).toBe(400);
  });

  it("adds and forgets a graph-anchored note", async () => {
    const added = await patch({ repoKey, note: { text: "a() is the entry point", anchors: ["src/a.ts"] } });
    expect(added.status).toBe(200);
    const entry = added.json.entry as { id: string; kind: string; anchors: string[] };
    expect(entry).toMatchObject({ kind: "note", anchors: ["src/a.ts"] });
    expect(getMemoryGraph(repo.root).entries.map((e) => e.id)).toContain(entry.id);

    const res = await memoryDelete(
      new Request(`http://localhost/api/memory?repoKey=${repoKey}&entryId=${entry.id}`, { method: "DELETE" }),
    );
    expect(((await res.json()) as { removedAnchored: boolean }).removedAnchored).toBe(true);
    expect(getMemoryGraph(repo.root).entries.map((e) => e.id)).not.toContain(entry.id);
  });
});

describe("deliver: push only", () => {
  let repo: TmpRepo;
  let bare: string;
  beforeEach(() => {
    repo = makeTmpRepo({ "a.txt": "a\n" });
    repo.git("config", "user.name", "t");
    repo.git("config", "user.email", "t@t");
    bare = mkdtempSync(path.join(os.tmpdir(), "vb-bare-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    repo.git("remote", "add", "origin", bare);
    repo.git("push", "-q", "origin", "HEAD:refs/heads/main");
  });
  afterEach(() => {
    repo.cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  it("refuses a non-GitHub remote with a hint, then pushes the branch with pushOnly", async () => {
    repo.write("a.txt", "b\n");
    const refused = await deliver({ root: repo.root, title: "Fix a", body: "", token: null }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DeliverError);
    expect((refused as DeliverError).code).toBe("not_github");
    expect((refused as DeliverError).message).toMatch(/pushOnly/);

    const out = await deliver({ root: repo.root, title: "Fix a", body: "", token: null, pushOnly: true });
    expect(out).toMatchObject({ branch: "viberon/fix-a", prUrl: "", prNumber: 0, pushedOnly: true });
    const pushed = execFileSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/viberon/fix-a"], { encoding: "utf8" }).trim();
    expect(pushed).toBe(out.commit);
  });
});

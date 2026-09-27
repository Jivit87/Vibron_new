/** lib/git call reduction: one status for a delivery's checks, cached remote URLs. */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configuredRemoteUrl, invalidateGitReadCache, observeGitExec, projectRemote, repoSnapshot, runGit } from "@/lib/git";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

let repo: TmpRepo;
let calls: string[];

beforeEach(() => {
  repo = makeTmpRepo({ "a.txt": "a\n", "b.txt": "b\n" });
  invalidateGitReadCache();
  calls = [];
  observeGitExec((_cwd, args) => calls.push(args.join(" ")));
});

afterEach(() => {
  observeGitExec(null);
  repo.cleanup();
});

describe("repoSnapshot", () => {
  it("reads head, branch and every changed path from one git process", async () => {
    repo.git("branch", "-M", "main");
    writeFileSync(path.join(repo.root, "a.txt"), "changed\n");
    writeFileSync(path.join(repo.root, "new file.txt"), "n\n");
    repo.git("mv", "b.txt", "c.txt");
    calls.length = 0;
    const snap = await repoSnapshot(repo.root);
    expect(calls).toHaveLength(1);
    expect(snap.isRepo).toBe(true);
    expect(snap.branch).toBe("main");
    expect(snap.head).toBe(repo.git("rev-parse", "HEAD").trim());
    expect(snap.changed.sort()).toEqual(["a.txt", "b.txt", "c.txt", "new file.txt"]);
  });

  it("outside a repository and before the first commit", async () => {
    const plain = makeTmpRepo({ "x.txt": "x" }, { git: false });
    try {
      expect(await repoSnapshot(plain.root)).toMatchObject({ isRepo: false });
      plain.git("init", "-q");
      expect(await repoSnapshot(plain.root)).toMatchObject({ isRepo: true, head: null, changed: ["x.txt"] });
    } finally {
      plain.cleanup();
    }
  });
});

describe("configuredRemoteUrl", () => {
  it("answers every remote from one cached config read, never `remote get-url`", async () => {
    repo.git("remote", "add", "origin", "https://github.com/o/r.git");
    repo.git("config", "url./tmp/elsewhere.insteadOf", "https://github.com/o/r.git");
    expect(await projectRemote(repo.root)).toBe("origin");
    expect(await configuredRemoteUrl(repo.root, "origin")).toBe("https://github.com/o/r.git");
    expect(await configuredRemoteUrl(repo.root, "upstream")).toBeNull();
    expect(await configuredRemoteUrl(repo.root, "bad name")).toBeNull();
    expect(calls).toEqual(["config --get-regexp ^remote\\..*\\.url$"]);
  });

  it("a config change through runGit drops the cached answer", async () => {
    expect(await configuredRemoteUrl(repo.root, "upstream")).toBeNull();
    await runGit(repo.root, ["remote", "add", "upstream", "https://github.com/u/r.git"]);
    expect(await configuredRemoteUrl(repo.root, "upstream")).toBe("https://github.com/u/r.git");
    await runGit(repo.root, ["config", "remote.upstream.url", "https://github.com/u/x.git"]);
    expect(await configuredRemoteUrl(repo.root, "upstream")).toBe("https://github.com/u/x.git");
  });

  it("an edit made outside the app (a terminal `git remote add`) is seen at once", async () => {
    expect(await configuredRemoteUrl(repo.root, "origin")).toBeNull();
    repo.git("remote", "add", "origin", "git@github.com:o/r.git");
    expect(await configuredRemoteUrl(repo.root, "origin")).toBe("git@github.com:o/r.git");
  });
});

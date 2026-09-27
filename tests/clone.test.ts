import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as clonePost } from "@/app/api/clone/route";
import { GET as issueGet } from "@/app/api/issue/route";
import { fetchGitHubIssue } from "@/lib/github";
import { getGraph, getLocalWorkspace, resetMemoryStoreForTests } from "@/lib/store";
import { cloneToWorkspace, parseCloneTarget } from "@/lib/workspace/clone";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

async function bareRepo(): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), "viberon-clone-src-"));
  const work = path.join(base, "work");
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  await writeFile(path.join(work, "slug.py"), "def slugify(s):\n    return s.lower()\n");
  execFileSync("git", ["add", "-A"], { cwd: work });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: work, env: gitEnv });
  execFileSync("git", ["tag", "v1"], { cwd: work });
  const bare = path.join(base, "textkit.git");
  execFileSync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as Record<string, unknown>);
}

describe("parseCloneTarget", () => {
  it("accepts https, ssh, owner/repo and issue URLs", () => {
    expect(parseCloneTarget("https://github.com/acme/widget")).toMatchObject({
      cloneUrl: "https://github.com/acme/widget.git",
      owner: "acme",
      name: "widget",
    });
    expect(parseCloneTarget("https://github.com/acme/widget/tree/dev")?.name).toBe("widget");
    expect(parseCloneTarget("git@github.com:acme/widget.git")).toMatchObject({ owner: "acme", name: "widget" });
    expect(parseCloneTarget("ssh://git@gitlab.com/acme/widget.git")?.cloneUrl).toBe("ssh://git@gitlab.com/acme/widget.git");
    expect(parseCloneTarget("acme/widget")?.cloneUrl).toBe("https://github.com/acme/widget.git");
    expect(parseCloneTarget("https://github.com/acme/widget/issues/42")).toMatchObject({
      cloneUrl: "https://github.com/acme/widget.git",
      issueUrl: "https://github.com/acme/widget/issues/42",
    });
  });

  it("rejects option injection, shell metacharacters, credentials and local paths", () => {
    for (const bad of [
      "--upload-pack=touch /tmp/x",
      "-c core.sshCommand=x a/b",
      "https://github.com/a/b;rm -rf ~",
      "https://user:pw@github.com/a/b",
      "ext::sh -c touch% /tmp/pwned",
      "file:///etc",
      "/tmp/repo",
      "../../etc/passwd",
      "https://github.com/onlyowner",
    ]) {
      expect(parseCloneTarget(bad), bad).toBeNull();
    }
    expect(parseCloneTarget("/tmp/some/repo.git", { allowLocal: true })?.name).toBe("repo");
  });
});

describe("clone to workspace", () => {
  let reposDir: string;
  beforeEach(async () => {
    resetMemoryStoreForTests();
    reposDir = await mkdtemp(path.join(os.tmpdir(), "viberon-repos-"));
    process.env.VIBERON_REPOS_DIR = reposDir;
    process.env.VIBERON_ALLOW_LOCAL_CLONE = "1";
  });
  afterEach(() => {
    delete process.env.VIBERON_REPOS_DIR;
    delete process.env.VIBERON_ALLOW_LOCAL_CLONE;
  });

  it("clones a local bare repo over SSE, registers it and indexes the graph; reuses on second clone", async () => {
    const bare = await bareRepo();
    const response = await clonePost(
      new Request("http://localhost/api/clone", {
        method: "POST",
        body: JSON.stringify({ url: bare, setup: false }),
      }),
    );
    const events = await readSse(response);
    const done = events.find((e) => e.type === "done")!;
    expect(events.some((e) => e.type === "progress")).toBe(true);
    expect(done).toMatchObject({ label: "local/textkit", rootPath: path.join(reposDir, "local__textkit") });
    const repoKey = done.repoKey as string;
    expect((await getLocalWorkspace(repoKey))?.rootPath).toBe(done.rootPath);
    expect((await getGraph(repoKey))?.nodes.map((n) => n.name)).toEqual(["slugify"]);
    const exclude = await readFile(path.join(done.rootPath as string, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("/.viberon/");

    const again = await cloneToWorkspace(bare, { allowLocal: true, ref: "v1" });
    expect(again.reused).toBe(true);
    expect(again.repoKey).toBe(repoKey);
  });

  it("includes the environment probe in the SSE done event", async () => {
    const bare = await bareRepo();
    const events = await readSse(
      await clonePost(
        new Request("http://localhost/api/clone", {
          method: "POST",
          body: JSON.stringify({ url: bare, setup: false }),
        }),
      ),
    );
    const done = events.find((e) => e.type === "done")!;
    expect(done.probe).toMatchObject({
      primaryLanguage: "Python",
      testFramework: "pytest",
      testCommand: "python -m pytest -q",
    });
  });

  it("reports errors as SSE and fetches the issue for issue URLs", async () => {
    const bad = await readSse(
      await clonePost(
        new Request("http://localhost/api/clone", {
          method: "POST",
          body: JSON.stringify({ url: "/nonexistent/repo.git", setup: false }),
        }),
      ),
    );
    expect(bad.at(-1)).toMatchObject({ type: "error" });
    expect(String(bad.at(-1)!.message)).toContain("git clone failed");
    expect(existsSync(path.join(reposDir, "local__repo"))).toBe(false);

    const invalid = await clonePost(
      new Request("http://localhost/api/clone", { method: "POST", body: JSON.stringify({ url: "--help" }) }),
    );
    expect(invalid.status).toBe(400);

    const fakeFetch = (async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/acme/widget/issues/7");
      return new Response(JSON.stringify({ title: "Crash", body: "trace", html_url: "https://github.com/acme/widget/issues/7" }));
    }) as unknown as typeof fetch;
    expect(await fetchGitHubIssue("https://github.com/acme/widget/issues/7", fakeFetch)).toEqual({
      title: "Crash",
      body: "trace",
      url: "https://github.com/acme/widget/issues/7",
    });
    const badIssue = await issueGet(new Request("http://localhost/api/issue?url=https://example.com/x"));
    expect(badIssue.status).toBe(400);
  });
});

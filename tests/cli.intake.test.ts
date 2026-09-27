import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCliArgs } from "@/cli/viberon";
import { issueUrlFromSpec, resolveTask } from "@/lib/headless/run";

const fakeIssue = async (url: string) => ({
  title: "Crash on empty input",
  body: "Stack trace…",
  url,
  number: 7,
  comments: [],
});

describe("issue intake (Pramana repo/issue.py formats)", () => {
  it("run accepts --issue as an alternative to --task", () => {
    expect(parseCliArgs(["run", "--repo", "/r", "--issue", "acme/app#7"])).toMatchObject({ task: "acme/app#7" });
    expect(() => parseCliArgs(["run", "--repo", "/r", "--issue", "a", "--task", "b"])).toThrow(/only one/);
    expect(parseCliArgs(["run", "--repo", "/r", "--task", "-"])).toMatchObject({ task: "-" });
  });

  it("owner/repo#N and issue URLs name GitHub issues; text does not", () => {
    expect(issueUrlFromSpec("acme/app#7")).toBe("https://github.com/acme/app/issues/7");
    expect(issueUrlFromSpec("https://github.com/acme/app/issues/7")).toBe("https://github.com/acme/app/issues/7");
    expect(issueUrlFromSpec("fix acme/app#7 please")).toBeNull();
    expect(issueUrlFromSpec("the parser crashes")).toBeNull();
  });

  it("fetches owner/repo#N, reads stdin for -, reads files, and passes text through", async () => {
    const fetched: string[] = [];
    const fetchIssue = async (url: string) => {
      fetched.push(url);
      return fakeIssue(url);
    };
    expect(await resolveTask({ task: "acme/app#7" }, fetchIssue)).toBe(
      "Crash on empty input\n\nStack trace…\n\n(Issue: https://github.com/acme/app/issues/7)",
    );
    expect(fetched).toEqual(["https://github.com/acme/app/issues/7"]);

    expect(await resolveTask({ task: "-" }, fetchIssue, async () => "  from stdin\n")).toBe("from stdin");

    const dir = await mkdtemp(path.join(os.tmpdir(), "viberon-intake-"));
    const md = path.join(dir, "issue.md");
    await writeFile(md, "# Title\n\nBody\n");
    expect(await resolveTask({ task: md }, fetchIssue)).toBe("# Title\n\nBody");
    const json = path.join(dir, "row.json");
    await writeFile(json, JSON.stringify({ instance_id: "x", problem_statement: "Problem text" }));
    expect(await resolveTask({ task: json }, fetchIssue)).toBe("Problem text");
    expect(await resolveTask({ taskFile: json }, fetchIssue)).toBe("Problem text");

    expect(await resolveTask({ task: "just fix the bug" }, fetchIssue)).toBe("just fix the bug");
    await expect(resolveTask({ task: "-" }, fetchIssue, async () => "")).rejects.toThrow(/task is required/);
  });
});

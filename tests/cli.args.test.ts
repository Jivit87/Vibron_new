import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CliError, parseCliArgs } from "@/cli/viberon";

describe("parseCliArgs", () => {
  it("parses run with all options", () => {
    expect(
      parseCliArgs([
        "run",
        "--repo",
        "/r",
        "--task=fix it",
        "--worktree",
        "--out",
        "/o",
        "--test-cmd",
        "npm test",
        "--max-turns",
        "12",
        "--timeout",
        "300",
        "--model",
        "openai:gpt-x",
        "--json",
        "--no-gate",
      ]),
    ).toEqual({
      command: "run",
      repo: "/r",
      task: "fix it",
      taskFile: undefined,
      taskId: undefined,
      worktree: true,
      keepWorktree: false,
      out: "/o",
      testCmd: "npm test",
      noGate: true,
      maxTurns: 12,
      timeoutSec: 300,
      model: "openai:gpt-x",
      json: true,
    });
  });

  it("parses clone and eval, and help", () => {
    expect(parseCliArgs(["clone", "acme/widget", "--ref", "v1", "--depth", "1", "--setup"])).toEqual({
      command: "clone",
      url: "acme/widget",
      ref: "v1",
      depth: 1,
      setup: true,
      json: false,
    });
    expect(parseCliArgs(["eval", "--only", "slugify, semver-js"])).toMatchObject({
      command: "eval",
      only: ["slugify", "semver-js"],
    });
    expect(parseCliArgs([])).toEqual({ command: "help" });
    expect(parseCliArgs(["run", "--help"])).toEqual({ command: "help" });
  });

  it("parses an arena report input", () => {
    expect(parseCliArgs(["arena", "report", "results/sonnet.jsonl", "--json"])).toEqual({
      command: "arena",
      action: "report",
      file: "results/sonnet.jsonl",
      json: true,
    });
  });

  it("enables the blind test writer only when requested", () => {
    expect(parseCliArgs(["run", "--repo", "/r", "--task", "fix", "--independent-test"]))
      .toMatchObject({ command: "run", independentTest: true });
  });

  it("rejects bad input", () => {
    expect(() => parseCliArgs(["run", "--task", "x"])).toThrow(CliError);
    expect(() => parseCliArgs(["run", "--repo", "r"])).toThrow(/--task/);
    expect(() => parseCliArgs(["run", "--repo", "r", "--task", "a", "--task-file", "f"])).toThrow(/only one/);
    expect(() => parseCliArgs(["run", "--repo", "r", "--task", "a", "--max-turns", "zero"])).toThrow(/positive/);
    expect(() => parseCliArgs(["run", "--repo", "r", "--task", "a", "--bogus", "1"])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(["run", "--repo"])).toThrow(/needs a value/);
    expect(() => parseCliArgs(["deploy"])).toThrow(/Unknown command/);
  });
});

describe("bin/viberon", () => {
  const bin = path.resolve(__dirname, "..", "bin", "viberon");

  it("runs from any cwd: help exits 0, a bad run exits 2 with a result.json", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "viberon-cli-"));
    const help = spawnSync(bin, ["help"], { cwd, encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("viberon run --repo");

    const out = path.join(cwd, "out");
    const bad = spawnSync(bin, ["run", "--repo", path.join(cwd, "missing"), "--task", "x", "--out", out, "--json"], {
      cwd,
      encoding: "utf8",
    });
    expect(bad.status).toBe(2);
    const result = JSON.parse(readFileSync(path.join(out, "result.json"), "utf8"));
    expect(result).toMatchObject({ schemaVersion: 1, status: "error", exitCode: 2 });
    expect(JSON.parse(bad.stdout).error).toContain("Repository not found");
    // Headless never writes the dev store into the cwd.
    expect(existsSync(path.join(cwd, ".viberon-dev-store.json"))).toBe(false);

    const usage = spawnSync(bin, ["run"], { cwd, encoding: "utf8" });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain("--repo is required");
  }, 60_000);
});

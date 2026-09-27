/**
 * Pramana `tools/shell.py` parity: agent denylist, non-interactive env,
 * model-facing output cleanup and head+tail truncation.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { classifyAgentCommand, classifyCommand, runCommand } from "@/lib/terminal";
import { cleanTerminalOutput, trimHeadTail } from "@/lib/terminal/output";

describe("agent denylist", () => {
  it.each([
    "git push",
    "git push origin main --force",
    "git -C repo push",
    "npm test && git push",
    "echo $(git push)",
    "git clean -fdx",
    "git clean -f",
    "sudo ls",
    "rm -rf /",
    "rm -rf ~",
    "mkfs.ext4 /dev/sda1",
    "shutdown -h now",
    ":(){ :|:& };:",
  ])("blocks %s", (cmd) => {
    expect(classifyAgentCommand(cmd).allowed).toBe(false);
  });

  it.each(["git status", "git log --grep push", "git commit -m 'push fix'", "git clean -n", "pytest -x"])(
    "allows %s",
    (cmd) => {
      expect(classifyAgentCommand(cmd).allowed).toBe(true);
    },
  );

  it("does not block git push for the user's own terminal", () => {
    expect(classifyCommand("git push").allowed).toBe(true);
  });

  it("refuses a denied agent command before spawning", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "vb-parity-"));
    const res = await runCommand({ repoKey: "t", cwd, command: "git push", origin: "agent" });
    expect(res.status).toBe("failed");
    expect(res.output).toContain("[blocked:");
  });
});

describe("agent environment", () => {
  it("is non-interactive and carries no API keys", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "vb-parity-"));
    const out = path.join(cwd, "env.txt");
    process.env.AI_API_KEY = "sk-secret";
    try {
      await runCommand({ repoKey: "t", cwd, command: `env > ${out}`, origin: "agent" });
    } finally {
      delete process.env.AI_API_KEY;
    }
    const env = readFileSync(out, "utf8");
    expect(env).not.toContain("sk-secret");
    for (const kv of ["GIT_TERMINAL_PROMPT=0", "PAGER=cat", "GIT_EDITOR=true", "PYTHONUNBUFFERED=1"]) {
      expect(env).toContain(kv);
    }
  });

  it("closes stdin for agents, so a prompt fails fast instead of hanging", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "vb-parity-"));
    const res = await runCommand({ repoKey: "t", cwd, command: "read x; echo got:$?", origin: "agent", timeoutMs: 5000 });
    expect(res.output).toContain("got:1");
    expect(res.timedOut).toBe(false);
  });

  it("kills the whole group on timeout and reports it", async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "vb-parity-"));
    const res = await runCommand({ repoKey: "t", cwd, command: "sleep 30", origin: "agent", timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
    expect(res.status).toBe("killed");
  });
});

describe("model-facing output", () => {
  it("collapses progress bars and strips ANSI (measured saving)", () => {
    const bar = Array.from({ length: 200 }, (_, i) => `\x1b[32m${"#".repeat(i % 50)}\x1b[0m ${i}%`).join("\r");
    const raw = `Collecting foo\n${bar}\nInstalled foo\n`;
    const clean = cleanTerminalOutput(raw);
    expect(clean).toBe("Collecting foo\n################################################# 199%\nInstalled foo\n");
    // 200 redraws → 1 line: >95% fewer characters reach the model.
    expect(clean.length / raw.length).toBeLessThan(0.05);
  });

  it("keeps head and tail with an actionable marker", () => {
    const text = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const { output, truncated, omittedLines } = trimHeadTail(text, 1000);
    expect(truncated).toBe(true);
    expect(omittedLines).toBeGreaterThan(1800);
    expect(output.startsWith("line 0\n")).toBe(true);
    expect(output.endsWith("line 1999")).toBe(true);
    expect(output).toContain("Narrow the command");
    expect(output.length).toBeLessThan(1200);
  });
});

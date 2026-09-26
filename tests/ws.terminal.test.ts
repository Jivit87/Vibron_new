import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runRunCommand } from "@/lib/harness/workspace-services";
import {
  getSession,
  killSession,
  killSessionsByRun,
  runCommand,
  serializeSession,
  startCommand,
  waitFor,
  writeInput,
} from "@/lib/terminal";

const posix = process.platform !== "win32";
const cwd = mkdtempSync(path.join(tmpdir(), "vb-term-"));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

describe.runIf(posix)("terminal sessions", () => {
  it("runs a command and records exit code, origin and offsets", async () => {
    const result = await runCommand({ repoKey: "t", command: "echo hi", cwd, origin: "agent", runId: "r0" });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hi");
    const session = getSession(result.sessionId)!;
    const json = serializeSession(session);
    expect(json.origin).toBe("agent");
    expect(json.runId).toBe("r0");
    expect(json.offset).toBe(json.output.length);
    expect(session.chunks.at(-1)!.offset).toBe(session.buffer.end);
  });

  it("runs agent commands with the repo's virtualenv first on PATH", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "vb-venv-"));
    const bin = path.join(repo, ".venv", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "python"), "#!/bin/sh\necho venv-python\n");
    chmodSync(path.join(bin, "python"), 0o755);
    // The same runner the agent's run_command and the gate's checks use.
    const agent = await runRunCommand({ repoKey: "t", command: "python", cwd: repo, runId: "r-venv" });
    expect(agent.exitCode).toBe(0);
    expect(agent.output).toContain("venv-python");
  });

  it("does not leak API keys into child processes", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-leak-test";
    try {
      const out = path.join(cwd, "env.txt");
      await runCommand({ repoKey: "t", command: `env > ${out}`, cwd });
      expect(readFileSync(out, "utf8")).not.toContain("sk-ant-leak-test");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("kills the whole process group, not just the shell", async () => {
    const pidFile = path.join(cwd, "grandchild.pid");
    const session = startCommand({
      repoKey: "t",
      cwd,
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
    });
    await until(() => {
      try {
        return readFileSync(pidFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    });
    const grandchild = Number(readFileSync(pidFile, "utf8").trim());
    expect(alive(grandchild)).toBe(true);
    expect(killSession(session.id)).toBe(true);
    await waitFor(session, 5000);
    expect(await until(() => !alive(grandchild))).toBe(true);
    expect(session.status).toBe("killed");
  });

  it("killSessionsByRun only kills that run's sessions", async () => {
    const a = startCommand({ repoKey: "t", cwd, command: "sleep 30", runId: "run-a" });
    const b = startCommand({ repoKey: "t", cwd, command: "sleep 30", runId: "run-b" });
    expect(killSessionsByRun("run-a")).toBe(1);
    await waitFor(a, 5000);
    expect(a.status).toBe("killed");
    expect(b.status).toBe("running");
    killSession(b.id);
    await waitFor(b, 5000);
  });

  it("aborting the signal kills the command", async () => {
    const controller = new AbortController();
    const pending = runCommand({ repoKey: "t", cwd, command: "sleep 30", signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.status).toBe("killed");
  });

  it("accepts stdin for user sessions and refuses hard-blocked lines", async () => {
    const session = startCommand({ repoKey: "t", cwd, command: "cat", origin: "user" });
    expect(writeInput(session.id, "hello\n")).toEqual({ ok: true });
    await until(() => session.buffer.toString().includes("hello\n"));
    expect(session.buffer.toString()).toContain("hello");
    const refused = writeInput(session.id, "rm -rf ~\n");
    expect(refused.ok).toBe(false);
    killSession(session.id);
    await waitFor(session, 5000);

    const agent = startCommand({ repoKey: "t", cwd, command: "sleep 5", origin: "agent" });
    expect(writeInput(agent.id, "x").ok).toBe(false);
    killSession(agent.id);
    await waitFor(agent, 5000);
  });

  it("resumes from an offset", async () => {
    const result = await runCommand({ repoKey: "t", cwd, command: "printf abc; printf def" });
    const session = getSession(result.sessionId)!;
    const full = session.buffer.toString();
    const mid = full.indexOf("def");
    expect(session.buffer.since(mid)).toEqual({ text: full.slice(mid), complete: true });
  });
});

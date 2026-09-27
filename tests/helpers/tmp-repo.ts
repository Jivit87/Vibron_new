/**
 * Temporary on-disk repositories for harness tests (snapshot, gate, solve).
 */

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CheckRunner } from "@/lib/harness/gate";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

export interface TmpRepo {
  root: string;
  write(file: string, content: string): void;
  read(file: string): string;
  git(...args: string[]): string;
  cleanup(): void;
}

export function makeTmpRepo(files: Record<string, string>, options: { git?: boolean } = {}): TmpRepo {
  const root = mkdtempSync(path.join(os.tmpdir(), "viberon-test-"));
  const write = (file: string, content: string) => {
    const abs = path.join(root, file);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [file, content] of Object.entries(files)) write(file, content);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: GIT_ENV, encoding: "utf8" });
  if (options.git !== false) {
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  }
  return {
    root,
    write,
    read: (file) => readFileSync(path.join(root, file), "utf8"),
    git,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A verifier that runs commands with bash (tests only). */
export const shellRunner: CheckRunner = (command, { cwd, timeoutMs }) =>
  // Async (not spawnSync): a blocking runner would serialize checks the gate runs concurrently.
  new Promise((resolve) => {
    const started = Date.now();
    execFile("bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : error ? 1 : 0;
      resolve({
        exitCode: (error as { killed?: boolean } | null)?.killed ? null : code,
        output: `${stdout ?? ""}${stderr ?? ""}`,
        timedOut: Boolean((error as { killed?: boolean } | null)?.killed),
        durationMs: Date.now() - started,
      });
    });
  });

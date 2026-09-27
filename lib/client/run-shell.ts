"use client";

/**
 * Run a shell command in a new terminal tab of the open workspace, and the
 * dependency-install hint shown when checks fail on a fresh clone.
 */

import { toast } from "sonner";

import { useViberon, type TerminalSessionView } from "@/store/viberon";

export async function runShell(repoKey: string, command: string, cwd?: string): Promise<void> {
  const store = useViberon.getState();
  if (!store.rootPath) {
    toast.error("Open a local folder to run commands.");
    return;
  }
  store.setAppMode("ide");
  store.setBottomPanel("terminal");

  const response = await fetch("/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey, command, ...(cwd ? { cwd } : {}) }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not run that command.");
    return;
  }
  const session = (await response.json()) as TerminalSessionView;
  useViberon.getState().upsertTerminal(session);
}

const MISSING_DEPS =
  /cannot find module|module not found|modulenotfounderror|no module named|node_modules.*(missing|not found)|not installed|command not found: (tsc|eslint|vitest|jest|pytest)|missing dependenc/i;

/** Whether checker output reads like the workspace's dependencies are not installed. */
export function looksLikeMissingDeps(texts: readonly (string | undefined)[]): boolean {
  return texts.some((t) => Boolean(t && MISSING_DEPS.test(t)));
}

/** The install command for the workspace, from its lockfile or manifest. */
export function installCommand(files: readonly string[]): string {
  const has = (name: string) => files.includes(name);
  if (has("pnpm-lock.yaml")) return "pnpm install";
  if (has("yarn.lock")) return "yarn install";
  if (has("bun.lockb") || has("bun.lock")) return "bun install";
  if (has("package.json")) return "npm install";
  if (has("uv.lock")) return "uv sync";
  if (has("poetry.lock")) return "poetry install";
  if (has("requirements.txt")) return "pip install -r requirements.txt";
  if (has("pyproject.toml")) return "pip install -e .";
  if (has("Cargo.toml")) return "cargo fetch";
  if (has("go.mod")) return "go mod download";
  return "npm install";
}

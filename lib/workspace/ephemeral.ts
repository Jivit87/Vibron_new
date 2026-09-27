/**
 * Ephemeral workspaces: an issue fix runs in a throwaway `git worktree`, and
 * registering it like a real workspace used to copy every file, the file
 * index and the symbol graph of that checkout into the persisted dev store
 * (the disk store / Firestore) — once per issue, never removed.
 *
 * A root registered here keeps all its store entries (`<kind>:<repoKey>`)
 * in process memory only. They are dropped when the worktree is released, or
 * by a periodic sweep once its folder is gone (the task removed it).
 *
 * Dependency-free on purpose: `lib/store` consults it on every read/write.
 */

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** `mkdtemp` prefix of issue worktrees (`<tmp>/viberon-issue-XXXX/repo`). */
export const ISSUE_WORKTREE_PREFIX = "viberon-issue-";

const SWEEP_MS = 15_000;
const roots = new Map<string, string>();
const releaseListeners = new Set<(repoKey: string, rootPath: string) => void>();
let sweeper: ReturnType<typeof setInterval> | null = null;

function realTmp(): string {
  try {
    return realpathSync(os.tmpdir());
  } catch {
    return path.resolve(os.tmpdir());
  }
}

/** True for the folder `createIssueWorktree` makes: `<tmpdir>/viberon-issue-*\/repo`. */
export function isIssueWorktreeRoot(rootPath: string): boolean {
  const resolved = path.resolve(rootPath);
  const holder = path.dirname(resolved);
  if (!path.basename(holder).startsWith(ISSUE_WORKTREE_PREFIX)) return false;
  const parent = path.dirname(holder);
  let realParent = parent;
  try {
    realParent = realpathSync(parent);
  } catch {
    // Missing parent: compare as given.
  }
  return realParent === realTmp() || parent === path.resolve(os.tmpdir());
}

/** Keep `repoKey`'s store entries in memory only, until released. */
export function registerEphemeralWorkspace(repoKey: string, rootPath: string): void {
  roots.set(repoKey, path.resolve(rootPath));
  if (!sweeper) {
    sweeper = setInterval(sweepEphemeralWorkspaces, SWEEP_MS);
    sweeper.unref?.();
  }
}

export function isEphemeralRepoKey(repoKey: string): boolean {
  return roots.has(repoKey);
}

/** Whether a store key (`graph:<repoKey>`, `raw:<repoKey>`, …) belongs to an ephemeral workspace. */
export function isEphemeralStoreKey(key: string): boolean {
  if (!roots.size) return false;
  const colon = key.indexOf(":");
  return colon >= 0 && roots.has(key.slice(colon + 1));
}

/** Drop the workspace and everything the store held for it. */
export function releaseEphemeralWorkspace(repoKey: string): void {
  const rootPath = roots.get(repoKey);
  if (rootPath === undefined || !roots.delete(repoKey)) return;
  for (const listener of releaseListeners) listener(repoKey, rootPath);
  if (!roots.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

/** Release every ephemeral workspace whose folder no longer exists. Returns how many. */
export function sweepEphemeralWorkspaces(): number {
  let released = 0;
  for (const [repoKey, rootPath] of [...roots]) {
    if (existsSync(rootPath)) continue;
    releaseEphemeralWorkspace(repoKey);
    released += 1;
  }
  return released;
}

/** Folders of this process's live ephemeral workspaces (the CLI cleans them on Ctrl-C). */
export function ephemeralWorkspaceRoots(): string[] {
  return [...roots.values()];
}

export function ephemeralWorkspaceCount(): number {
  return roots.size;
}

/** The store subscribes to drop a released workspace's entries. */
export function onEphemeralRelease(listener: (repoKey: string, rootPath: string) => void): () => void {
  releaseListeners.add(listener);
  return () => releaseListeners.delete(listener);
}

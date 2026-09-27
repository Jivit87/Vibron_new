import {
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import type { LocalWorkspaceMeta, StoredRawFile } from "@/lib/graph";
import { repoKey as makeRepoKey } from "@/lib/ids";
import { countTokensCached } from "@/lib/tokens";
import {
  getFileInfo,
  getLocalWorkspace,
  getRawFiles,
  putFileInfo,
  putGraph,
  putLocalWorkspace,
  putRawFiles,
} from "@/lib/store";
import { timeSlicer } from "@/lib/workers/yield";
import {
  ensureViberonDir,
  indexWorkspaceFiles,
  patchIndexedFile,
  type IndexStats,
} from "@/lib/workspace/graph-index";
import { isIssueWorktreeRoot, registerEphemeralWorkspace } from "@/lib/workspace/ephemeral";

export const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".turbo",
  ".vercel",
  ".viberon",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".eggs",
  ".gradle",
  ".idea",
  ".cache",
  "coverage",
  "dist",
  "build",
  "target",
  "out",
  "node_modules",
  "bower_components",
]);

/** Hard cap on scanned files so a monorepo cannot stall indexing. */
export const MAX_SCAN_FILES = 20_000;
/**
 * Hard cap on the total source read by one scan. Past it the workspace gets
 * a partial listing and graph (`lastIndexStats.truncated`) instead of the
 * server spending minutes and gigabytes on it.
 */
export const MAX_SCAN_BYTES = 96 * 1024 * 1024;

export interface ScanOptions {
  signal?: AbortSignal;
}

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cfg",
  ".cjs",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".gradle",
  ".h",
  ".hpp",
  ".html",
  ".ini",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mjs",
  ".mod",
  ".php",
  ".properties",
  ".py",
  ".pyi",
  ".rb",
  ".rs",
  ".rst",
  ".scss",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const TEXT_FILENAMES = new Set([
  ".gitignore",
  "Dockerfile",
  "Gemfile",
  "LICENSE",
  "Makefile",
  "README",
  "go.sum",
  "gradlew",
  "setup.cfg",
]);

const MAX_TEXT_FILE_BYTES = 1024 * 1024;

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export function defaultLocalWorkspaceRoot(): string {
  const base = process.env.VIBERON_STORE_DIR || process.cwd();
  return path.join(base, ".viberon-workspace");
}

export function repoRefForLocalWorkspace(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  const label = path.basename(resolved) || "workspace";
  return `local/${label}@${makeRepoKey(`local:${resolved}`)}`;
}

export function repoKeyForLocalWorkspace(rootPath: string): string {
  return makeRepoKey(repoRefForLocalWorkspace(rootPath));
}

export function resolveWorkspaceFilePath(
  rootPath: string,
  filePath: string,
): string {
  if (!filePath || path.isAbsolute(filePath)) {
    throw new WorkspacePathError("File path must be relative to the workspace.");
  }

  const root = path.resolve(rootPath);
  const resolved = path.resolve(root, filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new WorkspacePathError("File path escapes the workspace.");
  }
  return resolved;
}

export async function registerLocalWorkspace(
  rootPath: string,
  overrides: Partial<Pick<LocalWorkspaceMeta, "repoKey" | "repoRef" | "label">> = {},
  options: ScanOptions = {},
): Promise<LocalWorkspaceMeta> {
  const resolvedRoot = path.resolve(rootPath);
  const info = await stat(resolvedRoot);
  if (!info.isDirectory()) {
    throw new WorkspacePathError("Workspace root must be a directory.");
  }

  const repoRef = overrides.repoRef ?? repoRefForLocalWorkspace(resolvedRoot);
  const repoKey = overrides.repoKey ?? makeRepoKey(repoRef);
  // Re-opening a folder keeps the name it was registered under (a clone's
  // `owner/name`, not its `owner__name` folder).
  const previous = overrides.label ? null : await getLocalWorkspace(repoKey);
  const meta: LocalWorkspaceMeta = {
    repoKey,
    repoRef,
    label: overrides.label ?? (previous?.rootPath === resolvedRoot ? previous.label : null) ?? path.basename(resolvedRoot) ?? "Workspace",
    rootPath: resolvedRoot,
    registeredAt: Date.now(),
  };

  // An issue worktree is throwaway: its files, index and graph stay in
  // memory and go with it, never into the persisted store.
  if (isIssueWorktreeRoot(resolvedRoot)) registerEphemeralWorkspace(repoKey, resolvedRoot);
  await putLocalWorkspace(meta);
  // `.viberon/` holds the graph cache and memory; keep it out of any diff.
  await ensureViberonDir(resolvedRoot).catch(() => undefined);
  await refreshLocalWorkspace(meta.repoKey, options);
  return meta;
}

export async function refreshLocalWorkspace(repoKey: string, options: ScanOptions = {}): Promise<StoredRawFile[]> {
  const meta = await getLocalWorkspace(repoKey);
  if (!meta) {
    throw new WorkspacePathError(`Local workspace not found for ${repoKey}.`);
  }

  const scan = await scanLocalWorkspaceDetailed(meta.rootPath, options);
  await persistWorkspaceFiles(meta, scan.files, { ...options, truncated: scan.truncated });
  return scan.files;
}

export async function listLocalWorkspaceFiles(repoKey: string): Promise<StoredRawFile[]> {
  return refreshLocalWorkspace(repoKey);
}

export async function readLocalWorkspaceFile(
  repoKey: string,
  filePath: string,
): Promise<StoredRawFile | null> {
  const meta = await getLocalWorkspace(repoKey);
  if (!meta) return null;
  const absolutePath = resolveWorkspaceFilePath(meta.rootPath, filePath);
  try {
    const source = await readFile(absolutePath, "utf8");
    return { path: filePath, source };
  } catch {
    return null;
  }
}

export async function writeLocalWorkspaceFile(
  repoKey: string,
  filePath: string,
  source: string,
): Promise<StoredRawFile> {
  const meta = await getLocalWorkspace(repoKey);
  if (!meta) {
    throw new WorkspacePathError(`Local workspace not found for ${repoKey}.`);
  }

  const absolutePath = resolveWorkspaceFilePath(meta.rootPath, filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, source, "utf8");
  await patchWorkspaceFile(meta.repoKey, meta.rootPath, meta.repoRef, filePath, source);
  return { path: filePath, source };
}

/** Last full-index stats per repoKey, for diagnostics and tests. */
export const lastIndexStats = new Map<string, IndexStats>();

async function persistWorkspaceFiles(
  meta: LocalWorkspaceMeta,
  files: StoredRawFile[],
  options: ScanOptions & { truncated?: boolean } = {},
): Promise<void> {
  const { graph, stats } = await indexWorkspaceFiles(meta.repoKey, meta.rootPath, meta.repoRef, files, options);
  lastIndexStats.set(meta.repoKey, options.truncated ? { ...stats, truncated: true } : stats);
  const fileInfo = await tokenIndex(files, options.signal);
  // Raw sources stay on disk: the store derives them (no putRawFiles).
  await Promise.all([putGraph(meta.repoKey, graph), putFileInfo(meta.repoKey, fileInfo)]);
}

/** Token counts of every file, yielding to the event loop as it goes. */
export async function tokenIndex(
  files: StoredRawFile[],
  signal?: AbortSignal,
): Promise<{ path: string; tokenCount: number }[]> {
  const tick = timeSlicer();
  const out: { path: string; tokenCount: number }[] = [];
  for (const file of files) {
    await tick(signal);
    out.push({ path: file.path, tokenCount: countTokensCached(file.source) });
  }
  return out;
}

/**
 * Incremental update after one file changed (`source === null`: deleted).
 * Re-parses only that file and splices it into the stored graph, raw-file
 * list and token index. No directory scan, no whole-repo parse.
 */
export async function patchWorkspaceFile(
  repoKey: string,
  rootPath: string | null,
  repoRef: string,
  filePath: string,
  source: string | null,
): Promise<void> {
  let graph = await patchIndexedFile(repoKey, rootPath, filePath, source);
  if (!graph) {
    // No index yet (or resolution config changed): build one. Unchanged
    // files are still reused from the persisted cache.
    let files = rootPath ? await scanLocalWorkspace(rootPath) : await getRawFiles(repoKey);
    if (!rootPath) {
      files = files.filter((file) => file.path !== filePath);
      if (source !== null) files.push({ path: filePath, source });
    }
    graph = (await indexWorkspaceFiles(repoKey, rootPath, repoRef, files)).graph;
  }
  const info = await getFileInfo(repoKey);
  const nextInfo = info.filter((file) => file.path !== filePath);
  if (source !== null) nextInfo.push({ path: filePath, tokenCount: countTokensCached(source) });
  if (rootPath) {
    // The file itself is already on disk; only the graph and token index change.
    await Promise.all([putGraph(repoKey, graph), putFileInfo(repoKey, nextInfo)]);
    return;
  }
  const raw = await getRawFiles(repoKey);
  const nextRaw = raw.filter((file) => file.path !== filePath);
  if (source !== null) {
    nextRaw.push({ path: filePath, source });
    nextRaw.sort((a, b) => a.path.localeCompare(b.path));
  }
  await Promise.all([
    putGraph(repoKey, graph),
    putRawFiles(repoKey, nextRaw),
    putFileInfo(repoKey, nextInfo),
  ]);
}

export async function scanLocalWorkspace(rootPath: string, options: ScanOptions = {}): Promise<StoredRawFile[]> {
  return (await scanLocalWorkspaceDetailed(rootPath, options)).files;
}

/** `scanLocalWorkspace` plus whether a cap cut the listing short. */
export async function scanLocalWorkspaceDetailed(
  rootPath: string,
  options: ScanOptions = {},
): Promise<{ files: StoredRawFile[]; truncated: boolean }> {
  const root = path.resolve(rootPath);
  const files: StoredRawFile[] = [];
  const tick = timeSlicer();
  let bytes = 0;
  let truncated = false;
  const full = () => {
    if (files.length >= MAX_SCAN_FILES || bytes >= MAX_SCAN_BYTES) truncated = true;
    return truncated;
  };

  async function visit(dir: string): Promise<void> {
    if (full()) return;
    options.signal?.throwIfAborted();
    const entries = await readdir(dir, { withFileTypes: true });
    // Any virtualenv, whatever it is called (`env/`, `.venv-3.11/`, …).
    if (dir !== root && entries.some((e) => e.isFile() && e.name === "pyvenv.cfg")) return;
    for (const entry of entries) {
      if (full()) return;
      await tick(options.signal);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.endsWith(".egg-info")) continue;
        await visit(path.join(dir, entry.name));
        continue;
      }

      if (!entry.isFile()) continue;
      const absolutePath = path.join(dir, entry.name);
      const relativePath = toPosixPath(path.relative(root, absolutePath));
      if (!shouldReadTextFile(relativePath)) continue;
      const info = await stat(absolutePath);
      if (info.size > MAX_TEXT_FILE_BYTES) continue;
      const source = await readFile(absolutePath, "utf8");
      if (source.includes("\0")) continue;
      bytes += source.length;
      files.push({ path: relativePath, source });
    }
  }

  await visit(root);
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
}

function shouldReadTextFile(filePath: string): boolean {
  const name = path.basename(filePath);
  if (name === ".env" || name.startsWith(".env.")) {
    return name.endsWith(".example");
  }
  if (TEXT_FILENAMES.has(name)) return true;
  return TEXT_EXTENSIONS.has(path.extname(name));
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

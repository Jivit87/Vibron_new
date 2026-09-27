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
import { countTokens } from "@/lib/tokens";
import {
  getFileInfo,
  getLocalWorkspace,
  getRawFiles,
  putFileInfo,
  putGraph,
  putLocalWorkspace,
  putRawFiles,
} from "@/lib/store";
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
): Promise<LocalWorkspaceMeta> {
  const resolvedRoot = path.resolve(rootPath);
  const info = await stat(resolvedRoot);
  if (!info.isDirectory()) {
    throw new WorkspacePathError("Workspace root must be a directory.");
  }

  const repoRef = overrides.repoRef ?? repoRefForLocalWorkspace(resolvedRoot);
  const repoKey = overrides.repoKey ?? makeRepoKey(repoRef);
  const meta: LocalWorkspaceMeta = {
    repoKey,
    repoRef,
    label: overrides.label ?? path.basename(resolvedRoot) ?? "Workspace",
    rootPath: resolvedRoot,
    registeredAt: Date.now(),
  };

  // An issue worktree is throwaway: its files, index and graph stay in
  // memory and go with it, never into the persisted store.
  if (isIssueWorktreeRoot(resolvedRoot)) registerEphemeralWorkspace(repoKey, resolvedRoot);
  await putLocalWorkspace(meta);
  // `.viberon/` holds the graph cache and memory; keep it out of any diff.
  await ensureViberonDir(resolvedRoot).catch(() => undefined);
  await refreshLocalWorkspace(meta.repoKey);
  return meta;
}

export async function refreshLocalWorkspace(repoKey: string): Promise<StoredRawFile[]> {
  const meta = await getLocalWorkspace(repoKey);
  if (!meta) {
    throw new WorkspacePathError(`Local workspace not found for ${repoKey}.`);
  }

  const files = await scanLocalWorkspace(meta.rootPath);
  await persistWorkspaceFiles(meta, files);
  return files;
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
): Promise<void> {
  const { graph, stats } = await indexWorkspaceFiles(meta.repoKey, meta.rootPath, meta.repoRef, files);
  lastIndexStats.set(meta.repoKey, stats);
  await Promise.all([
    putRawFiles(meta.repoKey, files),
    putGraph(meta.repoKey, graph),
    putFileInfo(
      meta.repoKey,
      files.map((file) => ({
        path: file.path,
        tokenCount: countTokens(file.source),
      })),
    ),
  ]);
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
  const [raw, info] = await Promise.all([getRawFiles(repoKey), getFileInfo(repoKey)]);
  const nextRaw = raw.filter((file) => file.path !== filePath);
  const nextInfo = info.filter((file) => file.path !== filePath);
  if (source !== null) {
    nextRaw.push({ path: filePath, source });
    nextInfo.push({ path: filePath, tokenCount: countTokens(source) });
    nextRaw.sort((a, b) => a.path.localeCompare(b.path));
  }
  await Promise.all([
    putGraph(repoKey, graph),
    putRawFiles(repoKey, nextRaw),
    putFileInfo(repoKey, nextInfo),
  ]);
}

export async function scanLocalWorkspace(rootPath: string): Promise<StoredRawFile[]> {
  const root = path.resolve(rootPath);
  const files: StoredRawFile[] = [];

  async function visit(dir: string): Promise<void> {
    if (files.length >= MAX_SCAN_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    // Any virtualenv, whatever it is called (`env/`, `.venv-3.11/`, …).
    if (dir !== root && entries.some((e) => e.isFile() && e.name === "pyvenv.cfg")) return;
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) return;
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
      files.push({ path: relativePath, source });
    }
  }

  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
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

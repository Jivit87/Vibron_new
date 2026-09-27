/**
 * Persistent, incremental code graph.
 *
 * The expensive part of building the graph is parsing; the cheap part is
 * linking. We cache one `FileExtract` per source file, keyed by content
 * hash, in `<root>/.viberon/graph.json` (disk workspaces) or in-process
 * (store workspaces). Opening a workspace re-parses only files whose hash
 * changed; a write re-parses exactly that one file. Both then re-link.
 *
 * `.viberon/` is added to `.git/info/exclude` so the cache never enters a diff.
 */

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Graph } from "@/lib/graph";
import type { RepoFile } from "@/lib/github";
import { isSourceFilePath } from "@/lib/github";
import { loadPathAliases, type PathAliases } from "@/lib/lang/tsconfig";
import { extractFile, goModuleOf, hashSource, linkGraphAsync, type FileExtract } from "@/lib/parser";
import { timeSlicer } from "@/lib/workers/yield";
import { onEphemeralRelease } from "@/lib/workspace/ephemeral";

export const GRAPH_INDEX_VERSION = 1;
export const VIBERON_DIR = ".viberon";

export interface GraphIndexDoc {
  version: number;
  repoRef: string;
  aliases: PathAliases[];
  goModule: string | null;
  files: Record<string, FileExtract>;
}

export interface IndexStats {
  parsed: number;
  reused: number;
  removed: number;
  /** The scan hit a cap (file count or bytes): the graph covers part of the repo. */
  truncated?: boolean;
}

const memoryIndexes = ((globalThis as { __viberonGraphIndexes?: Map<string, GraphIndexDoc> })
  .__viberonGraphIndexes ??= new Map<string, GraphIndexDoc>());

// A released issue worktree's index goes with it (its extracts stay shared
// with the workspace it was checked out from).
onEphemeralRelease((_repoKey, rootPath) => {
  memoryIndexes.delete(`disk:${path.resolve(rootPath)}`);
});

function indexPath(rootPath: string): string {
  return path.join(rootPath, VIBERON_DIR, "graph.json");
}

function cacheKey(key: string, rootPath: string | null): string {
  return rootPath ? `disk:${path.resolve(rootPath)}` : `store:${key}`;
}

/** Synchronous read of the persisted index (memory helpers need it without awaiting). */
export function loadGraphIndexSync(rootPath: string): GraphIndexDoc | null {
  const cached = memoryIndexes.get(cacheKey("", rootPath));
  if (cached) return cached;
  try {
    const file = indexPath(rootPath);
    if (!existsSync(file)) return null;
    const doc = JSON.parse(readFileSync(file, "utf8")) as GraphIndexDoc;
    if (doc.version !== GRAPH_INDEX_VERSION) return null;
    memoryIndexes.set(cacheKey("", rootPath), doc);
    return doc;
  } catch {
    return null;
  }
}

async function loadIndex(key: string, rootPath: string | null): Promise<GraphIndexDoc | null> {
  const cached = memoryIndexes.get(cacheKey(key, rootPath));
  if (cached) return cached;
  if (!rootPath) return null;
  try {
    const doc = JSON.parse(await readFile(indexPath(rootPath), "utf8")) as GraphIndexDoc;
    if (doc.version !== GRAPH_INDEX_VERSION) return null;
    memoryIndexes.set(cacheKey(key, rootPath), doc);
    return doc;
  } catch {
    return null;
  }
}

async function saveIndex(key: string, rootPath: string | null, doc: GraphIndexDoc): Promise<void> {
  memoryIndexes.set(cacheKey(key, rootPath), doc);
  if (!rootPath) return;
  try {
    await ensureViberonDir(rootPath);
    const target = indexPath(rootPath);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, target);
  } catch {
    // Read-only workspace: the in-process cache still makes writes incremental.
  }
}

/** Create `.viberon/` and keep it out of git (`.git/info/exclude`). */
export async function ensureViberonDir(rootPath: string): Promise<string> {
  const dir = path.join(rootPath, VIBERON_DIR);
  await mkdir(dir, { recursive: true });
  await excludeFromGit(rootPath, `/${VIBERON_DIR}/`);
  return dir;
}

/** Append a pattern to `.git/info/exclude` once. No-op outside git repos. */
export async function excludeFromGit(rootPath: string, pattern: string): Promise<boolean> {
  const gitDir = path.join(rootPath, ".git");
  let infoDir: string;
  try {
    const info = await stat(gitDir);
    if (info.isDirectory()) infoDir = path.join(gitDir, "info");
    else {
      // Worktree: `.git` is a file pointing at the real git dir.
      const pointer = (await readFile(gitDir, "utf8")).match(/gitdir:\s*(.+)/)?.[1]?.trim();
      if (!pointer) return false;
      const resolved = path.resolve(rootPath, pointer);
      const common = await readFile(path.join(resolved, "commondir"), "utf8").catch(() => null);
      infoDir = path.join(common ? path.resolve(resolved, common.trim()) : resolved, "info");
    }
  } catch {
    return false;
  }
  const file = path.join(infoDir, "exclude");
  const current = await readFile(file, "utf8").catch(() => "");
  if (current.split(/\r?\n/).some((line) => line.trim() === pattern)) return false;
  await mkdir(infoDir, { recursive: true });
  await appendFile(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
  return true;
}

/** Link the doc's extracts, yielding to the event loop as it goes. */
function linkDoc(doc: GraphIndexDoc, signal?: AbortSignal): Promise<Graph> {
  return linkGraphAsync(
    Object.values(doc.files),
    {
      repoRef: doc.repoRef,
      knownFiles: new Set(Object.keys(doc.files)),
      aliases: doc.aliases,
      goModule: doc.goModule,
    },
    timeSlicer(),
    signal,
  );
}

/**
 * An extract of the same path and content from any other loaded index. An
 * issue worktree is a fresh checkout of a workspace that is already indexed:
 * without this every worktree re-parsed the whole repository.
 */
function donorExtract(previous: GraphIndexDoc | null, filePath: string, hash: string): FileExtract | null {
  for (const doc of memoryIndexes.values()) {
    if (doc === previous) continue;
    const hit = doc.files[filePath];
    if (hit && hit.hash === hash) return hit;
  }
  return null;
}

/**
 * Bring the index in line with `files` (the full workspace listing): reuse
 * extracts whose hash matches, parse the rest, drop deleted files, re-link.
 * Yields to the event loop between files (requests, Stop, stay responsive)
 * and throws when `signal` aborts.
 */
export async function indexWorkspaceFiles(
  key: string,
  rootPath: string | null,
  repoRef: string,
  files: RepoFile[],
  options: { signal?: AbortSignal } = {},
): Promise<{ graph: Graph; stats: IndexStats }> {
  const tick = timeSlicer();
  const previous = await loadIndex(key, rootPath);
  const doc: GraphIndexDoc = {
    version: GRAPH_INDEX_VERSION,
    repoRef,
    aliases: loadPathAliases(files),
    goModule: goModuleOf(files),
    files: {},
  };
  const stats: IndexStats = { parsed: 0, reused: 0, removed: 0 };
  for (const file of files) {
    if (!isSourceFilePath(file.path)) continue;
    await tick(options.signal);
    const hash = hashSource(file.source);
    const own = previous?.files[file.path];
    const cached = own && own.hash === hash ? own : donorExtract(previous, file.path, hash);
    if (cached) {
      doc.files[file.path] = cached;
      stats.reused += 1;
    } else {
      doc.files[file.path] = extractFile(file);
      stats.parsed += 1;
    }
  }
  if (previous) {
    stats.removed = Object.keys(previous.files).filter((p) => !(p in doc.files)).length;
  }
  await saveIndex(key, rootPath, doc);
  return { graph: await linkDoc(doc, options.signal), stats };
}

/**
 * Patch the index for one written (or deleted, `source === null`) file.
 * Returns null when there is no index yet or the change affects resolution
 * config (tsconfig/go.mod) — the caller then does a full (still cached) index.
 */
export async function patchIndexedFile(
  key: string,
  rootPath: string | null,
  filePath: string,
  source: string | null,
): Promise<Graph | null> {
  if (/(^|\/)(tsconfig[^/]*|jsconfig[^/]*)\.json$|^go\.mod$/.test(filePath)) return null;
  const current = await loadIndex(key, rootPath);
  if (!current) return null;
  if (source === null ? !(filePath in current.files) : !isSourceFilePath(filePath)) {
    return linkDoc(current);
  }
  if (source !== null && current.files[filePath]?.hash === hashSource(source)) return linkDoc(current);
  // New doc object (not an in-place edit) so readers' per-doc caches invalidate.
  const doc: GraphIndexDoc = { ...current, files: { ...current.files } };
  if (source === null) delete doc.files[filePath];
  else doc.files[filePath] = extractFile({ path: filePath, source });
  await saveIndex(key, rootPath, doc);
  return linkDoc(doc);
}

/** Current graph from the cached index without touching any file. */
export async function graphFromIndex(key: string, rootPath: string | null): Promise<Graph | null> {
  const doc = await loadIndex(key, rootPath);
  return doc ? linkDoc(doc) : null;
}

/** Forget cached indexes (tests). */
export function clearGraphIndexCache(): void {
  memoryIndexes.clear();
}

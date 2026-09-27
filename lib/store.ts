import type {
  DemoMeta,
  Graph,
  Job,
  LocalWorkspaceMeta,
  StoredFileInfo,
  StoredRawFile,
} from "@/lib/graph";
import { getFirestoreDb } from "@/lib/firebase-admin";
import { ShardStore } from "@/lib/store-shards";
import { isEphemeralStoreKey, onEphemeralRelease } from "@/lib/workspace/ephemeral";

const GRAPH_TTL_SECONDS = 60 * 60 * 24 * 7;
const JOB_TTL_SECONDS = 60 * 60;

type StoredValue = {
  value: unknown;
  expiresAt?: number;
};

/**
 * `VIBERON_STORE=memory`: keep everything in-process (headless runs, eval).
 * No store files in the cwd and no Firestore round-trips.
 */
function memoryOnly(): boolean {
  return process.env.VIBERON_STORE === "memory";
}

/** Tests run in memory unless one opts into the disk backend (`VIBERON_STORE=disk`). */
function diskDisabled(): boolean {
  return memoryOnly() || (Boolean(process.env.VITEST) && process.env.VIBERON_STORE !== "disk");
}

const GLOBAL_STORE_KEY = Symbol.for("viberon.memory-store");
const GLOBAL_SHARDS_KEY = Symbol.for("viberon.shard-store");
type GlobalWithStore = typeof globalThis & {
  [GLOBAL_STORE_KEY]?: Map<string, StoredValue>;
  [GLOBAL_SHARDS_KEY]?: ShardStore;
};
const globalWithStore = globalThis as GlobalWithStore;
/** Memory backend (`VIBERON_STORE=memory`, tests). */
const memory: Map<string, StoredValue> = (globalWithStore[GLOBAL_STORE_KEY] ??= new Map());

/**
 * Disk backend when Firestore is not configured: one file per key under
 * `<VIBERON_STORE_DIR or cwd>/.viberon-store/` (see `lib/store-shards.ts`).
 * Electron sets `VIBERON_STORE_DIR` to its user-data folder. A legacy
 * `.viberon-dev-store.json` there is migrated on first use (kept as `.bak`).
 */
function shards(): ShardStore | null {
  if (diskDisabled()) return null;
  const root = process.env.VIBERON_STORE_DIR || process.cwd();
  const current = globalWithStore[GLOBAL_SHARDS_KEY];
  if (current && current.root === root) return current;
  current?.close();
  const next = new ShardStore(root);
  globalWithStore[GLOBAL_SHARDS_KEY] = next;
  return next;
}

/** Await pending disk writes (tests, shutdown). */
export async function flushStoreForTests(): Promise<void> {
  await globalWithStore[GLOBAL_SHARDS_KEY]?.flush();
}

/** Resolves once a legacy single-file store has been migrated (no-op otherwise). */
export async function storeReady(): Promise<void> {
  await shards()?.whenReady();
}

const STORE_COLLECTION = "viberon_store";

function docIdForKey(key: string): string {
  return encodeURIComponent(key);
}

function isExpired(entry: StoredValue | undefined | null): boolean {
  return Boolean(entry?.expiresAt && entry.expiresAt <= Date.now());
}

// Entries of ephemeral workspaces (issue worktrees): process memory only,
// never the disk store or Firestore, and dropped when the worktree goes.
const ephemeralEntries = new Map<string, unknown>();
onEphemeralRelease((repoKey) => {
  for (const key of ephemeralEntries.keys()) {
    if (key.slice(key.indexOf(":") + 1) === repoKey) ephemeralEntries.delete(key);
  }
  diskRoots.delete(repoKey);
  derivedGraphs.delete(repoKey);
});

/* --------------------- derived data of disk workspaces --------------------- */

/**
 * A workspace opened from a folder can always rebuild its raw files (read
 * the folder) and its graph (`<root>/.viberon/graph.json`), so neither is
 * ever persisted: they made the old single-file store 166 MB and every
 * request that touched it slow. Raw files are read from disk on demand; the
 * linked graph is kept in process memory (a few, most recent first).
 */
const diskRoots = new Map<string, string>();
const derivedGraphs = new Map<string, Graph>();
const MAX_DERIVED_GRAPHS = 8;

async function diskRootOf(repoKey: string): Promise<string | null> {
  const known = diskRoots.get(repoKey);
  if (known) return known;
  const meta = await getValue<LocalWorkspaceMeta>(localWorkspaceKey(repoKey));
  if (!meta?.rootPath) return null;
  diskRoots.set(repoKey, meta.rootPath);
  return meta.rootPath;
}

function rememberGraph(repoKey: string, graph: Graph): void {
  derivedGraphs.delete(repoKey);
  derivedGraphs.set(repoKey, graph);
  while (derivedGraphs.size > MAX_DERIVED_GRAPHS) derivedGraphs.delete(derivedGraphs.keys().next().value!);
}

/** A persisted copy of a now-derived key (older store, migration) is dropped, once per process. */
const dropped = new Set<string>();
function dropPersisted(key: string): void {
  if (memoryOnly() || getFirestoreDb()) return;
  const disk = shards();
  if (!disk || dropped.has(`${disk.root}\0${key}`)) return;
  dropped.add(`${disk.root}\0${key}`);
  disk.delete(key);
}

/** Keys in the persisted store (diagnostics and tests). */
export function persistedStoreKeys(): string[] {
  const disk = memoryOnly() || getFirestoreDb() ? null : shards();
  return disk ? disk.keys() : [...memory.keys()];
}

async function getValue<T>(key: string): Promise<T | null> {
  if (isEphemeralStoreKey(key)) return (ephemeralEntries.get(key) as T | undefined) ?? null;
  const db = memoryOnly() ? null : getFirestoreDb();
  if (db) {
    const ref = db.collection(STORE_COLLECTION).doc(docIdForKey(key));
    const snap = await ref.get();
    if (!snap.exists) return null;
    const entry = snap.data() as StoredValue | undefined;
    if (isExpired(entry)) {
      await ref.delete();
      return null;
    }
    return (entry?.value as T | undefined) ?? null;
  }

  const disk = shards();
  if (disk) {
    const entry = await disk.get(key);
    if (isExpired(entry)) {
      disk.delete(key);
      return null;
    }
    return (entry?.value as T | undefined) ?? null;
  }

  const entry = memory.get(key);
  if (isExpired(entry)) {
    memory.delete(key);
    return null;
  }
  return (entry?.value as T | undefined) ?? null;
}

async function setValue(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  if (isEphemeralStoreKey(key)) {
    ephemeralEntries.set(key, value);
    return;
  }
  const db = memoryOnly() ? null : getFirestoreDb();
  if (db) {
    await db.collection(STORE_COLLECTION).doc(docIdForKey(key)).set({
      key,
      value,
      expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
    });
    return;
  }

  const entry: StoredValue = {
    value,
    ...(ttlSeconds ? { expiresAt: Date.now() + ttlSeconds * 1000 } : {}),
  };
  const disk = shards();
  if (disk) {
    // Cached at once, written asynchronously: a set never blocks the loop.
    disk.set(key, entry);
    return;
  }
  memory.set(key, entry);
}

export async function storePing(): Promise<"firestore" | "memory"> {
  const db = memoryOnly() ? null : getFirestoreDb();
  if (!db) {
    return "memory";
  }

  await db.collection(STORE_COLLECTION).limit(1).get();
  return "firestore";
}

export function graphKey(repoKey: string): string {
  return `graph:${repoKey}`;
}

export function jobKey(jobId: string): string {
  return `job:${jobId}`;
}

export function filesKey(repoKey: string): string {
  return `files:${repoKey}`;
}

export function rawFilesKey(repoKey: string): string {
  return `raw:${repoKey}`;
}

export function localWorkspaceKey(repoKey: string): string {
  return `workspace:${repoKey}`;
}

export async function getGraph(repoKey: string): Promise<Graph | null> {
  if (isEphemeralStoreKey(graphKey(repoKey))) return getValue<Graph>(graphKey(repoKey));
  const root = await diskRootOf(repoKey);
  if (!root) return getValue<Graph>(graphKey(repoKey));
  const known = derivedGraphs.get(repoKey);
  if (known) return known;
  const { graphFromIndex } = await import("@/lib/workspace/graph-index");
  const graph = await graphFromIndex(repoKey, root);
  if (graph) rememberGraph(repoKey, graph);
  return graph;
}

export async function putGraph(repoKey: string, graph: Graph): Promise<void> {
  if (!isEphemeralStoreKey(graphKey(repoKey)) && (await diskRootOf(repoKey))) {
    rememberGraph(repoKey, graph);
    dropPersisted(graphKey(repoKey));
    dropPersisted(rawFilesKey(repoKey));
    return;
  }
  await setValue(graphKey(repoKey), graph, GRAPH_TTL_SECONDS);
}

export async function getJob(jobId: string): Promise<Job | null> {
  return getValue<Job>(jobKey(jobId));
}

export async function putJob(job: Job): Promise<void> {
  await setValue(jobKey(job.jobId), job, JOB_TTL_SECONDS);
}

export async function setRepoToJob(repoKey: string, jobId: string): Promise<void> {
  await setValue(`repo2job:${repoKey}`, jobId, JOB_TTL_SECONDS);
}

export async function getRepoJob(repoKey: string): Promise<string | null> {
  return getValue<string>(`repo2job:${repoKey}`);
}

export async function putFileInfo(repoKey: string, files: StoredFileInfo[]): Promise<void> {
  await setValue(filesKey(repoKey), files, GRAPH_TTL_SECONDS);
}

export async function getFileInfo(repoKey: string): Promise<StoredFileInfo[]> {
  return (await getValue<StoredFileInfo[]>(filesKey(repoKey))) ?? [];
}

/** Raw sources of a store workspace. A folder workspace's files stay on disk (no-op). */
export async function putRawFiles(repoKey: string, files: StoredRawFile[]): Promise<void> {
  if (!isEphemeralStoreKey(rawFilesKey(repoKey)) && (await diskRootOf(repoKey))) {
    dropPersisted(rawFilesKey(repoKey));
    return;
  }
  await setValue(rawFilesKey(repoKey), files, GRAPH_TTL_SECONDS);
}

export async function getRawFiles(repoKey: string): Promise<StoredRawFile[]> {
  const root = isEphemeralStoreKey(rawFilesKey(repoKey)) ? null : await diskRootOf(repoKey);
  if (root) {
    const { scanLocalWorkspace } = await import("@/lib/local-disk-workspace");
    return scanLocalWorkspace(root).catch(() => []);
  }
  return (await getValue<StoredRawFile[]>(rawFilesKey(repoKey))) ?? [];
}

export async function getRawFile(
  repoKey: string,
  filePath: string,
): Promise<StoredRawFile | null> {
  if (!isEphemeralStoreKey(rawFilesKey(repoKey)) && (await diskRootOf(repoKey))) {
    const { readLocalWorkspaceFile } = await import("@/lib/local-disk-workspace");
    return readLocalWorkspaceFile(repoKey, filePath).catch(() => null);
  }
  const all = await getRawFiles(repoKey);
  return all.find((f) => f.path === filePath) ?? null;
}

export async function putLocalWorkspace(meta: LocalWorkspaceMeta): Promise<void> {
  if (diskRoots.get(meta.repoKey) !== meta.rootPath) derivedGraphs.delete(meta.repoKey);
  if (meta.rootPath) diskRoots.set(meta.repoKey, meta.rootPath);
  await setValue(localWorkspaceKey(meta.repoKey), meta);
}

export async function getLocalWorkspace(
  repoKey: string,
): Promise<LocalWorkspaceMeta | null> {
  return getValue<LocalWorkspaceMeta>(localWorkspaceKey(repoKey));
}

/**
 * Registered folder workspaces, newest first (issue worktrees excluded).
 * Disk and memory backends list their keys; Firestore queries the key range.
 */
export async function listLocalWorkspaces(): Promise<LocalWorkspaceMeta[]> {
  const prefix = "workspace:";
  const db = memoryOnly() ? null : getFirestoreDb();
  let metas: LocalWorkspaceMeta[];
  if (db) {
    const snap = await db.collection(STORE_COLLECTION).where("key", ">=", prefix).where("key", "<", "workspace;").get();
    metas = snap.docs
      .map((doc) => doc.data() as StoredValue & { key?: string })
      .filter((entry) => !isExpired(entry))
      .map((entry) => entry.value as LocalWorkspaceMeta);
  } else {
    const keys = (shards() ? persistedStoreKeys() : [...memory.keys()]).filter((key) => key.startsWith(prefix));
    metas = (await Promise.all(keys.map((key) => getValue<LocalWorkspaceMeta>(key)))).filter(
      (meta): meta is LocalWorkspaceMeta => Boolean(meta),
    );
  }
  return metas
    .filter((meta) => meta?.repoKey && !isEphemeralStoreKey(localWorkspaceKey(meta.repoKey)))
    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0));
}

export async function getDemoList(): Promise<string[]> {
  return (await getValue<string[]>("demo:list")) ?? [];
}

export async function setDemoList(keys: string[]): Promise<void> {
  await setValue("demo:list", keys);
}

export async function putDemoMeta(meta: DemoMeta): Promise<void> {
  await setValue(`demo:${meta.repoKey}`, meta);
}

export async function getDemoMeta(repoKey: string): Promise<DemoMeta | null> {
  return getValue<DemoMeta>(`demo:${repoKey}`);
}

/**
 * Escape hatches for callers that own their own key namespace (credentials,
 * project memory, checkpoints). They get the same Firestore-or-disk backing
 * as the typed helpers above without needing a bespoke accessor each time.
 */
export async function getValueRaw<T>(key: string): Promise<T | null> {
  return getValue<T>(key);
}

export async function setValueRaw(
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  await setValue(key, value, ttlSeconds);
}

/**
 * Forget every in-process cache as if the server restarted; what the disk
 * backend holds stays (tests: migration and derived data). Flush first.
 */
export function forgetStoreCachesForTests(): void {
  ephemeralEntries.clear();
  diskRoots.clear();
  derivedGraphs.clear();
  dropped.clear();
  globalWithStore[GLOBAL_SHARDS_KEY]?.close();
  delete globalWithStore[GLOBAL_SHARDS_KEY];
}

export function resetMemoryStoreForTests(): void {
  memory.clear();
  ephemeralEntries.clear();
  diskRoots.clear();
  derivedGraphs.clear();
  dropped.clear();
  if (memoryOnly()) return;
  globalWithStore[GLOBAL_SHARDS_KEY]?.clearForTests();
}

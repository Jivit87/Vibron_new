import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  DemoMeta,
  Graph,
  Job,
  LocalWorkspaceMeta,
  StoredFileInfo,
  StoredRawFile,
} from "@/lib/graph";
import { getFirestoreDb } from "@/lib/firebase-admin";
import { isEphemeralStoreKey, onEphemeralRelease } from "@/lib/workspace/ephemeral";

const GRAPH_TTL_SECONDS = 60 * 60 * 24 * 7;
const JOB_TTL_SECONDS = 60 * 60;

type StoredValue = {
  value: unknown;
  expiresAt?: number;
};

// Disk-backed fallback. When Firestore creds are not configured we persist
// the in-memory map to `.viberon-dev-store.json` so POST /api/repos in worker
// A and GET /api/repos/:id/status in worker B see the same state. Electron
// packages set `VIBERON_STORE_DIR` to a writable user-data folder so desktop
// builds do not depend on the app bundle directory being writable.
const DISK_STORE_FILE = path.join(
  process.env.VIBERON_STORE_DIR || process.cwd(),
  ".viberon-dev-store.json",
);
/**
 * `VIBERON_STORE=memory`: keep everything in-process (headless runs, eval).
 * No `.viberon-dev-store.json` in the cwd and no Firestore round-trips.
 */
function memoryOnly(): boolean {
  return process.env.VIBERON_STORE === "memory";
}

const GLOBAL_STORE_KEY = Symbol.for("viberon.memory-store");
type GlobalWithStore = typeof globalThis & {
  [GLOBAL_STORE_KEY]?: Map<string, StoredValue>;
};
const globalWithStore = globalThis as GlobalWithStore;
const memory: Map<string, StoredValue> =
  globalWithStore[GLOBAL_STORE_KEY] ?? loadFromDisk();
globalWithStore[GLOBAL_STORE_KEY] = memory;

function loadFromDisk(): Map<string, StoredValue> {
  if (process.env.VITEST || memoryOnly()) {
    return new Map();
  }
  try {
    if (!existsSync(DISK_STORE_FILE)) {
      return new Map();
    }
    const raw = readFileSync(DISK_STORE_FILE, "utf8");
    if (!raw) return new Map();
    const parsed = JSON.parse(raw) as Array<[string, StoredValue]>;
    return new Map(parsed);
  } catch {
    return new Map();
  }
}

function persistToDisk(): void {
  if (process.env.VITEST || memoryOnly()) return;
  // Best-effort persist; failure to write to disk should never break the
  // request flow. Ignore errors silently.
  try {
    mkdirSync(path.dirname(DISK_STORE_FILE), { recursive: true });
    writeFileSync(DISK_STORE_FILE, JSON.stringify([...memory.entries()]));
  } catch {
    // ignore
  }
}

const STORE_COLLECTION = "viberon_store";

function docIdForKey(key: string): string {
  return encodeURIComponent(key);
}

function isExpired(entry: StoredValue | undefined): boolean {
  return Boolean(entry?.expiresAt && entry.expiresAt <= Date.now());
}

function reloadIfDiskNewer(): void {
  if (process.env.VITEST || memoryOnly()) return;
  // Reload from disk on every read so a write from another worker becomes
  // visible. Cheap because the file is small and reads happen at most once
  // per second per worker.
  try {
    if (!existsSync(DISK_STORE_FILE)) return;
    const raw = readFileSync(DISK_STORE_FILE, "utf8");
    if (!raw) return;
    const parsed = JSON.parse(raw) as Array<[string, StoredValue]>;
    memory.clear();
    for (const [key, value] of parsed) {
      memory.set(key, value);
    }
  } catch {
    // ignore
  }
}

// Entries of ephemeral workspaces (issue worktrees): process memory only,
// never the disk file or Firestore, and dropped when the worktree goes.
const ephemeralEntries = new Map<string, unknown>();
onEphemeralRelease((repoKey) => {
  for (const key of ephemeralEntries.keys()) {
    if (key.slice(key.indexOf(":") + 1) === repoKey) ephemeralEntries.delete(key);
  }
});

/** Keys in the persisted store (diagnostics and tests). */
export function persistedStoreKeys(): string[] {
  return [...memory.keys()];
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

  reloadIfDiskNewer();
  const entry = memory.get(key);
  if (isExpired(entry)) {
    memory.delete(key);
    persistToDisk();
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

  // Reload first so we don't clobber writes from another worker.
  reloadIfDiskNewer();
  memory.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined,
  });
  persistToDisk();
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
  return getValue<Graph>(graphKey(repoKey));
}

export async function putGraph(repoKey: string, graph: Graph): Promise<void> {
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

export async function putRawFiles(repoKey: string, files: StoredRawFile[]): Promise<void> {
  await setValue(rawFilesKey(repoKey), files, GRAPH_TTL_SECONDS);
}

export async function getRawFiles(repoKey: string): Promise<StoredRawFile[]> {
  return (await getValue<StoredRawFile[]>(rawFilesKey(repoKey))) ?? [];
}

export async function getRawFile(
  repoKey: string,
  filePath: string,
): Promise<StoredRawFile | null> {
  const all = await getRawFiles(repoKey);
  return all.find((f) => f.path === filePath) ?? null;
}

export async function putLocalWorkspace(meta: LocalWorkspaceMeta): Promise<void> {
  await setValue(localWorkspaceKey(meta.repoKey), meta);
}

export async function getLocalWorkspace(
  repoKey: string,
): Promise<LocalWorkspaceMeta | null> {
  return getValue<LocalWorkspaceMeta>(localWorkspaceKey(repoKey));
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

export function resetMemoryStoreForTests(): void {
  memory.clear();
  ephemeralEntries.clear();
  if (process.env.VITEST || memoryOnly()) return;
  try {
    if (existsSync(DISK_STORE_FILE)) {
      writeFileSync(DISK_STORE_FILE, "[]");
    }
  } catch {
    // ignore
  }
}

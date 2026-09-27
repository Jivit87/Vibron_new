/**
 * Disk backend of the key/value store: one JSON file per key under
 * `<VIBERON_STORE_DIR or cwd>/.viberon-store/`.
 *
 * It replaces `.viberon-dev-store.json`, a single file read, parsed and
 * rewritten synchronously on EVERY get and set. With a large repo's files
 * and graph in it (166 MB) each request blocked the server's event loop for
 * seconds, so even Stop (DELETE /api/tasks/:id) was never processed.
 *
 * - Reads are lazy per key and async. A cached value is reused while its
 *   file's mtime/size are unchanged (another process's write is still seen).
 * - Writes update the cache at once and hit the disk asynchronously
 *   (tmp file + rename), coalesced per key; `flush()` awaits them and a
 *   synchronous flush runs on process exit.
 * - The legacy file is migrated once, in a worker thread: it is first
 *   renamed to `.viberon-dev-store.json.bak` (never deleted), then split
 *   into shards. Requests wait for the migration asynchronously.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { keyFromShardFileName, migrateLegacyStoreInWorker, shardFileName } from "@/lib/workers/store-migrate";

export interface StoredEntry {
  value: unknown;
  expiresAt?: number;
}

export const LEGACY_STORE_FILE = ".viberon-dev-store.json";
export const SHARD_DIR = ".viberon-store";
const MIGRATION_FILE = "migration.json";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

interface CacheLine {
  entry: StoredEntry | null;
  mtimeMs: number;
  size: number;
}

interface MigrationState {
  source: string;
  done: boolean;
  keys?: number;
  at?: number;
}

let tmpCounter = 0;

export class ShardStore {
  readonly dir: string;
  private readonly cache = new Map<string, CacheLine>();
  /** Values set but not yet on disk (null = delete). The newest local truth. */
  private readonly pending = new Map<string, StoredEntry | null>();
  private readonly writing = new Map<string, Promise<void>>();
  private readonly ready: Promise<void>;
  private readonly onExit = () => this.flushSync();

  constructor(readonly root: string) {
    this.dir = path.join(root, SHARD_DIR);
    this.ready = this.migrate().catch(() => undefined);
    process.once("exit", this.onExit);
  }

  private file(key: string): string {
    return path.join(this.dir, shardFileName(key, sha1));
  }

  /** Resolves once a legacy store (if any) has been split into shards. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  private async migrate(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const legacy = path.join(this.root, LEGACY_STORE_FILE);
    const marker = path.join(this.dir, MIGRATION_FILE);
    let state: MigrationState | null = null;
    try {
      state = JSON.parse(await readFile(marker, "utf8")) as MigrationState;
    } catch {
      state = null;
    }
    if (existsSync(legacy)) {
      // Back up first (a rename: no 166 MB copy), never overwriting a backup.
      let backup = `${legacy}.bak`;
      if (existsSync(backup)) backup = `${legacy}.bak.${Date.now()}`;
      await rename(legacy, backup);
      state = { source: backup, done: false };
      await writeFile(marker, JSON.stringify(state));
    }
    if (!state || state.done) return;
    const result = await migrateLegacyStoreInWorker(state.source, this.dir);
    await writeFile(marker, JSON.stringify({ ...state, done: true, keys: result.keys, at: Date.now() }));
  }

  async get(key: string): Promise<StoredEntry | null> {
    await this.ready;
    if (this.pending.has(key)) return this.pending.get(key) ?? null;
    const file = this.file(key);
    let info: { mtimeMs: number; size: number };
    try {
      info = await stat(file);
    } catch {
      if (this.pending.has(key)) return this.pending.get(key) ?? null;
      this.cache.set(key, { entry: null, mtimeMs: 0, size: 0 });
      return null;
    }
    const cached = this.cache.get(key);
    if (cached && cached.entry && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.entry;
    try {
      const doc = JSON.parse(await readFile(file, "utf8")) as { value: unknown; expiresAt?: number | null };
      // A local set that raced the read wins.
      if (this.pending.has(key)) return this.pending.get(key) ?? null;
      const entry: StoredEntry = { value: doc.value, ...(doc.expiresAt ? { expiresAt: doc.expiresAt } : {}) };
      this.cache.set(key, { entry, mtimeMs: info.mtimeMs, size: info.size });
      return entry;
    } catch {
      // Mid-rename or corrupt: fall back to what we last saw.
      return cached?.entry ?? null;
    }
  }

  set(key: string, entry: StoredEntry): void {
    this.pending.set(key, entry);
    this.schedule(key);
  }

  delete(key: string): void {
    this.pending.set(key, null);
    this.schedule(key);
  }

  private schedule(key: string): void {
    if (this.writing.has(key)) return;
    const run = (async () => {
      await this.ready;
      // Coalesce: a burst of sets on one key costs one write of the last value.
      while (this.pending.has(key)) {
        const entry = this.pending.get(key) ?? null;
        await this.writeOne(key, entry);
        if (this.pending.get(key) === entry) this.pending.delete(key);
      }
    })()
      .catch(() => undefined)
      .finally(() => this.writing.delete(key));
    this.writing.set(key, run);
  }

  private async writeOne(key: string, entry: StoredEntry | null): Promise<void> {
    const file = this.file(key);
    if (!entry) {
      await unlink(file).catch(() => undefined);
      this.cache.set(key, { entry: null, mtimeMs: 0, size: 0 });
      return;
    }
    const body = JSON.stringify({ key, value: entry.value, expiresAt: entry.expiresAt ?? null });
    const tmp = `${file}.${process.pid}.${(tmpCounter += 1)}.tmp`;
    try {
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, file);
      const info = await stat(file);
      this.cache.set(key, { entry, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      await unlink(tmp).catch(() => undefined);
      // Best effort, like the old store: a failed write never breaks a request.
    }
  }

  /** Await every pending write. */
  async flush(): Promise<void> {
    await this.ready;
    while (this.writing.size) await Promise.all([...this.writing.values()]);
  }

  /** Last-chance synchronous write of pending values (process exit). */
  flushSync(): void {
    if (!this.pending.size) return;
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      return;
    }
    for (const [key, entry] of this.pending) {
      const file = this.file(key);
      try {
        if (!entry) continue;
        const tmp = `${file}.${process.pid}.exit.tmp`;
        writeFileSync(tmp, JSON.stringify({ key, value: entry.value, expiresAt: entry.expiresAt ?? null }), { mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // ignore
      }
    }
    this.pending.clear();
  }

  /** Keys on disk plus unwritten ones (diagnostics; synchronous directory read). */
  keys(): string[] {
    const keys = new Set<string>();
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.endsWith(".tmp") || name === MIGRATION_FILE) continue;
        const key = keyFromShardFileName(name);
        if (key !== null) keys.add(key);
        else if (name.startsWith("h") && name.endsWith(".json")) {
          try {
            const doc = JSON.parse(readFileSync(path.join(this.dir, name), "utf8")) as { key?: unknown };
            if (typeof doc.key === "string") keys.add(doc.key);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // No directory yet.
    }
    for (const [key, entry] of this.pending) {
      if (entry) keys.add(key);
      else keys.delete(key);
    }
    return [...keys];
  }

  /** Drop every shard (tests only) and forget cached state. */
  clearForTests(): void {
    this.pending.clear();
    this.cache.clear();
    try {
      for (const name of readdirSync(this.dir)) {
        if (name === MIGRATION_FILE) continue;
        try {
          unlinkSync(path.join(this.dir, name));
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  close(): void {
    process.removeListener("exit", this.onExit);
  }
}

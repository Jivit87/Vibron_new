/**
 * One-time migration of the legacy single-file dev store
 * (`.viberon-dev-store.json`, one JSON array of `[key, {value, expiresAt}]`)
 * into one file per key. Runs in a worker thread: the legacy file reached
 * 166 MB on large repos, and parsing it on the server thread froze every
 * request (Stop included) for seconds.
 *
 * The worker is inline (`eval`) plain JavaScript so it survives any bundler
 * (Next, tsx, vitest) without a separate build entry. It never logs values.
 */

import { Worker } from "node:worker_threads";

/**
 * File name of a key's shard: `k` + the key with every byte outside
 * `[a-z0-9.-]` written as `_xx` (lowercase hex; case-insensitive file
 * systems cannot collide), `.json`. Keys too long for a file name use
 * `h<sha1>.json`; the key is always stored inside the file as well.
 *
 * Mirrored verbatim in the worker source below (a test keeps them equal).
 */
export function shardFileName(key: string, sha1: (text: string) => string): string {
  let out = "k";
  for (const byte of Buffer.from(key, "utf8")) {
    const c = String.fromCharCode(byte);
    out += /[a-z0-9.-]/.test(c) ? c : `_${byte.toString(16).padStart(2, "0")}`;
  }
  return out.length > 180 ? `h${sha1(key)}.json` : `${out}.json`;
}

/** Inverse of `shardFileName` for `k…` names; null for hashed or foreign files. */
export function keyFromShardFileName(name: string): string | null {
  if (!name.startsWith("k") || !name.endsWith(".json")) return null;
  const body = name.slice(1, -".json".length);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === "_") {
      bytes.push(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(body.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

export const WORKER_SHARD_FILE_NAME = `function shardFileName(key, sha1) {
  let out = "k";
  for (const byte of Buffer.from(key, "utf8")) {
    const c = String.fromCharCode(byte);
    out += /[a-z0-9.-]/.test(c) ? c : "_" + byte.toString(16).padStart(2, "0");
  }
  return out.length > 180 ? "h" + sha1(key) + ".json" : out + ".json";
}`;

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
${WORKER_SHARD_FILE_NAME}
const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
try {
  const raw = fs.readFileSync(workerData.source, "utf8");
  const entries = raw.trim() ? JSON.parse(raw) : [];
  if (!Array.isArray(entries)) throw new Error("legacy store is not an array");
  fs.mkdirSync(workerData.dir, { recursive: true });
  let written = 0;
  let kept = 0;
  for (const pair of entries) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string") continue;
    const key = pair[0];
    const entry = pair[1] && typeof pair[1] === "object" ? pair[1] : { value: pair[1] };
    const file = path.join(workerData.dir, shardFileName(key, sha1));
    const body = JSON.stringify({ key, value: entry.value === undefined ? null : entry.value, expiresAt: entry.expiresAt ?? null });
    try {
      // wx: a shard written since (a newer value) always wins over the legacy one.
      fs.writeFileSync(file, body, { flag: "wx", mode: 0o600 });
      written += 1;
    } catch (error) {
      if (error && error.code === "EEXIST") kept += 1;
      else throw error;
    }
  }
  parentPort.postMessage({ ok: true, keys: entries.length, written, kept });
} catch (error) {
  parentPort.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
}
`;

export interface MigrateResult {
  keys: number;
  written: number;
  kept: number;
}

/** Split a legacy store file into shard files under `dir`, off the main thread. */
export function migrateLegacyStoreInWorker(source: string, dir: string): Promise<MigrateResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { source, dir } });
    let settled = false;
    worker.once("message", (message: { ok: boolean; error?: string } & MigrateResult) => {
      settled = true;
      if (message.ok) resolve({ keys: message.keys, written: message.written, kept: message.kept });
      else reject(new Error(`store migration failed: ${message.error}`));
    });
    worker.once("error", (error) => {
      if (!settled) reject(error);
      settled = true;
    });
    worker.once("exit", (code) => {
      if (!settled) reject(new Error(`store migration worker exited with ${code}`));
    });
  });
}

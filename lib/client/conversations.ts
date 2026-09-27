"use client";

/**
 * Conversation storage.
 *
 * Chat history is per-workspace and split into two localStorage layers:
 *
 *   index  — `viberon.conv.index.<repoKey>` → ConversationMeta[]
 *   record — `viberon.conv.<repoKey>.<id>`  → StoredConversation
 *
 * The split matters: the sidebar only needs titles and timestamps, so
 * rendering the history list never deserializes every message of every
 * conversation. Records load lazily, on switch.
 *
 * Everything degrades quietly. localStorage can be full, disabled, or
 * corrupt; none of that should take down the app, so every read is
 * defensive and every write is best-effort.
 */

import type { ChatMessage } from "@/store/viberon";
import { normalizeSummary, type UsageSummary } from "@/lib/client/usage";

const INDEX_KEY = (repoKey: string) => `viberon.conv.index.${repoKey}`;
const RECORD_KEY = (repoKey: string, id: string) =>
  `viberon.conv.${repoKey}.${id}`;

/** Legacy single-thread key, migrated on first load. */
const LEGACY_KEY = (repoKey: string) => `viberon.chat.v2.${repoKey}`;

/** Keep the list navigable and localStorage inside its quota. */
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES_PER_CONVERSATION = 200;
const MAX_RUNS_PER_CONVERSATION = 40;

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  /** First line of the most recent message, for the list subtitle. */
  preview: string;
  /** True once the user renames it, so auto-titling stops overwriting. */
  titleLocked?: boolean;
}

/**
 * A finished run, compacted for persistence.
 *
 * The live `RunState` holds streamed text, tool traces, and full before/after
 * file contents — far too heavy to keep. This is the durable receipt: what
 * was asked, what changed, what it cost, and how to undo it.
 */
export interface StoredRun {
  id: string;
  prompt: string;
  intent?: "ask" | "build";
  status: string;
  startedAt: number;
  endedAt?: number;
  filesChanged: string[];
  agentCount: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  checkpointId?: string;
  /** Assistant message this run produced, for scroll-to linking. */
  messageId?: string;
  /** Compacted usage breakdown (absent on receipts saved before it existed). */
  usage?: UsageSummary;
}

/** Validate a stored receipt's usage; drop it if it is not a summary. */
function normalizeRun(run: StoredRun): StoredRun {
  if (run.usage === undefined) return run;
  const usage = normalizeSummary(run.usage);
  if (usage) return { ...run, usage };
  const rest = { ...run };
  delete rest.usage;
  return rest;
}

export interface StoredConversation {
  meta: ConversationMeta;
  messages: ChatMessage[];
  runs: StoredRun[];
}

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function readJson<T>(key: string): T | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): boolean {
  if (!canUseStorage()) return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeKey(key: string): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing useful to do.
  }
}

export function newConversationId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Derive a readable title from the first thing the user said. */
export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  if (!firstUser) return "New chat";
  const flat = firstUser.content.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  // Prefer a clause boundary so titles read as phrases, not truncations.
  const clause = flat.split(/[.!?\n]/)[0].trim();
  const source = clause.length >= 12 ? clause : flat;
  return source.length > 60 ? `${source.slice(0, 57)}…` : source;
}

function derivePreview(messages: ChatMessage[]): string {
  const last = messages.at(-1);
  if (!last?.content) return "";
  const flat = last.content.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? `${flat.slice(0, 97)}…` : flat;
}

/* ------------------------------- index ----------------------------------- */

export function loadIndex(repoKey: string): ConversationMeta[] {
  if (!repoKey) return [];
  const raw = readJson<ConversationMeta[]>(INDEX_KEY(repoKey));
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is ConversationMeta =>
        Boolean(m) && typeof m === "object" && typeof m.id === "string",
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function saveIndex(repoKey: string, metas: ConversationMeta[]): void {
  const trimmed = [...metas]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_CONVERSATIONS);

  // Anything evicted from the index must have its record dropped too, or it
  // becomes an orphan consuming quota forever.
  const kept = new Set(trimmed.map((m) => m.id));
  for (const meta of metas) {
    if (!kept.has(meta.id)) removeKey(RECORD_KEY(repoKey, meta.id));
  }

  writeJson(INDEX_KEY(repoKey), trimmed);
}

/* ------------------------------ records ---------------------------------- */

export function loadConversation(
  repoKey: string,
  id: string,
): StoredConversation | null {
  const raw = readJson<StoredConversation>(RECORD_KEY(repoKey, id));
  if (!raw || !Array.isArray(raw.messages)) return null;
  return {
    meta: raw.meta,
    messages: raw.messages.filter(
      (m) =>
        Boolean(m) &&
        typeof m.content === "string" &&
        (m.role === "user" || m.role === "assistant"),
    ),
    runs: Array.isArray(raw.runs)
      ? raw.runs.filter((r) => Boolean(r) && typeof r.id === "string").map(normalizeRun)
      : [],
  };
}

/**
 * Write a conversation and refresh its index entry.
 *
 * A conversation with no messages is not persisted — an untouched "New chat"
 * should not clutter the list just because it was opened.
 */
export function saveConversation(
  repoKey: string,
  conversation: StoredConversation,
): ConversationMeta[] {
  const index = loadIndex(repoKey);
  if (conversation.messages.length === 0) return index;

  const messages = conversation.messages.slice(-MAX_MESSAGES_PER_CONVERSATION);
  const runs = conversation.runs.slice(-MAX_RUNS_PER_CONVERSATION);

  const meta: ConversationMeta = {
    ...conversation.meta,
    title: conversation.meta.titleLocked
      ? conversation.meta.title
      : deriveTitle(messages),
    updatedAt: Date.now(),
    messageCount: messages.length,
    preview: derivePreview(messages),
  };

  const ok = writeJson(RECORD_KEY(repoKey, meta.id), { meta, messages, runs });
  if (!ok) {
    // Out of quota. Drop the oldest conversations and retry once, so the
    // current thread survives rather than silently failing to save.
    const survivors = index.slice(0, Math.max(1, Math.floor(index.length / 2)));
    for (const dropped of index.slice(survivors.length)) {
      removeKey(RECORD_KEY(repoKey, dropped.id));
    }
    saveIndex(repoKey, survivors);
    writeJson(RECORD_KEY(repoKey, meta.id), { meta, messages, runs });
  }

  const next = [meta, ...index.filter((m) => m.id !== meta.id)];
  saveIndex(repoKey, next);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function deleteConversation(
  repoKey: string,
  id: string,
): ConversationMeta[] {
  removeKey(RECORD_KEY(repoKey, id));
  const next = loadIndex(repoKey).filter((m) => m.id !== id);
  saveIndex(repoKey, next);
  return next;
}

export function renameConversation(
  repoKey: string,
  id: string,
  title: string,
): ConversationMeta[] {
  const clean = title.trim().slice(0, 80);
  if (!clean) return loadIndex(repoKey);

  const record = loadConversation(repoKey, id);
  if (record) {
    // `titleLocked` stops the next save from re-deriving over the new name.
    saveConversationRaw(repoKey, {
      ...record,
      meta: { ...record.meta, title: clean, titleLocked: true },
    });
  }

  const next = loadIndex(repoKey).map((m) =>
    m.id === id ? { ...m, title: clean, titleLocked: true } : m,
  );
  saveIndex(repoKey, next);
  return next;
}

/** Save without re-deriving the title. Used by rename. */
function saveConversationRaw(
  repoKey: string,
  conversation: StoredConversation,
): void {
  writeJson(RECORD_KEY(repoKey, conversation.meta.id), conversation);
}

export function createConversationMeta(): ConversationMeta {
  const now = Date.now();
  return {
    id: newConversationId(),
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    preview: "",
  };
}

/* ----------------------------- migration --------------------------------- */

/**
 * Fold the pre-history single thread into a conversation.
 *
 * Runs once per workspace: earlier builds stored one flat message array per
 * repo, and losing that on upgrade would look like the app deleted the
 * user's chat.
 */
export function migrateLegacyThread(repoKey: string): ConversationMeta | null {
  if (!repoKey || !canUseStorage()) return null;

  const legacy = readJson<ChatMessage[]>(LEGACY_KEY(repoKey));
  if (!Array.isArray(legacy) || legacy.length === 0) {
    removeKey(LEGACY_KEY(repoKey));
    return null;
  }

  const messages = legacy.filter(
    (m) =>
      Boolean(m) &&
      typeof m.content === "string" &&
      (m.role === "user" || m.role === "assistant"),
  );
  if (messages.length === 0) {
    removeKey(LEGACY_KEY(repoKey));
    return null;
  }

  const meta = createConversationMeta();
  saveConversation(repoKey, { meta, messages, runs: [] });
  removeKey(LEGACY_KEY(repoKey));
  return loadIndex(repoKey)[0] ?? meta;
}

/** Group conversations into the buckets the history list renders under. */
export function groupByRecency(
  metas: ConversationMeta[],
): { label: string; items: ConversationMeta[] }[] {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - 6 * 86_400_000;

  const buckets: Record<string, ConversationMeta[]> = {
    Today: [],
    Yesterday: [],
    "Previous 7 days": [],
    Older: [],
  };

  for (const meta of metas) {
    if (meta.updatedAt >= startOfToday) buckets.Today.push(meta);
    else if (meta.updatedAt >= startOfYesterday) buckets.Yesterday.push(meta);
    else if (meta.updatedAt >= startOfWeek) buckets["Previous 7 days"].push(meta);
    else buckets.Older.push(meta);
  }

  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
}

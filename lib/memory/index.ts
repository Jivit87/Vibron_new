/**
 * Project-memory read/write, derivation, and prompt rendering.
 *
 * Persistence is deliberately dual:
 *  - The canonical copy lives in the app store (keyed by repoKey), so it
 *    works for non-disk workspaces and survives even if the folder moves.
 *  - Disk-backed workspaces also get a mirrored `.viberon/MEMORY.md`, so a
 *    human (or a different tool) can read what the agents learned.
 */

import { createHash } from "node:crypto";

import type { Graph } from "@/lib/graph";
import { getValueRaw, setValueRaw } from "@/lib/store";
import { countTokens } from "@/lib/tokens";
import {
  emptyMemory,
  MEMORY_VERSION,
  type FileDigest,
  type MemoryEntry,
  type MemoryEntryKind,
  type MemoryTask,
  type ProjectMemory,
} from "@/lib/memory/types";

export * from "@/lib/memory/types";
export * from "@/lib/memory/graph";
export * from "@/lib/memory/lessons";
export { VAULT_DIR, vaultPath, type VaultGraph } from "@/lib/memory/vault";

const MEMORY_KEY = (repoKey: string) => `memory:${repoKey}`;

/** Caps keep the cached prefix small — memory must stay cheap to re-read. */
const MAX_ENTRIES: Record<MemoryEntryKind, number> = {
  convention: 30,
  decision: 60,
  fact: 80,
  suggestion: 40,
};
const MAX_TASKS = 200;

export async function loadMemory(repoKey: string): Promise<ProjectMemory> {
  const raw = await getValueRaw<ProjectMemory>(MEMORY_KEY(repoKey));
  if (!raw || raw.version !== MEMORY_VERSION) return emptyMemory(repoKey);
  // Defensive merge: a memory written by an older build may miss fields.
  return { ...emptyMemory(repoKey), ...raw, repoKey };
}

export async function saveMemory(memory: ProjectMemory): Promise<void> {
  memory.updatedAt = Date.now();
  await setValueRaw(MEMORY_KEY(memory.repoKey), memory);
}

/** Read-modify-write helper so callers never race on the stored blob. */
export async function mutateMemory(
  repoKey: string,
  mutate: (memory: ProjectMemory) => void | Promise<void>,
): Promise<ProjectMemory> {
  const memory = await loadMemory(repoKey);
  await mutate(memory);
  await saveMemory(memory);
  return memory;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function bucketFor(
  memory: ProjectMemory,
  kind: MemoryEntryKind,
): MemoryEntry[] {
  switch (kind) {
    case "convention":
      return memory.conventions;
    case "decision":
      return memory.decisions;
    case "fact":
      return memory.facts;
    case "suggestion":
      return memory.suggestions;
  }
}

/**
 * Record something learned. Near-duplicate text updates the existing entry
 * instead of appending, which is what keeps memory from growing unbounded
 * as agents re-observe the same facts across sessions.
 */
export function recordEntry(
  memory: ProjectMemory,
  kind: MemoryEntryKind,
  input: { text: string; why?: string; files?: string[]; author?: string },
): MemoryEntry {
  const bucket = bucketFor(memory, kind);
  const normalized = input.text.trim().toLowerCase().replace(/\s+/g, " ");

  const existing = bucket.find(
    (e) => e.text.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
  );
  if (existing) {
    existing.why = input.why ?? existing.why;
    existing.files = input.files ?? existing.files;
    existing.createdAt = Date.now();
    return existing;
  }

  const entry: MemoryEntry = {
    id: newId(kind.slice(0, 3)),
    kind,
    text: input.text.trim(),
    why: input.why?.trim(),
    files: input.files,
    author: input.author,
    createdAt: Date.now(),
  };
  bucket.push(entry);

  // Evict oldest unresolved entries past the cap.
  const cap = MAX_ENTRIES[kind];
  if (bucket.length > cap) bucket.splice(0, bucket.length - cap);
  return entry;
}

export function upsertTask(
  memory: ProjectMemory,
  input: Partial<MemoryTask> & { title: string },
): MemoryTask {
  const now = Date.now();
  if (input.id) {
    const existing = memory.tasks.find((t) => t.id === input.id);
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
      return existing;
    }
  }
  const task: MemoryTask = {
    id: input.id ?? newId("task"),
    title: input.title,
    detail: input.detail,
    status: input.status ?? "pending",
    role: input.role,
    files: input.files,
    dependsOn: input.dependsOn,
    createdAt: now,
    updatedAt: now,
  };
  memory.tasks.push(task);
  if (memory.tasks.length > MAX_TASKS) {
    // Drop the oldest finished tasks first; never drop live work.
    const finished = memory.tasks.filter(
      (t) => t.status === "done" || t.status === "cancelled",
    );
    const drop = new Set(
      finished
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, memory.tasks.length - MAX_TASKS)
        .map((t) => t.id),
    );
    memory.tasks = memory.tasks.filter((t) => !drop.has(t.id));
  }
  return task;
}

/* --------------------------- derived memory ------------------------------ */

function hashSource(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 12);
}

const STACK_HINTS: { dep: RegExp; label: string }[] = [
  { dep: /^next$/, label: "Next.js" },
  { dep: /^react$/, label: "React" },
  { dep: /^vue$/, label: "Vue" },
  { dep: /^svelte$/, label: "Svelte" },
  { dep: /^@angular\/core$/, label: "Angular" },
  { dep: /^express$/, label: "Express" },
  { dep: /^fastify$/, label: "Fastify" },
  { dep: /^hono$/, label: "Hono" },
  { dep: /^tailwindcss$/, label: "Tailwind CSS" },
  { dep: /^typescript$/, label: "TypeScript" },
  { dep: /^vitest$/, label: "Vitest" },
  { dep: /^jest$/, label: "Jest" },
  { dep: /^playwright$|^@playwright\/test$/, label: "Playwright" },
  { dep: /^prisma$|^@prisma\/client$/, label: "Prisma" },
  { dep: /^drizzle-orm$/, label: "Drizzle" },
  { dep: /^mongoose$/, label: "MongoDB" },
  { dep: /^pg$/, label: "PostgreSQL" },
  { dep: /^electron$/, label: "Electron" },
  { dep: /^zustand$/, label: "Zustand" },
  { dep: /^tanstack|^@tanstack/, label: "TanStack" },
  { dep: /^three$/, label: "Three.js" },
];

const ENTRY_CANDIDATES = [
  "app/page.tsx",
  "app/layout.tsx",
  "src/main.tsx",
  "src/main.ts",
  "src/index.tsx",
  "src/index.ts",
  "src/App.tsx",
  "index.html",
  "main.py",
  "server.js",
  "server.ts",
  "index.js",
  "index.ts",
  "README.md",
];

/**
 * Recompute the cheap, always-true half of memory from the workspace and
 * graph. Learned entries are never touched here.
 */
export function deriveMemory(
  memory: ProjectMemory,
  files: { path: string; source: string }[],
  graph: Graph | null,
): ProjectMemory {
  const byPath = new Map(files.map((f) => [f.path, f] as const));

  // --- stack + scripts from package.json ---------------------------------
  const pkgFile = byPath.get("package.json");
  const stack = new Set<string>();
  if (pkgFile) {
    try {
      const pkg = JSON.parse(pkgFile.source) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      memory.scripts = pkg.scripts ?? {};
      const deps = Object.keys({
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      });
      for (const dep of deps) {
        for (const hint of STACK_HINTS) {
          if (hint.dep.test(dep)) stack.add(hint.label);
        }
      }
    } catch {
      // Malformed package.json — leave stack detection to file extensions.
    }
  }
  if (
    byPath.has("requirements.txt") ||
    byPath.has("pyproject.toml") ||
    byPath.has("setup.py") ||
    byPath.has("setup.cfg")
  ) {
    stack.add("Python");
  }
  if (byPath.has("Cargo.toml")) stack.add("Rust");
  if (byPath.has("go.mod")) stack.add("Go");
  if (byPath.has("pom.xml") || byPath.has("build.gradle") || byPath.has("build.gradle.kts")) {
    stack.add("Java");
  }
  if (
    byPath.has("tsconfig.json") ||
    files.some((f) => /\.(tsx|[cm]?ts)$/.test(f.path) && !f.path.endsWith(".d.ts"))
  ) {
    stack.add("TypeScript");
  }
  if (
    files.some((f) => f.path.endsWith(".html")) &&
    !stack.has("Next.js") &&
    !stack.has("React")
  ) {
    stack.add("Static HTML/CSS/JS");
  }
  // A package.json with no recognised framework is still a Node.js project.
  if (pkgFile && stack.size === 0) stack.add("Node.js");
  memory.stack = [...stack].sort();

  // --- entry points ------------------------------------------------------
  memory.entryPoints = ENTRY_CANDIDATES.filter((p) => byPath.has(p)).slice(0, 6);

  // --- per-file digests (L1 index) ---------------------------------------
  const exportsByFile = new Map<string, string[]>();
  const importsByFile = new Map<string, Set<string>>();
  if (graph) {
    const fileById = new Map(graph.nodes.map((n) => [n.id, n.file] as const));
    for (const node of graph.nodes) {
      const list = exportsByFile.get(node.file) ?? [];
      list.push(node.name);
      exportsByFile.set(node.file, list);
    }
    for (const edge of graph.edges) {
      if (edge.kind !== "import") continue;
      const from = fileById.get(edge.source);
      const to = fileById.get(edge.target);
      if (!from || !to || from === to) continue;
      const set = importsByFile.get(from) ?? new Set<string>();
      set.add(to);
      importsByFile.set(from, set);
    }
  }

  const nextFiles: Record<string, FileDigest> = {};
  for (const file of files) {
    const hash = hashSource(file.source);
    const previous = memory.files[file.path];
    nextFiles[file.path] = {
      path: file.path,
      hash,
      tokens: previous?.hash === hash ? previous.tokens : countTokens(file.source),
      exports: (exportsByFile.get(file.path) ?? []).slice(0, 24),
      imports: [...(importsByFile.get(file.path) ?? [])].slice(0, 24),
      // Agent-written purposes survive edits; they describe intent, not text.
      purpose: previous?.purpose,
    };
  }
  memory.files = nextFiles;

  // --- overview ----------------------------------------------------------
  if (!memory.overview) {
    memory.overview = synthesizeOverview(memory, files.length);
  }

  memory.updatedAt = Date.now();
  return memory;
}

function synthesizeOverview(memory: ProjectMemory, fileCount: number): string {
  if (fileCount === 0) {
    return "Empty workspace. No files yet — this is a blank slate ready for a new project.";
  }
  const subject = memory.stack.length ? `A ${memory.stack.join(", ")} project` : "A project";
  return `${subject} with ${fileCount} tracked file${fileCount === 1 ? "" : "s"}. Entry points: ${
    memory.entryPoints.join(", ") || "not yet identified"
  }.`;
}

/* ------------------------- prompt rendering ------------------------------ */

function renderEntries(label: string, entries: MemoryEntry[], limit: number): string {
  const live = entries.filter((e) => !e.resolved).slice(-limit);
  if (live.length === 0) return "";
  const lines = live.map((e) =>
    e.why ? `- ${e.text} — ${e.why}` : `- ${e.text}`,
  );
  return `### ${label}\n${lines.join("\n")}`;
}

/**
 * Render memory into the cacheable system prefix.
 *
 * Order matters for prompt caching: the most stable content first, so a
 * change to (say) the task list does not invalidate the cached overview.
 */
export function renderMemoryPrompt(
  memory: ProjectMemory,
  opts: { includeTasks?: boolean; includeFileIndex?: boolean } = {},
): string {
  const parts: string[] = ["## PROJECT MEMORY"];

  if (memory.overview) {
    parts.push(`### What this project is\n${memory.overview}`);
  }
  if (memory.stack.length) {
    parts.push(`### Stack\n${memory.stack.join(" · ")}`);
  }
  if (memory.entryPoints.length) {
    parts.push(`### Entry points\n${memory.entryPoints.map((p) => `- \`${p}\``).join("\n")}`);
  }
  if (Object.keys(memory.scripts).length) {
    const scripts = Object.entries(memory.scripts)
      .slice(0, 12)
      .map(([name, cmd]) => `- \`${name}\`: \`${cmd}\``)
      .join("\n");
    parts.push(`### Runnable scripts\n${scripts}`);
  }

  const conventions = renderEntries("Conventions to follow", memory.conventions, 25);
  if (conventions) parts.push(conventions);

  const decisions = renderEntries("Decisions already made", memory.decisions, 30);
  if (decisions) parts.push(decisions);

  const facts = renderEntries("Known facts about this codebase", memory.facts, 40);
  if (facts) parts.push(facts);

  if (opts.includeTasks !== false) {
    const live = memory.tasks.filter(
      (t) => t.status !== "done" && t.status !== "cancelled",
    );
    if (live.length) {
      const lines = live
        .slice(0, 40)
        .map((t) => `- [${t.status}] ${t.title}${t.role ? ` (${t.role})` : ""}`);
      parts.push(`### Work in flight\n${lines.join("\n")}`);
    }
    const recentlyDone = memory.tasks
      .filter((t) => t.status === "done")
      .slice(-10);
    if (recentlyDone.length) {
      parts.push(
        `### Recently completed\n${recentlyDone.map((t) => `- ${t.title}`).join("\n")}`,
      );
    }
  }

  const openSuggestions = memory.suggestions.filter((s) => !s.resolved).slice(-15);
  if (openSuggestions.length) {
    parts.push(
      `### Open suggestions (not yet acted on)\n${openSuggestions
        .map((s) => `- ${s.text}`)
        .join("\n")}`,
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

/** Human-readable mirror written to `.viberon/MEMORY.md` in disk workspaces. */
export function renderMemoryMarkdown(memory: ProjectMemory): string {
  const when = new Date(memory.updatedAt).toISOString();
  return [
    "<!-- Generated by Viberon. Agents read and update this file. -->",
    "# Project memory",
    "",
    `_Last updated ${when}_`,
    "",
    renderMemoryPrompt(memory).replace(/^## PROJECT MEMORY\n?/, ""),
    "",
  ].join("\n");
}

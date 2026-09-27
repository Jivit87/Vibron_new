/**
 * Event-loop responsiveness benchmark on a synthetic large repo.
 *
 *   pnpm exec tsx scripts/bench-event-loop.ts [files=6000]
 *
 * Builds `<tmp>/viberon-bench-*` with N TypeScript files, points the disk
 * store at a temp dir, and measures, per phase, the worst event-loop stall
 * (a 5 ms interval probe's lateness + monitorEventLoopDelay max), wall time,
 * RSS and the persisted store size. The last phase starts a task that
 * indexes an issue worktree and times `cancel()` while it runs.
 */

import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const FILES = Number(process.argv[2]) || 6000;

async function makeRepo(root: string, count: number): Promise<number> {
  let bytes = 0;
  for (let i = 0; i < count; i += 1) {
    const dir = path.join(root, "src", `pkg${i % 60}`);
    await mkdir(dir, { recursive: true });
    const dep = (i * 7 + 3) % count;
    const lines = [
      `import { helper${dep} } from "../pkg${dep % 60}/mod${dep}";`,
      `export interface Shape${i} { id: number; name: string; tags: string[] }`,
      ...Array.from({ length: 12 }, (_, f) =>
        [
          `export function fn${i}_${f}(input: Shape${i}, limit = ${f}): number {`,
          `  let total = 0;`,
          `  for (const tag of input.tags) total += tag.length * limit + helper${dep}(total);`,
          `  return total > ${f * 10} ? total : fn${i}_${(f + 1) % 12}(input, limit + 1);`,
          `}`,
        ].join("\n"),
      ),
      `export function helper${i}(n: number): number { return n + ${i}; }`,
    ];
    const source = `${lines.join("\n")}\n`;
    bytes += source.length;
    await writeFile(path.join(dir, `mod${i}.ts`), source);
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "bench", scripts: {} }));
  return bytes;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}

interface PhaseResult {
  phase: string;
  wallMs: number;
  probeMaxMs: number;
  loopP99Ms: number;
  loopMaxMs: number;
  rssMb: number;
}

async function measure(phase: string, fn: () => Promise<unknown>): Promise<PhaseResult> {
  const histogram = monitorEventLoopDelay({ resolution: 5 });
  histogram.enable();
  let last = performance.now();
  let probeMax = 0;
  let rssPeak = process.memoryUsage().rss;
  const probe = setInterval(() => {
    const now = performance.now();
    probeMax = Math.max(probeMax, now - last - 5);
    last = now;
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  }, 5);
  const t0 = performance.now();
  await fn();
  const wallMs = performance.now() - t0;
  // Awaited synchronous work starves timers: count the final gap too.
  probeMax = Math.max(probeMax, performance.now() - last - 5);
  clearInterval(probe);
  histogram.disable();
  return {
    phase,
    wallMs: Math.round(wallMs),
    probeMaxMs: Math.round(probeMax),
    loopP99Ms: Math.round(histogram.percentile(99) / 1e6),
    loopMaxMs: Math.round(histogram.max / 1e6),
    rssMb: Math.round(rssPeak / 1e6),
  };
}

async function main() {
  const base = await mkdtemp(path.join(os.tmpdir(), "viberon-bench-"));
  const repo = path.join(base, "repo");
  const storeDir = path.join(base, "store");
  await mkdir(storeDir, { recursive: true });
  process.env.VIBERON_STORE_DIR = storeDir;
  delete process.env.VITEST;
  delete process.env.VIBERON_STORE;
  for (const key of Object.keys(process.env)) if (key.startsWith("FIREBASE") || key.startsWith("GOOGLE_")) delete process.env[key];

  const bytes = await makeRepo(repo, FILES);
  console.log(`fixture: ${FILES} files, ${(bytes / 1e6).toFixed(1)} MB at ${repo}`);

  const store = await import("@/lib/store");
  const disk = await import("@/lib/local-disk-workspace");
  const { TaskQueue } = await import("@/lib/tasks");
  const results: PhaseResult[] = [];

  let repoKey = "";
  results.push(
    await measure("register+index workspace", async () => {
      repoKey = (await disk.registerLocalWorkspace(repo)).repoKey;
    }),
  );
  results.push(
    await measure("write 5 files (patch)", async () => {
      for (let i = 0; i < 5; i += 1) {
        await disk.writeLocalWorkspaceFile(repoKey, `src/pkg${i}/mod${i}.ts`, `export function patched${i}() { return ${i}; }\n`);
      }
    }),
  );
  results.push(
    await measure("20 small store get/set", async () => {
      for (let i = 0; i < 20; i += 1) {
        await store.setValueRaw("tasks:v1", [{ id: `t${i}` }]);
        await store.getValueRaw("tasks:v1");
      }
    }),
  );
  await store.flushStoreForTests?.();
  const storeBytes = await dirSize(storeDir);

  // Start a task that registers (scans + indexes) an issue worktree, then cancel it.
  const holder = await mkdtemp(path.join(os.tmpdir(), "viberon-issue-"));
  const tree = path.join(holder, "repo");
  await cp(repo, tree, { recursive: true });
  const holder2 = await mkdtemp(path.join(os.tmpdir(), "viberon-issue-"));
  await cp(repo, path.join(holder2, "repo"), { recursive: true });
  results.push(
    await measure("register an issue worktree", async () => {
      await disk.registerLocalWorkspace(path.join(holder2, "repo"));
    }),
  );
  await rm(holder2, { recursive: true, force: true });
  let cancelMs = -1;
  let endedMs = -1;
  results.push(
    await measure("task: index issue worktree + cancel", async () => {
      const queue = new TaskQueue(
        {
          fix: async (_task, { signal }) => {
            await disk.registerLocalWorkspace(tree, {}, { signal }).catch(() => undefined);
            return signal.aborted ? { error: "Stopped." } : {};
          },
          review: async () => ({}),
        },
        { storeKey: "bench:tasks", cancelGraceMs: 10_000 },
      );
      const task = await queue.enqueue({ kind: "fix", repoKey: "bench", task: "x", source: "api" });
      // A cancel "request" arrives 1 s into the run: time from arrival
      // (timer due) until cancel() has returned.
      const t0 = await new Promise<number>((resolve) => {
        const due = performance.now() + 1000;
        setTimeout(() => {
          void queue.cancel(task.id).then(() => {
            cancelMs = performance.now() - due;
            resolve(due);
          });
        }, 1000);
      });
      await queue.idle();
      endedMs = performance.now() - t0;
    }),
  );

  console.table(results);
  console.log(`persisted store size: ${(storeBytes / 1e6).toFixed(2)} MB`);
  console.log(`cancel() returned in ${cancelMs.toFixed(1)} ms; task ended ${endedMs.toFixed(0)} ms after cancel`);
  if (!process.env.BENCH_KEEP) await rm(base, { recursive: true, force: true });
  await rm(holder, { recursive: true, force: true });
  process.exit(0);
}

void main();

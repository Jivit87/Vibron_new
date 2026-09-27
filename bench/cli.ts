/**
 * Benchmark entry (port of Pramana `pramana bench` + `bench/swebench/*.py`):
 *
 *   tsx bench/cli.ts quick|mini [--only a,b] [--model id] [--max-turns n] [--timeout sec]
 *   tsx bench/cli.ts swe-pick [--seed 0] [--data rows.json]          > ids.txt
 *   tsx bench/cli.ts swe-gold ids.txt [--data rows.json] [--out dir]  # env check, no model
 *   tsx bench/cli.ts swe-run  ids.txt --tag v1 [--shard k/n] [--model id] [--max-turns n]
 *   tsx bench/cli.ts swe-report v1 [v2 ...] [--out dir]
 *
 * Exit 0 when every task resolved, 1 when some did not, 2 on usage/setup errors.
 */

process.env.VIBERON_STORE ??= "memory";

import { readFileSync } from "node:fs";
import path from "node:path";

export interface BenchArgs {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

export function parseBenchArgs(argv: string[]): BenchArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2) as [string, string | undefined];
      const next = rest[i + 1];
      if (inline !== undefined) flags[key] = inline;
      else if (next !== undefined && !next.startsWith("--")) flags[key] = (i += 1, next);
      else flags[key] = "true";
    } else positional.push(a);
  }
  return { command, positional, flags };
}

const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
const readIds = (file: string) =>
  readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

export async function main(argv: string[], log = (l: string) => process.stderr.write(`${l}\n`)): Promise<number> {
  const { command, positional, flags } = parseBenchArgs(argv);
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : undefined;
  const sweResults = flags.out ? path.resolve(flags.out) : undefined;
  try {
    if (command === "quick" || command === "mini") {
      const { runEval } = await import("@/eval/run");
      const s = await runEval({
        suite: command,
        only: flags.only?.split(",").map((x) => x.trim()).filter(Boolean),
        model: flags.model,
        maxTurns: num(flags["max-turns"]),
        timeoutMs,
        log,
      });
      return s.resolved === s.total ? 0 : 1;
    }
    if (command === "swe-pick") {
      const [{ loadAllInstances, pickIds }, { SWE_DIR }] = await Promise.all([import("@/eval/swe/specs"), import("@/eval/swe/run")]);
      const rows = await loadAllInstances({ dataFile: flags.data, cacheDir: path.join(SWE_DIR, "..", ".cache", "swe") });
      process.stdout.write(`${pickIds(rows, Number(flags.seed ?? 0)).join("\n")}\n`);
      return 0;
    }
    if (command === "swe-gold" || command === "swe-run") {
      if (!positional[0]) throw new Error(`${command}: an ids file is required`);
      const { runSwe } = await import("@/eval/swe/run");
      const s = await runSwe({
        ids: readIds(positional[0]),
        gold: command === "swe-gold",
        tag: command === "swe-run" ? (flags.tag ?? "v1") : undefined,
        shard: flags.shard,
        model: flags.model,
        maxTurns: num(flags["max-turns"]),
        timeoutMs,
        dataFile: flags.data,
        resultsDir: sweResults,
        log,
      });
      return s.resolved === s.total ? 0 : 1;
    }
    if (command === "swe-report") {
      const [{ loadTag, renderSweReport }, { SWE_DIR }] = await Promise.all([import("@/eval/swe/report"), import("@/eval/swe/run")]);
      const dir = sweResults ?? path.join(SWE_DIR, "results");
      const tags = positional.length ? positional : ["v1"];
      const data = Object.fromEntries(await Promise.all(tags.map(async (t) => [t, await loadTag(dir, t)] as const)));
      process.stdout.write(renderSweReport(data));
      return 0;
    }
    log("usage: tsx bench/cli.ts quick|mini|swe-pick|swe-gold|swe-run|swe-report (see docs/BENCH.md)");
    return 2;
  } catch (error) {
    log(`bench ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

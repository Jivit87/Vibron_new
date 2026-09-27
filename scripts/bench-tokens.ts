/**
 * Token-breakdown benchmark: where do the input tokens of a solve go?
 *
 *   pnpm exec tsx scripts/bench-tokens.ts            # table for every scenario
 *   pnpm exec tsx scripts/bench-tokens.ts --json     # machine-readable
 *
 * No API keys: `solveTask` runs for real (snapshot, localize, gate, verify
 * commands on a temp copy of an `eval/tasks` fixture) against the scripted
 * `FakeProvider`, which records every request. Each request is then split
 * into what it re-sends:
 *
 *   system   the system prompt blocks
 *   tools    the tool schemas (JSON, as the provider sends them)
 *   task     the first user message (the issue + localized context)
 *   history  every later assistant turn (text + tool calls) and user nudge
 *   results  every tool_result block in the transcript
 *   fresh    tokens not in the previous request of the same agent (what a
 *            prompt cache cannot serve; everything else is a cache read)
 *
 * Counts use `countTokens` (gpt-tokenizer, o200k); providers differ by a few
 * percent but the proportions hold. Scenarios live here so
 * `tests/tokens.budget.test.ts` measures exactly the same runs.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { AiContent, AiTurnRequest } from "@/lib/ai/types";
import { solveTask } from "@/lib/harness/solve";
import type { SolveResult } from "@/lib/harness/solve-types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { countTokens } from "@/lib/tokens";
import type { VerifyCommand } from "@/lib/verify/types";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider, type ScriptedCall, type ScriptedTurn } from "../tests/helpers/fake-provider";
import { whoAsked, type Who } from "../tests/helpers/routed";
import { makeTmpRepo, shellRunner } from "../tests/helpers/tmp-repo";

// ---------------------------------------------------------------------------
// Measuring a request

export interface TurnBreakdown {
  /** 1-based call number across the whole solve. */
  call: number;
  who: Who;
  system: number;
  tools: number;
  task: number;
  history: number;
  results: number;
  total: number;
  /** Tokens not already in this agent's previous request (uncacheable). */
  fresh: number;
  /** Bytes of the serialized request (system + tools + messages). */
  bytes: number;
}

const blockText = (block: AiContent): string => {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return block.thinking;
    case "tool_use":
      return `${block.name} ${JSON.stringify(block.input)}`;
    case "tool_result":
      return block.content;
    default:
      return "";
  }
};

function serialize(req: AiTurnRequest): string {
  return JSON.stringify({ system: req.system, tools: req.tools ?? [], messages: req.messages });
}

/** Split one request into its parts. `prev` is the same agent's previous request. */
export function measureRequest(req: AiTurnRequest, call: number, prev?: AiTurnRequest): TurnBreakdown {
  const system = countTokens(req.system.map((b) => b.text).join("\n"));
  const tools = req.tools?.length ? countTokens(JSON.stringify(req.tools)) : 0;
  let task = 0;
  let history = 0;
  let results = 0;
  req.messages.forEach((message, index) => {
    for (const block of message.content) {
      const n = countTokens(blockText(block));
      if (block.type === "tool_result") results += n;
      else if (index === 0) task += n;
      else history += n;
    }
  });
  const total = system + tools + task + history + results;
  // Fresh = the part past the longest common prefix with the previous request.
  let fresh = total;
  if (prev) {
    const a = serialize(prev);
    const b = serialize(req);
    let i = 0;
    while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
    fresh = Math.min(total, countTokens(b.slice(i)));
  }
  return { call, who: whoAsked(req), system, tools, task, history, results, total, fresh, bytes: Buffer.byteLength(serialize(req)) };
}

export function measureRun(requests: AiTurnRequest[]): TurnBreakdown[] {
  const lastBy = new Map<Who, AiTurnRequest>();
  return requests.map((req, i) => {
    const who = whoAsked(req);
    const row = measureRequest(req, i + 1, lastBy.get(who));
    lastBy.set(who, req);
    return row;
  });
}

export interface RunTotals {
  calls: number;
  system: number;
  tools: number;
  task: number;
  history: number;
  results: number;
  total: number;
  fresh: number;
  bytes: number;
  /** Output tokens the scripted model produced (text + tool-call JSON). */
  output: number;
}

export function totals(rows: TurnBreakdown[], output = 0): RunTotals {
  const sum = (key: keyof TurnBreakdown) => rows.reduce((n, r) => n + (r[key] as number), 0);
  return {
    calls: rows.length,
    system: sum("system"),
    tools: sum("tools"),
    task: sum("task"),
    history: sum("history"),
    results: sum("results"),
    total: sum("total"),
    fresh: sum("fresh"),
    bytes: sum("bytes"),
    output,
  };
}

// ---------------------------------------------------------------------------
// Scenarios

const TASKS_DIR = path.join(process.cwd(), "eval", "tasks");
const REPRO_PATH = ".viberon/scratch/repro.js";
const BLIND_PATH = ".viberon/scratch/test_independent.js";

function readTree(dir: string, prefix = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(abs).isDirectory()) Object.assign(files, readTree(abs, rel));
    else files[rel] = readFileSync(abs, "utf8");
  }
  return files;
}

interface Fixture {
  files: Record<string, string>;
  issue: string;
}

function loadFixture(name: string): Fixture {
  const dir = path.join(TASKS_DIR, name);
  return { files: readTree(path.join(dir, "repo")), issue: readFileSync(path.join(dir, "issue.md"), "utf8") };
}

/** The text between `start` (inclusive) and `end` (exclusive) of `source`. */
function span(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`bench: fixture changed; cannot find ${JSON.stringify(start)}..${JSON.stringify(end)}`);
  return source.slice(a, b);
}

export interface Scenario {
  name: string;
  fixture: string;
  description: string;
  /** Solver turns, in order. Once exhausted, `loop` (if set) answers forever. */
  solver: (fx: Fixture) => ScriptedTurn[];
  loop?: (n: number) => ScriptedTurn;
  suite: VerifyCommand[];
  /** What the blind test writer drafts, if the harness asks for one. */
  blindTest: string;
  expectEdit: boolean;
}

const suite = (command: string): VerifyCommand[] => [
  { command, framework: "custom", kind: "test", source: "package.json test script" },
];

const TRUNCATE_FIX = [
  "function truncate(text, max, options = {}) {",
  "  const ellipsis = options.ellipsis === undefined ? \"...\" : String(options.ellipsis);",
  "  if (text.length <= max) return text;",
  "  const cut = text.slice(0, Math.max(0, max - ellipsis.length));",
  "  const lastSpace = cut.lastIndexOf(\" \");",
  "  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + ellipsis;",
  "}",
  "",
].join("\n");

const TRUNCATE_REPRO = [
  "const assert = require('node:assert');",
  "const { truncate } = require('../../src/truncate');",
  "assert.strictEqual(truncate('abcdefghij', 5), 'ab...');",
  "assert.strictEqual(truncate('abcdefghij', 5, { ellipsis: '…' }), 'abcd…');",
  "console.log('ok');",
  "",
].join("\n");

const SEMVER_FIX = [
  "function parse(version) {",
  "  const clean = version.split('+')[0];",
  "  const dash = clean.indexOf('-');",
  "  const core = dash === -1 ? clean : clean.slice(0, dash);",
  "  const pre = dash === -1 ? '' : clean.slice(dash + 1);",
  "  const [major, minor, patch] = core.split('.').map(Number);",
  "  return { major, minor, patch, pre: pre ? pre.split('.') : [] };",
  "}",
  "",
  "function compareIds(a, b) {",
  "  const na = /^\\d+$/.test(a);",
  "  const nb = /^\\d+$/.test(b);",
  "  if (na && nb) return Number(a) === Number(b) ? 0 : Number(a) < Number(b) ? -1 : 1;",
  "  if (na) return -1;",
  "  if (nb) return 1;",
  "  return a === b ? 0 : a < b ? -1 : 1;",
  "}",
  "",
  "// Returns -1, 0 or 1.",
  "function compare(a, b) {",
  "  const x = parse(a);",
  "  const y = parse(b);",
  "  for (const k of ['major', 'minor', 'patch']) {",
  "    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;",
  "  }",
  "  if (!x.pre.length || !y.pre.length) {",
  "    if (x.pre.length === y.pre.length) return 0;",
  "    return x.pre.length ? -1 : 1;",
  "  }",
  "  const n = Math.max(x.pre.length, y.pre.length);",
  "  for (let i = 0; i < n; i++) {",
  "    if (x.pre[i] === undefined) return -1;",
  "    if (y.pre[i] === undefined) return 1;",
  "    const c = compareIds(x.pre[i], y.pre[i]);",
  "    if (c) return c;",
  "  }",
  "  return 0;",
  "}",
  "",
].join("\n");

const SEMVER_REPRO = [
  "const assert = require('node:assert');",
  "const { compare } = require('../../src/semver');",
  "assert.strictEqual(compare('1.0.0-alpha', '1.0.0'), -1);",
  "assert.strictEqual(compare('1.0.0-alpha.10', '1.0.0-alpha.2'), 1);",
  "assert.strictEqual(compare('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);",
  "assert.strictEqual(compare('1.0.0+build.5', '1.0.0'), 0);",
  "console.log('ok');",
  "",
].join("\n");

const call = (name: string, input: Record<string, unknown>): ScriptedCall => ({ name, input });
const say = (text: string, ...calls: ScriptedCall[]): ScriptedTurn => ({ text, calls });

/** Realistic explore → edit → verify → finish, with a sentence of reasoning per turn. */
function fixTurns(opts: { symbol: string; file: string; test: string; find: string; replace: string; repro: string }): ScriptedTurn[] {
  return [
    say(`I'll locate \`${opts.symbol}\` and its tests first.`, call("grep", { pattern: opts.symbol })),
    say("Reading the implementation and the existing test.", call("read_file", { path: opts.file }), call("read_file", { path: opts.test })),
    say(
      "The root cause is clear. Adding a reproduction and fixing the implementation.",
      call("create_file", { path: REPRO_PATH, content: opts.repro }),
      call("edit_file", { path: opts.file, find: opts.find, replace: opts.replace, summary: "fix" }),
    ),
    say("Checking the reproduction and the existing suite.", call("run_command", { command: `node ${REPRO_PATH} && node --test ${opts.test}` })),
    say("", call("finish", { summary: `Fixed ${opts.symbol}: see the edit in ${opts.file}.`, reproduction: `node ${REPRO_PATH}` })),
  ];
}

/** A model that explores forever and never edits (the expensive failure mode). */
function exploreForever(n: number): ScriptedTurn {
  const moves: ScriptedCall[] = [
    call("grep", { pattern: "ellipsis" }),
    call("read_file", { path: "src/truncate.js" }),
    call("list_files", {}),
    call("read_file", { path: "test/truncate.test.js" }),
    call("grep", { pattern: `max${n % 7}` }),
  ];
  return say(`Let me look a bit more before changing anything (${n}).`, moves[n % moves.length]);
}

export const SCENARIOS: Scenario[] = [
  {
    name: "truncate-fix",
    fixture: "truncate-regression",
    description: "explore -> edit -> verify -> finish (JS, node --test)",
    solver: (fx) => {
      const src = fx.files["src/truncate.js"];
      return fixTurns({
        symbol: "truncate",
        file: "src/truncate.js",
        test: "test/truncate.test.js",
        find: span(src, "function truncate(", "\nmodule.exports"),
        replace: TRUNCATE_FIX,
        repro: TRUNCATE_REPRO,
      });
    },
    suite: suite("node --test test/truncate.test.js"),
    blindTest: TRUNCATE_REPRO,
    expectEdit: true,
  },
  {
    name: "semver-fix",
    fixture: "semver-js",
    description: "explore -> edit -> verify -> finish (JS, bigger rewrite)",
    solver: (fx) => {
      const src = fx.files["src/semver.js"];
      return fixTurns({
        symbol: "compare",
        file: "src/semver.js",
        test: "test/semver.test.js",
        find: span(src, "function parse(", "function sort("),
        replace: SEMVER_FIX,
        repro: SEMVER_REPRO,
      });
    },
    suite: suite("node --test test/semver.test.js"),
    blindTest: SEMVER_REPRO,
    expectEdit: true,
  },
  {
    name: "never-edits",
    fixture: "truncate-regression",
    description: "a model that only reads/greps until the harness stops it",
    solver: () => [],
    loop: exploreForever,
    suite: suite("node --test test/truncate.test.js"),
    blindTest: TRUNCATE_REPRO,
    expectEdit: false,
  },
];

// ---------------------------------------------------------------------------
// Running

export interface ScenarioResult {
  scenario: string;
  status: SolveResult["status"];
  filesChanged: string[];
  rows: TurnBreakdown[];
  totals: RunTotals;
  /** The harness's own accounting (fake usage is flat, so only calls matter). */
  modelCalls: number;
}

/** Budget knobs mirror a batch issue run (`lib/tasks/runners.ts`: maxTurns 30, fast mode). */
export const BENCH_MAX_TURNS = 30;

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  resetMemoryStoreForTests();
  const fx = loadFixture(scenario.fixture);
  const repo = makeTmpRepo(fx.files);
  const solverQueue = scenario.solver(fx);
  let loops = 0;
  let writerTurn = 0;
  let output = 0;
  const reply = (turn: ScriptedTurn): ScriptedTurn => {
    if (typeof turn !== "function" && "calls" in turn) {
      output += countTokens(turn.text ?? "") + (turn.calls ?? []).reduce((n, c) => n + countTokens(`${c.name} ${JSON.stringify(c.input ?? {})}`), 0);
    } else if (typeof turn !== "function" && "text" in turn) {
      output += countTokens(turn.text ?? "");
    }
    return turn;
  };
  const route = (req: AiTurnRequest): ScriptedTurn => {
    switch (whoAsked(req)) {
      case "reviewer":
        return reply({ text: JSON.stringify({ summary: "Looks correct.", effort: 1, tests: "adequate", findings: [] }) });
      case "criteria":
        return reply({ text: "1. The reported example behaves as the issue expects." });
      case "writer":
        // The blind writer: draft one regression test in scratch, then hand in its command.
        return reply(
          writerTurn++ === 0
            ? { calls: [{ name: "create_file", input: { path: BLIND_PATH, content: scenario.blindTest } }] }
            : { calls: [{ name: "done", input: { command: `node ${BLIND_PATH}` } }] },
        );
      default: {
        const next = solverQueue.shift();
        if (next) return reply(next);
        if (scenario.loop) return reply(scenario.loop(loops++));
        return reply({ text: "Done." });
      }
    }
  };
  const fake = installFakeProvider(Array.from({ length: 500 }, () => route));
  try {
    const meta = await registerLocalWorkspace(repo.root);
    const result = await solveTask({
      handle: await openWorkspace(meta.repoKey),
      task: fx.issue,
      model: "claude-opus-5",
      emit: () => {},
      runId: `bench-${scenario.name}`,
      budget: { maxTurns: BENCH_MAX_TURNS },
      verify: { enabled: true, commands: scenario.suite, timeoutMs: 30_000, baseline: true },
      runCheck: shellRunner,
      verifyServices: { relatedTestFiles: async () => scenario.suite.map((s) => s.command.split(" ").pop() ?? "") },
    });
    const rows = measureRun(fake.requests);
    return {
      scenario: scenario.name,
      status: result.status,
      filesChanged: result.filesChanged,
      rows,
      totals: totals(rows, output),
      modelCalls: result.metrics.modelCalls,
    };
  } finally {
    uninstallFakeProvider();
    repo.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Report

const pad = (v: string | number, w: number) => String(v).padStart(w);
const HEAD = ["call", "who", "system", "tools", "task", "history", "results", "total", "fresh", "bytes"];

export function formatTable(result: ScenarioResult): string {
  const widths = [4, 8, 7, 7, 7, 8, 8, 8, 7, 8];
  const line = (cells: (string | number)[]) => cells.map((c, i) => pad(c, widths[i])).join(" ");
  const out = [line(HEAD)];
  for (const r of result.rows) out.push(line([r.call, r.who, r.system, r.tools, r.task, r.history, r.results, r.total, r.fresh, r.bytes]));
  const t = result.totals;
  out.push(line(["sum", "", t.system, t.tools, t.task, t.history, t.results, t.total, t.fresh, t.bytes]));
  const pct = (n: number) => `${((100 * n) / Math.max(1, t.total)).toFixed(0)}%`;
  out.push(line(["%", "", pct(t.system), pct(t.tools), pct(t.task), pct(t.history), pct(t.results), "100%", pct(t.fresh), ""]));
  return out.join("\n");
}

async function main(): Promise<void> {
  const json = process.argv.includes("--json");
  const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const results: ScenarioResult[] = [];
  for (const scenario of SCENARIOS) {
    if (only.length && !only.includes(scenario.name)) continue;
    results.push(await runScenario(scenario));
  }
  if (json) {
    console.log(JSON.stringify(results.map(({ rows, ...rest }) => ({ ...rest, rows })), null, 2));
    return;
  }
  for (const r of results) {
    console.log(`\n## ${r.scenario}: ${r.status}, ${r.totals.calls} calls, files ${JSON.stringify(r.filesChanged)}`);
    console.log(formatTable(r));
  }
  console.log("\n## Summary (input tokens per issue)");
  console.log(["scenario", "calls", "input", "fresh", "output", "system", "tools", "task", "history", "results"].map((h) => pad(h, 12)).join(" "));
  for (const r of results) {
    const t = r.totals;
    console.log([r.scenario, t.calls, t.total, t.fresh, t.output, t.system, t.tools, t.task, t.history, t.results].map((v) => pad(v, 12)).join(" "));
  }
}

if (process.argv[1] && /bench-tokens\.ts$/.test(process.argv[1])) {
  process.env.VIBERON_STORE = "memory";
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

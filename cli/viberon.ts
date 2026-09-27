/**
 * `viberon` command line. Entry point is `cli/main.ts` (it sets
 * VIBERON_STORE=memory before any store module loads); this module has no
 * side effects so tests can import `parseCliArgs`.
 *
 *   viberon run --repo <path> (--task <spec> | --issue <spec> | --task-file <file>)
 *               [--worktree] [--keep-worktree] [--out <dir>] [--test-cmd <cmd>]
 *               [--no-gate] [--max-turns <n>] [--timeout <sec>] [--model <id>]
 *               [--task-id <id>] [--json] [--no-review] [--review-model <id>]
 *               [--deliver [--issue-url <url>]]
 *   viberon review [--repo <path>] [--base <ref> | --pr <url>] [--model <id>] [--json]
 *   viberon issues [--repo <path>] [--label <l>] [--fix <n,n|all>] [--no-deliver] [--model <id>] [--json]
 *   viberon clone <url|owner/repo|issue-url> [--ref <ref>] [--depth <n>] [--setup] [--json]
 *   viberon eval [--only a,b] [--model <id>] [--max-turns <n>] [--timeout <sec>]
 *   viberon swe --ids a,b [--model <id>] [--limit <n>] [--max-turns <n>] [--timeout <sec>] [--data <file>] [--out <dir>] [--gold]
 *   viberon arena report <results.jsonl> [--json]
 */

export const USAGE = `Usage:
  viberon run --repo <path> (--task <spec> | --issue <spec> | --task-file <file>) [options]
      <spec> is the task text, a GitHub issue URL, owner/repo#N, a file path, or - (stdin)
      --worktree          work in a detached git worktree of HEAD (original untouched)
      --keep-worktree     do not delete the worktree afterwards
      --out <dir>         evidence bundle dir (default <repo>/.viberon/runs/<task-id>)
      --test-cmd <cmd>    verification command (default: auto-detected)
      --no-gate           disable the verification gate
      --max-turns <n>     agent turn budget (default 40)
      --timeout <sec>     wall-clock budget
      --model <id>        model id (default $VIBERON_MODEL, else the best configured model)
      --task-id <id>      id used for the bundle directory
      --json              print result.json to stdout
      --no-review         skip the reviewer (on by default: a cheap model reviews an accepted fix for
                          missed sibling cases; a high finding sends it back once)
      --review-model <id> model for the reviewer (default: the cheapest agentic model)
      --independent-test  generate and execute a blind issue test with local runner permissions
      --deliver           on a verified fix: branch viberon/<slug>, commit, push, open a draft PR
      --issue-url <url>   with --deliver: comment the PR and evidence on this issue
                          (default: the task, when it is an issue URL)
  viberon review [--repo <path>] [--base <ref> | --pr <url>] [--model <id>] [--json]
      reviews the work tree against HEAD, against the merge base with --base, or a GitHub PR
  viberon issues [--repo <path>] [--label <l>] [--fix <n,n|all>] [--no-deliver] [--model <id>] [--json]
      lists the open GitHub issues of the repo's origin; --fix fixes them one by one, each in its own
      worktree of origin/<default>, and opens a draft PR for every fix its checks prove
  viberon clone <url|owner/repo|issue-url> [--ref <ref>] [--depth <n>] [--setup] [--json]
  viberon eval [--only a,b] [--model <id>] [--max-turns <n>] [--timeout <sec>]
  viberon swe --ids a,b [--model <id>] [--limit <n>] [--max-turns <n>] [--timeout <sec>] [--data <rows.json>] [--out <dir>] [--gold]
      SWE-bench Verified instances graded by their hidden tests (FAIL_TO_PASS / PASS_TO_PASS);
      --gold applies the official patch instead of running the agent (validates the environment)
  viberon arena report <results.jsonl> [--json]
      compares harnesses on tasks completed by every harness; ranks by fixes, tokens, then time

Exit codes (run): 0 resolved/unverified, 1 failed/incomplete, 2 error (delivery never changes them).
Exit codes (review): 0 reviewed, 2 error.
Exit codes (issues): 0 listed / every fix succeeded, 1 some fix failed, 2 error.`;

export interface RunArgs {
  command: "run";
  repo: string;
  task?: string;
  taskFile?: string;
  taskId?: string;
  worktree: boolean;
  keepWorktree: boolean;
  out?: string;
  testCmd?: string;
  noGate: boolean;
  maxTurns?: number;
  timeoutSec?: number;
  model?: string;
  json: boolean;
  deliver?: boolean;
  issueUrl?: string;
  review?: boolean;
  reviewModel?: string;
  independentTest?: boolean;
}

export interface ReviewArgs {
  command: "review";
  repo: string;
  base?: string;
  pr?: string;
  model?: string;
  json: boolean;
}

export interface IssuesArgs {
  command: "issues";
  repo: string;
  label?: string;
  fix?: number[] | "all";
  deliver: boolean;
  model?: string;
  json: boolean;
}

export interface CloneArgs {
  command: "clone";
  url: string;
  ref?: string;
  depth?: number;
  setup: boolean;
  json: boolean;
}

export interface EvalArgs {
  command: "eval";
  only?: string[];
  model?: string;
  maxTurns?: number;
  timeoutSec?: number;
}

export interface ArenaArgs {
  command: "arena";
  action: "report";
  file: string;
  json: boolean;
}

export interface SweArgs {
  command: "swe";
  ids: string[];
  model?: string;
  limit?: number;
  maxTurns?: number;
  timeoutSec?: number;
  data?: string;
  out?: string;
  gold: boolean;
}

export type CliArgs = RunArgs | ReviewArgs | IssuesArgs | CloneArgs | EvalArgs | SweArgs | ArenaArgs | { command: "help" };

export class CliError extends Error {}

const BOOLEAN_FLAGS = new Set(["worktree", "keep-worktree", "no-gate", "json", "setup", "help", "deliver", "review", "no-review", "no-deliver", "independent-test", "gold"]);

function splitFlags(argv: string[]): { flags: Map<string, string | true>; positionals: string[] } {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      if (arg === "-h") flags.set("help", true);
      else positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (BOOLEAN_FLAGS.has(name)) {
      flags.set(name, true);
      continue;
    }
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) throw new CliError(`--${name} needs a value`);
    flags.set(name, value);
  }
  return { flags, positionals };
}

function intFlag(flags: Map<string, string | true>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new CliError(`--${name} must be a positive number`);
  return value;
}

function stringFlag(flags: Map<string, string | true>, name: string): string | undefined {
  const raw = flags.get(name);
  return typeof raw === "string" ? raw : undefined;
}

const KNOWN: Record<string, Set<string>> = {
  run: new Set([
    "repo", "task", "issue", "task-file", "task-id", "worktree", "keep-worktree", "out", "test-cmd",
    "no-gate", "max-turns", "timeout", "model", "json", "help", "deliver", "issue-url",
    "review", "no-review", "review-model", "independent-test",
  ]),
  review: new Set(["repo", "base", "pr", "model", "json", "help"]),
  issues: new Set(["repo", "label", "fix", "no-deliver", "model", "json", "help"]),
  clone: new Set(["ref", "depth", "setup", "json", "help"]),
  eval: new Set(["only", "model", "max-turns", "timeout", "help"]),
  swe: new Set(["ids", "model", "limit", "max-turns", "timeout", "data", "out", "gold", "help"]),
  arena: new Set(["json", "help"]),
};

export function parseCliArgs(argv: string[]): CliArgs {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return { command: "help" };
  if (!(command in KNOWN)) throw new CliError(`Unknown command: ${command}`);
  const { flags, positionals } = splitFlags(rest);
  if (flags.has("help")) return { command: "help" };
  for (const name of flags.keys()) {
    if (!KNOWN[command]!.has(name)) throw new CliError(`Unknown option for ${command}: --${name}`);
  }

  if (command === "arena") {
    if (positionals[0] !== "report" || !positionals[1] || positionals.length > 2) {
      throw new CliError("arena: use report <results.jsonl>");
    }
    return { command, action: "report", file: positionals[1], json: flags.has("json") };
  }

  if (command === "run") {
    const repo = stringFlag(flags, "repo") ?? positionals[0];
    if (!repo) throw new CliError("run: --repo is required");
    const specs = [stringFlag(flags, "task"), stringFlag(flags, "issue")].filter((s) => s !== undefined);
    const task = specs[0];
    const taskFile = stringFlag(flags, "task-file");
    if (!task && !taskFile) throw new CliError("run: --task, --issue or --task-file is required");
    if (specs.length + (taskFile ? 1 : 0) > 1) throw new CliError("run: use only one of --task, --issue and --task-file");
    const issueUrl = stringFlag(flags, "issue-url");
    if (issueUrl && !flags.has("deliver")) throw new CliError("run: --issue-url needs --deliver");
    const reviewModel = stringFlag(flags, "review-model");
    if (reviewModel && flags.has("no-review")) throw new CliError("run: --review-model conflicts with --no-review");
    return {
      command,
      repo,
      task,
      taskFile,
      taskId: stringFlag(flags, "task-id"),
      worktree: flags.has("worktree"),
      keepWorktree: flags.has("keep-worktree"),
      out: stringFlag(flags, "out"),
      testCmd: stringFlag(flags, "test-cmd"),
      noGate: flags.has("no-gate"),
      maxTurns: intFlag(flags, "max-turns"),
      timeoutSec: intFlag(flags, "timeout"),
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
      ...(flags.has("deliver") ? { deliver: true } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      // The reviewer is on by default: it is the layer that catches incomplete fixes.
      review: !flags.has("no-review"),
      ...(reviewModel ? { reviewModel } : {}),
      ...(flags.has("independent-test") ? { independentTest: true } : {}),
    };
  }
  if (command === "review") {
    const base = stringFlag(flags, "base");
    const pr = stringFlag(flags, "pr");
    if (base && pr) throw new CliError("review: use only one of --base and --pr");
    return {
      command,
      repo: stringFlag(flags, "repo") ?? positionals[0] ?? ".",
      base,
      pr,
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
    };
  }
  if (command === "issues") {
    const fixRaw = stringFlag(flags, "fix");
    let fix: IssuesArgs["fix"];
    if (fixRaw === "all") fix = "all";
    else if (fixRaw !== undefined) {
      const numbers = fixRaw.split(",").map((s) => Number(s.trim().replace(/^#/, "")));
      if (!numbers.length || numbers.some((n) => !Number.isInteger(n) || n <= 0)) {
        throw new CliError("issues: --fix takes issue numbers (1,2,3) or all");
      }
      fix = numbers;
    }
    if (flags.has("no-deliver") && !fix) throw new CliError("issues: --no-deliver needs --fix");
    return {
      command,
      repo: stringFlag(flags, "repo") ?? positionals[0] ?? ".",
      label: stringFlag(flags, "label"),
      ...(fix ? { fix } : {}),
      deliver: !flags.has("no-deliver"),
      model: stringFlag(flags, "model"),
      json: flags.has("json"),
    };
  }
  if (command === "clone") {
    const url = positionals[0];
    if (!url) throw new CliError("clone: a repository URL is required");
    return {
      command,
      url,
      ref: stringFlag(flags, "ref"),
      depth: intFlag(flags, "depth"),
      setup: flags.has("setup"),
      json: flags.has("json"),
    };
  }
  if (command === "swe") {
    const ids = (stringFlag(flags, "ids") ?? positionals.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) throw new CliError("swe: --ids a,b is required");
    return {
      command,
      ids,
      model: stringFlag(flags, "model"),
      limit: intFlag(flags, "limit"),
      maxTurns: intFlag(flags, "max-turns"),
      timeoutSec: intFlag(flags, "timeout"),
      data: stringFlag(flags, "data"),
      out: stringFlag(flags, "out"),
      gold: flags.has("gold"),
    };
  }
  const only = stringFlag(flags, "only");
  return {
    command: "eval",
    only: only ? only.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    model: stringFlag(flags, "model"),
    maxTurns: intFlag(flags, "max-turns"),
    timeoutSec: intFlag(flags, "timeout"),
  };
}

/** Run the CLI; returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    return 2;
  }
  const log = (line: string) => process.stderr.write(`[viberon] ${line}\n`);

  if (args.command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (args.command === "arena") {
    try {
      const [{ readFile }, { parseArenaJsonl, summarizeArena, renderArenaMarkdown }] = await Promise.all([
        import("node:fs/promises"),
        import("@/eval/arena"),
      ]);
      const report = summarizeArena(parseArenaJsonl(await readFile(args.file, "utf8")));
      process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderArenaMarkdown(report));
      return report.commonTasks.length ? 0 : 1;
    } catch (error) {
      log(`arena report failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "run") {
    const { runHeadless } = await import("@/lib/headless/run");
    const outcome = await runHeadless({
      repo: args.repo,
      task: args.task,
      taskFile: args.taskFile,
      taskId: args.taskId,
      worktree: args.worktree,
      keepWorktree: args.keepWorktree,
      out: args.out,
      testCmd: args.testCmd,
      noGate: args.noGate,
      maxTurns: args.maxTurns,
      timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
      model: args.model,
      log,
      deliver: args.deliver,
      issueUrl: args.issueUrl,
      review: args.review,
      reviewModel: args.reviewModel,
      independentTest: args.independentTest,
    });
    if (args.json) process.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
    else {
      const r = outcome.result;
      const d = r.delivery;
      process.stdout.write(
        `${r.status.toUpperCase()}  ${r.filesChanged.length} file(s) changed  ${r.metrics.modelCalls} model calls  ` +
          `${(r.metrics.inputTokens + r.metrics.outputTokens).toLocaleString()} tokens  ${(r.metrics.durationMs / 1000).toFixed(0)}s\n` +
          `${r.error ? `error: ${r.error}\n` : ""}evidence: ${outcome.outDir}\n` +
          (d ? ("error" in d ? `not delivered: ${d.error}\n` : `pr: ${d.prUrl}  branch: ${d.branch}\n`) : ""),
      );
    }
    return outcome.exitCode;
  }

  if (args.command === "issues") {
    try {
      const [{ fixIssues, issueRows }, { getTaskQueue }, { registerLocalWorkspace }, path] = await Promise.all([
        import("@/lib/issues"),
        import("@/lib/tasks"),
        import("@/lib/local-disk-workspace"),
        import("node:path"),
      ]);
      const { repoKey } = await registerLocalWorkspace(path.resolve(args.repo));
      const { repo, issues } = await issueRows(repoKey, args.label ? [args.label] : []);
      if (!args.fix) {
        if (args.json) process.stdout.write(`${JSON.stringify({ repo, issues }, null, 2)}\n`);
        else {
          process.stdout.write(`${repo.owner}/${repo.repo}: ${issues.length} open issue${issues.length === 1 ? "" : "s"}\n`);
          for (const i of issues) process.stdout.write(`#${i.number}  ${i.title}${i.labels.length ? `  [${i.labels.join(", ")}]` : ""}\n`);
        }
        return 0;
      }
      const numbers = args.fix === "all" ? issues.map((i) => i.number) : args.fix;
      if (!numbers.length) {
        log("no open issues to fix");
        return 0;
      }
      const { tasks, skipped } = await fixIssues({ repoKey, numbers, deliver: args.deliver, model: args.model, source: "cli" });
      for (const s of skipped) log(`#${s.number} skipped: ${s.reason}`);
      log(`fixing ${tasks.length} issue${tasks.length === 1 ? "" : "s"} one at a time…`);
      const queue = getTaskQueue();
      await queue.idle();
      const done = await Promise.all(tasks.map((t) => queue.get(t.id)));
      if (args.json) process.stdout.write(`${JSON.stringify({ tasks: done, skipped }, null, 2)}\n`);
      for (const t of done) {
        if (!t) continue;
        const outcome = t.prUrl ?? t.error ?? t.note ?? t.state;
        log(`${t.task}: ${t.state} — ${outcome}`);
      }
      return done.some((t) => !t || t.state !== "done") ? 1 : 0;
    } catch (error) {
      log(`issues failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "review") {
    try {
      const [{ diffForTarget, parseReviewTarget, reviewDiff }, path] = await Promise.all([
        import("@/lib/review"),
        import("node:path"),
      ]);
      const root = path.resolve(args.repo);
      const target = parseReviewTarget(args.pr ? { prUrl: args.pr } : args.base ? { base: args.base } : "working");
      const diff = await diffForTarget(root, target);
      if (!diff.trim()) {
        log("nothing to review: no changes");
        return 0;
      }
      const result = await reviewDiff({ diff, model: args.model, ...(args.pr ? {} : { root }) });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`${result.summary}\neffort ${result.effort}/5  tests: ${result.tests}\n`);
        for (const f of result.findings) {
          process.stdout.write(`[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}  ${f.title}\n  ${f.detail}\n`);
        }
        if (result.security) process.stdout.write(`security: ${result.security}\n`);
      }
      return 0;
    } catch (error) {
      log(`review failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "clone") {
    const { cloneToWorkspace } = await import("@/lib/workspace/clone");
    try {
      const result = await cloneToWorkspace(args.url, {
        ref: args.ref,
        depth: args.depth,
        setup: args.setup,
        allowLocal: true,
        onProgress: log,
      });
      if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`${result.rootPath}\n`);
        if (result.issue) process.stdout.write(`issue: ${result.issue.title}\n`);
      }
      return 0;
    } catch (error) {
      log(`clone failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (args.command === "swe") {
    try {
      const { runSwe } = await import("@/eval/swe/run");
      const summary = await runSwe({
        ids: args.ids,
        model: args.model,
        limit: args.limit,
        maxTurns: args.maxTurns,
        timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
        dataFile: args.data,
        resultsDir: args.out,
        gold: args.gold,
        log,
      });
      return summary.resolved === summary.total ? 0 : 1;
    } catch (error) {
      log(`swe failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  const { runEval } = await import("@/eval/run");
  const summary = await runEval({
    only: args.only,
    model: args.model,
    maxTurns: args.maxTurns,
    timeoutMs: args.timeoutSec ? args.timeoutSec * 1000 : undefined,
    log,
  });
  return summary.resolved === summary.total ? 0 : 1;
}

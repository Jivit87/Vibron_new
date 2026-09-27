/**
 * PR checks, Open SWE `/baby-sit` style: read the check runs on the PR head,
 * pull the failing Actions job logs down to their failure excerpts, and
 * either seed a fix task (`ciFixTask`) or re-run a job the user says is
 * flaky. A re-run needs written evidence and is capped at 3 per head sha
 * (persisted in the store, so a restart does not reset it).
 */

import { DeliverError } from "@/lib/deliver/errors";
import {
  actionsJobId,
  getJobLogs,
  getPullRequest,
  listCheckRuns,
  parsePrUrl,
  rerunJob,
  type ApiOptions,
  type PrRef,
} from "@/lib/github-api";
import { getValueRaw, setValueRaw } from "@/lib/store";
import { withLock } from "@/lib/tasks/lock";
import { extractFailures } from "@/lib/verify/extract";

export const MAX_RERUNS_PER_HEAD = 3;
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
const MAX_LOGS = 5;

export interface CiCheck {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  logExcerpt?: string;
}

export interface CiStatus {
  headSha: string;
  state: "pending" | "success" | "failure";
  checks: CiCheck[];
}

function prRef(prUrl: string): PrRef {
  const pr = parsePrUrl(prUrl ?? "");
  if (!pr) throw new DeliverError("prUrl must be a GitHub pull request URL (https://github.com/o/r/pull/N).", "invalid_input", 400);
  return pr;
}

/**
 * failure if any check failed (so a fix can start before the rest finish),
 * else pending while any runs or none has registered yet, else success.
 */
export async function ciStatus(input: { prUrl: string }, opts?: ApiOptions): Promise<CiStatus> {
  const pr = prRef(input.prUrl);
  const head = (await getPullRequest(pr, opts)).head.sha;
  const runs = await listCheckRuns(pr, head, opts);
  let logs = 0;
  const checks = await Promise.all(
    runs.map(async (run): Promise<CiCheck> => {
      const check: CiCheck = { name: run.name, status: run.status, conclusion: run.conclusion, url: run.html_url };
      const job = actionsJobId(run);
      if (run.conclusion && FAILED.has(run.conclusion) && job !== null && logs++ < MAX_LOGS) {
        const log = await getJobLogs(pr, job, opts).catch(() => "");
        const excerpt = log ? extractFailures(log, 3000).trim() : "";
        if (excerpt) check.logExcerpt = excerpt;
      }
      return check;
    }),
  );
  const state = checks.some((c) => c.conclusion && FAILED.has(c.conclusion))
    ? "failure"
    : !checks.length || checks.some((c) => c.status !== "completed")
      ? "pending"
      : "success";
  return { headSha: head, state, checks };
}

/** Task text for "Fix CI": the failing checks and their extracted failures. */
export function ciFixTask(status: CiStatus): string {
  const failed = status.checks.filter((c) => c.conclusion && FAILED.has(c.conclusion));
  if (!failed.length) return "";
  return [
    `CI is failing on this branch (head ${status.headSha.slice(0, 12)}). Fix the code so these checks pass.`,
    "Do not edit .github/workflows or weaken the tests; fix the cause.",
    ...failed.flatMap((c) => [
      "",
      `### ${c.name} (${c.conclusion})`,
      c.url,
      ...(c.logExcerpt ? ["```", c.logExcerpt, "```"] : ["(no log excerpt available)"]),
    ]),
  ].join("\n");
}

interface RerunLedger {
  count: number;
  reruns: { checkName: string; evidence: string; at: number }[];
}

const ledgerKey = (pr: PrRef, sha: string) => `ci-reruns:${pr.owner}/${pr.repo}@${sha}`;

export async function rerunFlaky(
  input: { prUrl: string; checkName: string; evidence: string },
  opts?: ApiOptions,
): Promise<{ ok: true; attempt: number; remaining: number }> {
  const pr = prRef(input.prUrl);
  const checkName = input.checkName?.trim();
  const evidence = input.evidence?.trim().replace(/\s+/g, " ").slice(0, 500) ?? "";
  if (!checkName) throw new DeliverError("checkName is required.", "invalid_input", 400);
  if (evidence.length < 10) {
    throw new DeliverError(
      "Evidence is required to re-run a check as flaky: say what in the log shows a transient failure (network timeout, runner lost, …).",
      "no_evidence",
      400,
    );
  }
  const head = (await getPullRequest(pr, opts)).head.sha;
  const key = ledgerKey(pr, head);
  // read → rerun → write is one critical section per head sha, so concurrent
  // requests cannot all see count < 3 and exceed the cap together.
  return withLock(key, async () => {
    const ledger = (await getValueRaw<RerunLedger>(key)) ?? { count: 0, reruns: [] };
    if (ledger.count >= MAX_RERUNS_PER_HEAD) {
      throw new DeliverError(
        `Flaky re-run limit reached: ${MAX_RERUNS_PER_HEAD} re-runs already for head ${head.slice(0, 12)}. Fix the failure instead.`,
        "rerun_limit",
        429,
      );
    }
    const run = (await listCheckRuns(pr, head, opts)).find((r) => r.name === checkName);
    if (!run) throw new DeliverError(`No check named "${checkName}" on head ${head.slice(0, 12)}.`, "not_found", 404);
    if (run.status !== "completed" || !run.conclusion || !FAILED.has(run.conclusion)) {
      throw new DeliverError(`Check "${checkName}" has not failed; nothing to re-run.`, "not_failed", 409);
    }
    const job = actionsJobId(run);
    if (job === null) throw new DeliverError(`Check "${checkName}" is not a GitHub Actions job; re-run it in its own CI.`, "not_actions", 400);
    await rerunJob(pr, job, opts);
    const next: RerunLedger = { count: ledger.count + 1, reruns: [...ledger.reruns, { checkName, evidence, at: Date.now() }] };
    await setValueRaw(key, next, 30 * 24 * 3600);
    return { ok: true as const, attempt: next.count, remaining: MAX_RERUNS_PER_HEAD - next.count };
  });
}

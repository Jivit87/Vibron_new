/**
 * Evidence bundle (Pramana `report/evidence.py`): every headless run leaves a
 * self-contained, reviewable record next to result.json.
 *
 *   evidence.json  machine-readable facts: verdict, checks, usage, timings, config (never a key)
 *   report.html    the report, styled, with the checks table and the diff
 *   scratch/       the agent's reproduction scripts, moved out of the repo
 *   ../index.html  every run in the runs directory at a glance
 *
 * The target repository is left with only the fix: `.viberon/scratch` is
 * moved into the bundle.
 */

import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SolveResult } from "@/lib/harness/solve-types";
import { diffstat, STATUS_TEXT } from "@/lib/headless/report";
import type { VerificationReport, VerifyCommand } from "@/lib/verify/types";

export const EVIDENCE_SCHEMA_VERSION = 1;

/** Pramana verdicts: what one check proves, from its outcome before and after the patch. */
export type CheckVerdict = "fixes" | "passes" | "still_failing" | "regression" | "fails_after" | "inconclusive";

export interface EvidenceCheck {
  verdict: CheckVerdict;
  origin: "gate" | "test" | "independent";
  command: string;
  before: string;
  after: string;
}

export interface EvidenceInput {
  taskId: string;
  task: string;
  repo: string;
  model: string;
  exitCode: number;
  startedAt: string;
  result: SolveResult;
  verifyCommands: VerifyCommand[];
  /** Non-secret run options (turn budget, gate on/off, ...). */
  config?: Record<string, unknown>;
}

export interface Evidence {
  schemaVersion: number;
  taskId: string;
  title: string;
  status: SolveResult["status"];
  statusText: string;
  exitCode: number;
  error: string | null;
  repo: string;
  model: string;
  startedAt: string;
  summary: string;
  patch: { files: number; added: number; removed: number; paths: string[] };
  checks: EvidenceCheck[];
  gate: { enabled: boolean; command: string | null; ranAfterLastEdit: boolean; rejections: number; reason: string };
  attempts: number;
  recovery: SolveResult["recovery"];
  usage: {
    inputTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    totalTokens: number;
    modelCalls: number;
    toolCalls: number;
    costUsd: number;
  };
  elapsedS: number;
  phaseMs: Record<string, number>;
  verifyCommands: string[];
  config: Record<string, unknown>;
}

export const VERDICT_ICON: Record<CheckVerdict, string> = {
  fixes: "FIXES",
  passes: "passes",
  still_failing: "STILL FAILING",
  regression: "REGRESSION",
  fails_after: "FAILS AFTER",
  inconclusive: "inconclusive",
};

const SECRET_KEY_RE = /(key|token|secret|password|authorization|credential)/i;
const SECRET_VALUE_RE = /\b(sk-[\w-]{12,}|nvapi-[\w-]{12,}|gsk_[\w]{12,}|gh[pousr]_[\w]{20,}|AIza[\w-]{20,}|xox[abp]-[\w-]{10,})\b/g;

/** Drop secret-named fields and mask anything that looks like a credential or equals a key in the environment. */
export function redact<T>(value: T, env: Record<string, string | undefined> = process.env): T {
  const secrets = Object.entries(env)
    .filter(([k, v]) => v && v.length >= 12 && /(_KEY|_TOKEN|_SECRET)$/i.test(k))
    .map(([, v]) => v!);
  const scrub = (s: string) => {
    let out = s.replace(SECRET_VALUE_RE, "[redacted]");
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k) && typeof inner === "string") continue;
        out[k] = walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

function outcome(r: VerificationReport | null): string {
  if (!r) return "-";
  const c = r.counts;
  return `${c.passed} passed, ${c.failed} failed, ${c.errors} errors (${r.timedOut ? "timed out" : `exit ${r.exitCode}`})`;
}

function ok(r: VerificationReport | null): boolean | null {
  if (!r) return null;
  return !r.timedOut && r.exitCode === 0;
}

/** Before/after checks: the gate command, each test it fixed or broke, and the blind independent test. */
export function evidenceChecks(result: SolveResult): EvidenceCheck[] {
  const g = result.gate;
  const checks: EvidenceCheck[] = [];
  if (g.enabled && g.command) {
    const before = ok(g.baseline);
    const after = ok(g.final);
    const verdict: CheckVerdict = g.newFailures.length
      ? "regression"
      : after === null
        ? "inconclusive"
        : after
          ? before === false || g.fixed.length
            ? "fixes"
            : "passes"
          : before === false
            ? "still_failing"
            : "fails_after";
    checks.push({ verdict, origin: "gate", command: g.command, before: outcome(g.baseline), after: outcome(g.final) });
  }
  for (const t of g.fixed) checks.push({ verdict: "fixes", origin: "test", command: t, before: "fail", after: "pass" });
  for (const t of g.newFailures) checks.push({ verdict: "regression", origin: "test", command: t, before: "pass", after: "fail" });
  const it = result.independentTest;
  if (it) {
    const verdict: CheckVerdict = it.status === "inconclusive" ? "inconclusive" : it.status;
    const before = it.status === "fixes" || it.status === "still_failing" ? "fail" : it.status === "regression" ? "pass" : "-";
    const after = it.status === "fixes" || it.status === "passes" ? "pass" : it.status === "inconclusive" ? "-" : "fail";
    checks.push({ verdict, origin: "independent", command: it.command ?? "(blind issue test)", before, after });
  }
  return checks;
}

export function titleOf(task: string, fallback: string): string {
  return task.trim().split("\n")[0]!.slice(0, 120) || fallback;
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const { result } = input;
  const m = result.metrics;
  const g = result.gate;
  return redact({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    taskId: input.taskId,
    title: titleOf(input.task, input.taskId),
    status: result.status,
    statusText: STATUS_TEXT[result.status],
    exitCode: input.exitCode,
    error: result.error ?? null,
    repo: input.repo,
    model: input.model,
    startedAt: input.startedAt,
    summary: result.summary,
    patch: diffstat(result.diff),
    checks: evidenceChecks(result),
    gate: { enabled: g.enabled, command: g.command, ranAfterLastEdit: g.ranAfterLastEdit, rejections: g.rejections, reason: g.reason },
    attempts: 1 + result.recovery.rollbacks,
    recovery: result.recovery,
    usage: {
      inputTokens: m.inputTokens,
      cachedTokens: m.cacheReadTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      outputTokens: m.outputTokens,
      totalTokens: m.inputTokens + m.outputTokens,
      modelCalls: m.modelCalls,
      toolCalls: m.toolCalls,
      costUsd: m.costUsd,
    },
    elapsedS: Math.round(m.durationMs / 100) / 10,
    phaseMs: m.phaseMs ?? {},
    verifyCommands: input.verifyCommands.map((c) => c.command),
    config: input.config ?? {},
  });
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const n = (x: number) => x.toLocaleString("en-US");

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f2328;--muted:#656d76;--card:#fff;--line:#e5e1d8;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--accent:#b4582c}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15171a;--fg:#e6e6e6;--muted:#9aa4ae;--card:#1d2024;--line:#2f343a;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#e0875a}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;margin:0;padding:24px 16px}
main{max-width:980px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}
h2{font-size:16px;margin:28px 0 8px;color:var(--accent);text-transform:uppercase;letter-spacing:.06em}
.badge{display:inline-block;padding:6px 12px;border-radius:8px;font-weight:600;margin:10px 0}
.resolved{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.unverified,.incomplete{background:color-mix(in srgb,var(--warn) 16%,transparent);color:var(--warn)}
.failed,.error{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0;overflow-x:auto}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kv div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.kv b{display:block;font-size:20px}.kv span{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.05em}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
code,pre{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}pre{margin:0;white-space:pre}
.add{color:var(--ok)}.del{color:var(--bad)}.hunk{color:var(--accent)}
.v-fixes{color:var(--ok);font-weight:600}.v-regression,.v-still_failing,.v-fails_after{color:var(--bad);font-weight:600}
.sub{color:var(--muted);font-size:12px}a{color:var(--fg)}
`;

function page(title: string, body: string, extraCss = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}${extraCss}</style></head><body><main>
${body}
</main></body></html>
`;
}

export function renderHtml(ev: Evidence, diff: string): string {
  const u = ev.usage;
  const rows = ev.checks
    .map(
      (c) =>
        `<tr><td class="v-${esc(c.verdict)}">${esc(VERDICT_ICON[c.verdict])}</td><td>${esc(c.origin)}</td><td><code>${esc(c.command)}</code></td><td>${esc(c.before)}</td><td>${esc(c.after)}</td></tr>`,
    )
    .join("");
  const diffHtml = diff
    .split("\n")
    .map((line) => {
      const cls =
        line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : line.startsWith("@@")
              ? "hunk"
              : "";
      return `<span class="${cls}">${esc(line)}</span>`;
    })
    .join("\n");
  const r = ev.recovery;
  const phases = Object.entries(ev.phaseMs)
    .map(([k, v]) => `${esc(k)} ${(v / 1000).toFixed(1)}s`)
    .join(", ");
  return page(
    "Viberon run report",
    `<h1>${esc(ev.title)}</h1>
<div class="sub">${esc(ev.taskId)} · ${esc(ev.repo)} · exit ${ev.exitCode}</div>
<div class="badge ${esc(ev.status)}">${esc(ev.statusText)}</div>
<div class="kv">
<div><span>tokens in</span><b>${n(u.inputTokens)}</b></div>
<div><span>cached</span><b>${n(u.cachedTokens)}</b></div>
<div><span>tokens out</span><b>${n(u.outputTokens)}</b></div>
<div><span>model calls</span><b>${u.modelCalls}</b></div>
<div><span>wall time</span><b>${ev.elapsedS.toFixed(0)}s</b></div>
<div><span>attempts</span><b>${ev.attempts}</b></div>
<div><span>patch</span><b>+${ev.patch.added} / -${ev.patch.removed}</b></div>
<div><span>model</span><b style="font-size:14px">${esc(ev.model)}</b></div>
</div>
${ev.summary ? `<h2>Root cause and fix</h2><div class="card">${esc(ev.summary)}</div>` : ""}
${ev.error ? `<h2>Error</h2><div class="card">${esc(ev.error)}</div>` : ""}
<h2>Evidence (each check on the original code and on the patched code)</h2>
<div class="card"><table><tr><th>verdict</th><th>origin</th><th>check</th><th>original code</th><th>with patch</th></tr>${rows || '<tr><td colspan="5">no checks ran</td></tr>'}</table>
<p class="sub">Gate: ${esc(ev.gate.reason || "-")}; ran after last edit: ${ev.gate.ranAfterLastEdit ? "yes" : "no"}; rejections: ${ev.gate.rejections}</p></div>
<h2>Patch</h2><div class="card"><p class="sub">${ev.patch.files} file(s): ${ev.patch.paths.map(esc).join(", ") || "(no changes)"}</p><pre>${diff.trim() ? diffHtml : "(empty)"}</pre></div>
<h2>Attempts and recovery</h2><div class="card">${ev.attempts} attempt(s); checkpoints ${r.checkpoints}, rollbacks ${r.rollbacks}, stuck events ${r.stuckEvents}, best checkpoint restored: ${r.restoredBest ? "yes" : "no"}; ${u.toolCalls} tool calls${u.costUsd ? `; $${u.costUsd.toFixed(4)}` : ""}${phases ? `<div class="sub">phases: ${phases}</div>` : ""}</div>`,
  );
}

/** runs/index.html: every run at a glance (verdict, proof checks, tokens, time, links). */
export async function writeIndex(runsDir: string): Promise<string> {
  const rows: Array<{ id: string; ev: Evidence }> = [];
  for (const entry of await readdir(runsDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    try {
      const ev = JSON.parse(await readFile(path.join(runsDir, entry.name, "evidence.json"), "utf8")) as Evidence;
      rows.push({ id: entry.name, ev });
    } catch {
      // Not a run (or a partial one): skip it.
    }
  }
  rows.sort((a, b) => (b.ev.startedAt ?? "").localeCompare(a.ev.startedAt ?? "") || b.id.localeCompare(a.id));
  const body = rows
    .map(({ id, ev }) => {
      const checks = ev.checks ?? [];
      const fixes = checks.filter((c) => c.verdict === "fixes").length;
      const u = ev.usage ?? ({} as Evidence["usage"]);
      return `<tr><td><span class="badge ${esc(ev.status)}">${esc(ev.status)}</span></td><td><a href="${esc(encodeURIComponent(id))}/report.html">${esc((ev.title ?? id).slice(0, 90))}</a><div class="sub">${esc(id)} · ${esc(ev.model)}</div></td><td>${fixes}/${checks.length}</td><td>${n(u.totalTokens ?? 0)}</td><td>${n(u.cachedTokens ?? 0)}</td><td>${u.modelCalls ?? 0}</td><td>${(ev.elapsedS ?? 0).toFixed(0)}s</td><td>+${ev.patch?.added ?? 0} / -${ev.patch?.removed ?? 0}</td></tr>`;
    })
    .join("");
  const resolved = rows.filter((r) => r.ev.status === "resolved").length;
  const tokens = rows.reduce((s, r) => s + (r.ev.usage?.totalTokens ?? 0), 0);
  const html = page(
    "Viberon runs",
    `<h1>Viberon · run history</h1>
<div class="kv"><div><span>runs</span><b>${rows.length}</b></div><div><span>verified fixes</span><b>${resolved}</b></div><div><span>tokens (all runs)</span><b>${n(tokens)}</b></div></div>
<div class="card"><table><tr><th>verdict</th><th>task</th><th>proof checks</th><th>tokens</th><th>cached</th><th>calls</th><th>time</th><th>patch</th></tr>${body}</table></div>`,
    "td .badge{margin:0;padding:3px 8px;font-size:12px}",
  );
  const out = path.join(runsDir, "index.html");
  await writeFile(out, html);
  return out;
}

/**
 * Move `<root>/<scratchRel>` into `<outDir>/scratch` so the repository keeps
 * only the fix. Returns the number of entries moved (0 when there was none).
 */
export async function moveScratch(root: string, scratchRel: string, outDir: string): Promise<number> {
  const src = path.join(root, scratchRel);
  if (!existsSync(src)) return 0;
  const entries = await readdir(src);
  if (entries.length) {
    const dest = path.join(outDir, "scratch");
    await mkdir(dest, { recursive: true });
    for (const name of entries) {
      const from = path.join(src, name);
      const to = path.join(dest, name);
      await rm(to, { recursive: true, force: true });
      try {
        await rename(from, to);
      } catch {
        // Cross-device (tmp worktree → out dir): copy, then remove.
        await cp(from, to, { recursive: true });
        await rm(from, { recursive: true, force: true });
      }
    }
  }
  await rm(src, { recursive: true, force: true });
  return entries.length;
}

/** Write evidence.json + report.html, move scratch into the bundle, refresh the runs index. */
export async function writeEvidenceBundle(
  input: EvidenceInput & { outDir: string; workRoot: string; scratchRel: string },
): Promise<Evidence> {
  const ev = buildEvidence(input);
  await Promise.all([
    writeFile(path.join(input.outDir, "evidence.json"), `${JSON.stringify(ev, null, 2)}\n`),
    writeFile(path.join(input.outDir, "report.html"), renderHtml(ev, input.result.diff)),
    moveScratch(input.workRoot, input.scratchRel, input.outDir).catch(() => 0),
  ]);
  await writeIndex(path.dirname(input.outDir)).catch(() => undefined);
  return ev;
}

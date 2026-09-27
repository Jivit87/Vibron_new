"use client";

/**
 * Eval results: one row per task, totals at the bottom. Reads
 * `GET /api/eval`; `?mock=1` shows a canned table.
 */

import { useEffect, useState } from "react";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { evalTotals, MOCK_EVAL, normalizeEval, type EvalRow, type EvalTable } from "@/lib/client/eval";
import { isMockMode } from "@/lib/client/mock-run";
import { formatAgo, formatDuration, formatTokens } from "@/components/vibe/primitives";

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ok"; table: EvalTable };

const STATUS_COLOR: Record<string, string> = {
  resolved: "var(--vb-mint)",
  unverified: "var(--vb-amber)",
  incomplete: "var(--vb-amber)",
  failed: "var(--vb-rose)",
  error: "var(--vb-rose)",
};

const GATE_COLOR: Record<string, string> = {
  accept: "var(--vb-text-mid)",
  accept_unverified: "var(--vb-amber)",
  reject: "var(--vb-rose)",
  give_up: "var(--vb-text-dim)",
};

export function EvalView() {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  // Read after mount: the server render has no query string to look at.
  const [mock, setMock] = useState(false);

  async function fetchResults() {
    setLoad({ state: "loading" });
    if (isMockMode()) {
      setLoad({ state: "ok", table: normalizeEval(MOCK_EVAL) });
      return;
    }
    try {
      const response = await fetch("/api/eval", { cache: "no-store" });
      if (response.status === 404) {
        setLoad({ state: "missing" });
        return;
      }
      if (!response.ok) {
        setLoad({ state: "error", message: `GET /api/eval returned ${response.status}` });
        return;
      }
      setLoad({ state: "ok", table: normalizeEval(await response.json()) });
    } catch (error) {
      setLoad({ state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  useEffect(() => {
    setMock(isMockMode());
    void fetchResults();
  }, []);

  const rows = load.state === "ok" ? load.table.rows : [];
  const totals = evalTotals(rows);

  return (
    <div className="min-h-screen" style={{ background: "var(--vb-bg-base)", color: "var(--vb-text)" }}>
      <header
        className="flex h-9 items-center gap-2 border-b px-3"
        style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}
      >
        <a
          href={mock ? "/?mock=1" : "/"}
          className="inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[12px] hover:bg-[var(--vb-hover)]"
          style={{ color: "var(--vb-text-dim)" }}
        >
          <ArrowLeft className="size-3.5" />
          Workspace
        </a>
        <span className="text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
          Eval results
        </span>
        <div className="flex-1" />
        <button type="button" className="vb-btn vb-btn-ghost" onClick={() => void fetchResults()}>
          <RefreshCw className="size-3.5" />
          Reload
        </button>
      </header>

      <main className="mx-auto w-full max-w-[1040px] px-4 py-5 sm:px-6">
        {load.state === "ok" && rows.length > 0 && (
          <div className="mb-4 flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <p className="text-[20px] font-semibold tabular-nums" style={{ color: "var(--vb-text-hi)" }}>
              {totals.resolved}/{totals.count}
              <span className="ml-2 text-[12.5px] font-normal" style={{ color: "var(--vb-text-dim)" }}>
                resolved ({Math.round(totals.rate * 100)}%)
              </span>
            </p>
            <p className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {formatTokens(totals.tokens)} tok total · {formatTokens(totals.meanTokens)} per task ·{" "}
              {formatDuration(totals.durationMs)}
            </p>
            <div className="flex-1" />
            <p className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {[load.table.model, load.table.generatedAt ? formatAgo(load.table.generatedAt) : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        )}

        {load.state === "loading" && <Note>Loading results…</Note>}
        {load.state === "missing" && (
          <Note>
            No eval endpoint in this build. Results appear here once <code className="font-mono">GET /api/eval</code>{" "}
            is available.
          </Note>
        )}
        {load.state === "error" && <Note tone="error">{load.message}</Note>}
        {load.state === "ok" && rows.length === 0 && (
          <Note>
            No eval runs recorded yet. Run <code className="font-mono">bin/viberon eval</code> to score the harness on the bench tasks.
          </Note>
        )}

        {rows.length > 0 && <ResultsTable rows={rows} totals={totals} />}
      </main>
    </div>
  );
}

function ResultsTable({ rows, totals }: { rows: EvalRow[]; totals: ReturnType<typeof evalTotals> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-collapse text-[12.5px]">
        <thead>
          <tr className="text-left text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            <th className="border-b py-1.5 pr-3 font-normal" style={{ borderColor: "var(--vb-line)" }}>Task</th>
            <th className="w-[110px] border-b py-1.5 pr-3 font-normal" style={{ borderColor: "var(--vb-line)" }}>Result</th>
            <th className="w-[150px] border-b py-1.5 pr-3 font-normal" style={{ borderColor: "var(--vb-line)" }}>Gate</th>
            <th className="w-[90px] border-b py-1.5 pr-3 text-right font-normal" style={{ borderColor: "var(--vb-line)" }}>Tokens</th>
            <th className="w-[80px] border-b py-1.5 text-right font-normal" style={{ borderColor: "var(--vb-line)" }}>Time</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.task} className="hover:bg-[var(--vb-hover)]">
              <td className="border-b py-[5px] pr-3" style={{ borderColor: "var(--vb-line-faint)" }}>
                <span className="font-mono text-[12px]" style={{ color: "var(--vb-text-hi)" }}>
                  {row.task}
                </span>
                {row.category && (
                  <span className="ml-2 text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                    {row.category}
                  </span>
                )}
              </td>
              <td className="border-b py-[5px] pr-3" style={{ borderColor: "var(--vb-line-faint)" }}>
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-[6px] rounded-full" style={{ background: STATUS_COLOR[row.status] ?? "var(--vb-text-faint)" }} />
                  <span style={{ color: row.resolved ? "var(--vb-text)" : "var(--vb-text-mid)" }}>{row.status}</span>
                </span>
              </td>
              <td className="border-b py-[5px] pr-3 font-mono text-[11.5px]" style={{ borderColor: "var(--vb-line-faint)", color: GATE_COLOR[row.gate] ?? "var(--vb-text-dim)" }}>
                {row.gate ? row.gate.replace(/_/g, " ") : "—"}
              </td>
              <td className="border-b py-[5px] pr-3 text-right font-mono text-[11.5px] tabular-nums" style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-mid)" }}>
                {row.tokens ? formatTokens(row.tokens) : "—"}
              </td>
              <td
                className="border-b py-[5px] text-right font-mono text-[11.5px] tabular-nums"
                style={{ borderColor: "var(--vb-line-faint)", color: "var(--vb-text-mid)" }}
                title={row.phaseMs ? Object.entries(row.phaseMs).map(([name, ms]) => `${name} ${formatDuration(ms)}`).join("\n") : undefined}
              >
                {row.durationMs ? formatDuration(row.durationMs) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="text-[12px]" style={{ color: "var(--vb-text)" }}>
            <td className="py-2 pr-3">Total · {totals.count} tasks</td>
            <td className="py-2 pr-3">
              {totals.resolved} resolved
            </td>
            <td className="py-2 pr-3 font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {Math.round(totals.rate * 100)}%
            </td>
            <td className="py-2 pr-3 text-right font-mono text-[11.5px] tabular-nums">{formatTokens(totals.tokens)}</td>
            <td className="py-2 text-right font-mono text-[11.5px] tabular-nums">{formatDuration(totals.durationMs)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Note({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <p className="py-6 text-[12.5px]" style={{ color: tone === "error" ? "var(--vb-rose)" : "var(--vb-text-dim)" }}>
      {children}
    </p>
  );
}

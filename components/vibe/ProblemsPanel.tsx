"use client";

/**
 * Problems: checker output (tsc, ESLint) grouped by file, VS Code-style.
 * Click a row to jump to it; "Add to chat" hands the list to the agent.
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, CircleAlert, Info, MessageSquarePlus, Play, TriangleAlert } from "lucide-react";

import { attachProblems } from "@/lib/client/attach";
import { installCommand, looksLikeMissingDeps, runShell } from "@/lib/client/run-shell";
import { groupProblems, type Problem } from "@/lib/client/workspace-types";
import { useProblems } from "@/store/problems";
import { useViberon } from "@/store/viberon";
import { cx, EmptyState, IconButton, splitPath } from "@/components/vibe/primitives";

export function ProblemsPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const { problems, checkers, running, virtual, lastRunAt, error, unavailable, diagnostics } = useProblems();
  const [query, setQuery] = useState("");
  const [showErrors, setShowErrors] = useState(true);
  const [showWarnings, setShowWarnings] = useState(true);

  useEffect(() => {
    if (repoKey && lastRunAt === null) void useProblems.getState().load(repoKey);
  }, [repoKey, lastRunAt]);

  const all = useMemo<Problem[]>(() => {
    const editor: Problem[] = Object.entries(diagnostics).flatMap(([file, list]) =>
      list.map((d) => ({ file, line: d.line, col: d.col, severity: d.severity, message: d.message, source: d.source ?? "editor" })),
    );
    return [...problems, ...editor];
  }, [problems, diagnostics]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((p) => {
      if (p.severity === "error" && !showErrors) return false;
      if (p.severity !== "error" && !showWarnings) return false;
      if (!q) return true;
      return (
        p.file.toLowerCase().includes(q) ||
        p.message.toLowerCase().includes(q) ||
        (p.code ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, query, showErrors, showWarnings]);

  const groups = useMemo(() => groupProblems(filtered), [filtered]);
  const errors = all.filter((p) => p.severity === "error").length;
  const warnings = all.length - errors;

  const fileList = useViberon((s) => s.fileList);
  const missingDeps =
    !running && lastRunAt !== null && looksLikeMissingDeps([error ?? undefined, ...checkers.map((c) => c.note), ...problems.slice(0, 50).map((p) => p.message)]);
  const install = installCommand(fileList);

  const checkerNote = checkers
    .map((c) => `${c.checker}${c.ran === false ? " skipped" : ""}${c.durationMs ? ` ${(c.durationMs / 1000).toFixed(1)}s` : ""}`)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[30px] shrink-0 items-center gap-1.5 px-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter"
          aria-label="Filter problems"
          className="vb-input h-[22px] w-48 text-[12px]"
        />
        <FilterToggle active={showErrors} onClick={() => setShowErrors((v) => !v)} title="Errors">
          <CircleAlert className="size-3.5" style={{ color: "var(--vb-rose)" }} />
          <span className="font-mono">{errors}</span>
        </FilterToggle>
        <FilterToggle active={showWarnings} onClick={() => setShowWarnings((v) => !v)} title="Warnings">
          <TriangleAlert className="size-3.5" style={{ color: "var(--vb-amber)" }} />
          <span className="font-mono">{warnings}</span>
        </FilterToggle>
        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
          {running ? "Running checks…" : error ? error : checkerNote}
        </span>
        <button
          type="button"
          className="vb-btn vb-btn-ghost"
          disabled={filtered.length === 0}
          onClick={() => attachProblems(filtered)}
          title="Attach these problems to the chat"
        >
          <MessageSquarePlus className="size-3.5" />
          Add to chat
        </button>
        <button
          type="button"
          className="vb-btn"
          disabled={running || virtual || unavailable}
          onClick={() => void useProblems.getState().runChecks(repoKey)}
        >
          <Play className="size-3" />
          Run checks
        </button>
        <button
          type="button"
          className="vb-btn vb-btn-ghost"
          disabled={running || virtual || unavailable}
          title="Run the test suite too; failing tests are listed with their file and line"
          onClick={() => void useProblems.getState().runChecks(repoKey, { tests: true })}
        >
          Run tests
        </button>
      </div>

      {missingDeps && (
        <div className="mx-2 mb-1 flex items-center gap-2 border-l-2 py-0.5 pl-2 text-[12px]" style={{ borderColor: "var(--vb-amber)", color: "var(--vb-text)" }}>
          <span className="min-w-0 flex-1 truncate">Checks failed on missing dependencies. Install them first, then run checks again.</span>
          <button type="button" className="vb-btn" onClick={() => void runShell(repoKey, install)} title={install}>
            Install dependencies
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {unavailable ? (
          <EmptyState title="Checks are not available" body="This server does not expose the problems API yet." />
        ) : virtual ? (
          <EmptyState title="No folder on disk" body="Open a local folder to run tsc and ESLint." />
        ) : groups.length === 0 ? (
          <EmptyState
            title={lastRunAt === null ? "Checks have not run yet" : "No problems"}
            body={lastRunAt === null ? "Run checks to type-check and lint the workspace." : undefined}
          />
        ) : (
          groups.map((group) => <FileGroup key={group.file || "(project)"} file={group.file} problems={group.problems} errors={group.errors} warnings={group.warnings} />)
        )}
      </div>
    </div>
  );
}

function FilterToggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${active ? "Hide" : "Show"} ${title.toLowerCase()}`}
      aria-pressed={active}
      className={cx(
        "inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[11.5px] hover:bg-[var(--vb-hover)]",
        !active && "opacity-40",
      )}
      style={{ color: "var(--vb-text-mid)" }}
    >
      {children}
    </button>
  );
}

function FileGroup({
  file,
  problems,
  errors,
  warnings,
}: {
  file: string;
  problems: Problem[];
  errors: number;
  warnings: number;
}) {
  const [open, setOpen] = useState(true);
  const { name, dir } = splitPath(file || "(project)");
  return (
    <div className="flex flex-col">
      <div className="group flex h-[22px] items-center gap-1 pl-1 pr-2 hover:bg-[var(--vb-hover)]">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <ChevronRight className={cx("size-3.5 shrink-0", open && "rotate-90")} style={{ color: "var(--vb-text-dim)" }} />
          <span className="truncate text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
            {name}
          </span>
          <span className="min-w-0 truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
            {dir}
          </span>
        </button>
        <span className="hidden group-hover:flex">
          <IconButton title="Add this file's problems to chat" onClick={() => attachProblems(problems)}>
            <MessageSquarePlus className="size-3.5" />
          </IconButton>
        </span>
        <span
          className="min-w-[18px] rounded-[3px] px-1 text-center font-mono text-[10.5px]"
          style={{ background: "var(--vb-fill)", color: "var(--vb-text-mid)" }}
          title={`${errors} errors, ${warnings} warnings`}
        >
          {problems.length}
        </span>
      </div>
      {open &&
        problems.map((p, i) => (
          <button
            key={`${p.line}:${p.col}:${i}`}
            type="button"
            onClick={() => {
              if (!p.file) return;
              useViberon.getState().openTab(p.file, undefined, { preview: true });
              useProblems.getState().requestReveal(p.file, p.line, p.col);
            }}
            className="flex h-[22px] items-center gap-1.5 pl-6 pr-2 text-left hover:bg-[var(--vb-hover)]"
            title={p.message}
          >
            <SeverityIcon severity={p.severity} />
            <span className="min-w-0 truncate text-[12.5px]" style={{ color: "var(--vb-text)" }}>
              {p.message}
            </span>
            <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {p.source}
              {p.code ? `(${p.code})` : ""}
            </span>
            <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              [{p.line}, {p.col}]
            </span>
          </button>
        ))}
    </div>
  );
}

function SeverityIcon({ severity }: { severity: Problem["severity"] }) {
  if (severity === "error") return <CircleAlert className="size-3.5 shrink-0" style={{ color: "var(--vb-rose)" }} />;
  if (severity === "warning") return <TriangleAlert className="size-3.5 shrink-0" style={{ color: "var(--vb-amber)" }} />;
  return <Info className="size-3.5 shrink-0" style={{ color: "var(--vb-text-dim)" }} />;
}

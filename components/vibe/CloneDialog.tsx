"use client";

/**
 * Clone a repository (or the repo behind a GitHub issue) and open it.
 *
 * One input, one button, then the server's progress lines in a compact log.
 * On success it navigates to the new workspace; an issue URL also leaves the
 * issue waiting in the composer in Fix mode.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { GitBranch, Loader2, X } from "lucide-react";

import {
  cloneRepository,
  parseCloneInput,
  recordClone,
  stashPendingFix,
  type CloneEvent,
} from "@/lib/client/clone";
import { isMockMode } from "@/lib/client/mock-run";
import { useViberon } from "@/store/viberon";
import { Kbd } from "@/components/vibe/primitives";

type Phase = "idle" | "running" | "done" | "error";

export function CloneDialog() {
  const router = useRouter();
  const open = useViberon((s) => s.cloneOpen);
  const setOpen = useViberon((s) => s.setCloneOpen);
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    setPhase("idle");
    setLog([]);
    setError(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  if (!open) return null;

  const target = parseCloneInput(value);
  const running = phase === "running";

  function close() {
    abortRef.current?.abort();
    abortRef.current = null;
    setOpen(false);
  }

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!target || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("running");
    setError(null);
    setLog([]);
    const result = await cloneRepository(
      target.url,
      (e: CloneEvent) => {
        if (e.type === "progress") setLog((prev) => [...prev.slice(-199), e.text]);
      },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    if (result.type !== "done") {
      setPhase("error");
      setError(result.type === "error" ? result.message : "Clone failed.");
      return;
    }
    setPhase("done");
    setLog((prev) => [...prev, `Opening ${result.label}`]);
    recordClone({ repoKey: result.repoKey, label: result.label, url: target.url, rootPath: result.rootPath });
    const store = useViberon.getState();
    if (result.repoKey === store.repoKey) {
      // Same workspace (mock mode, or a re-clone): no navigation needed.
      if (result.issue) {
        if (store.appMode === "ide") store.setAgentDockOpen(true);
        store.setComposerDraft({ text: "", interaction: "fix", issue: result.issue });
      }
      setOpen(false);
      return;
    }
    if (result.issue) stashPendingFix(result.repoKey, result.issue);
    // Client-side navigation: no full reload, and the shell (chat or IDE) stays as it is.
    router.push(`/workspace/${encodeURIComponent(result.repoKey)}${isMockMode() ? "?mock=1" : ""}`);
    setOpen(false);
  }

  const hint = !value.trim()
    ? "A git URL, owner/repo, or a GitHub issue URL"
    : target
      ? target.kind === "issue"
        ? `Clone ${target.label.split("#")[0]} and open issue #${target.number} in Fix mode`
        : `Clone ${target.label}`
      : "Not a repository or issue URL";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh]"
      style={{ background: "rgba(0,0,0,0.25)" }}
      onMouseDown={() => !running && close()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Clone repository"
        className="vb-pop vb-in w-full max-w-[560px] overflow-hidden rounded-[4px]"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex h-8 items-center gap-2 border-b px-3" style={{ borderColor: "var(--vb-line-faint)" }}>
          <GitBranch className="size-3.5" style={{ color: "var(--vb-text-dim)" }} />
          <span className="text-[12.5px]" style={{ color: "var(--vb-text-hi)" }}>
            Clone repository
          </span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="inline-flex size-5 items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)]"
            style={{ color: "var(--vb-text-dim)" }}
          >
            <X className="size-3.5" />
          </button>
        </div>

        <form onSubmit={submit} className="flex flex-col gap-1.5 px-3 pb-3 pt-2.5">
          <div className="flex gap-1.5">
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={running}
              placeholder="https://github.com/owner/repo  ·  owner/repo  ·  issue URL"
              aria-label="Repository or issue URL"
              spellCheck={false}
              className="vb-input h-[28px] min-w-0 flex-1 font-mono text-[12px]"
            />
            <button type="submit" className="vb-btn vb-btn-primary h-[28px]" disabled={!target || running}>
              {running ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {running ? "Cloning" : target?.kind === "issue" ? "Clone and fix" : "Clone"}
            </button>
          </div>
          <p
            className="text-[11.5px]"
            style={{ color: value.trim() && !target ? "var(--vb-amber)" : "var(--vb-text-dim)" }}
          >
            {hint}
          </p>

          {(log.length > 0 || error) && (
            <div
              ref={logRef}
              className="mt-1 max-h-[180px] overflow-y-auto rounded-[3px] border px-2 py-1.5 font-mono text-[11.5px] leading-[1.6]"
              style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-mid)" }}
              aria-live="polite"
            >
              {log.map((line, i) => (
                <div key={i} className="truncate" title={line}>
                  {line}
                </div>
              ))}
              {error && <div style={{ color: "var(--vb-rose)" }}>{error}</div>}
            </div>
          )}

          <div className="mt-1 flex items-center gap-3 text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            <span>
              Cloned into <span className="font-mono">~/Viberon/repos</span>, then indexed.
            </span>
            <div className="flex-1" />
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> {running ? "cancel" : "close"}
            </span>
          </div>
        </form>
      </div>
    </div>
  );
}

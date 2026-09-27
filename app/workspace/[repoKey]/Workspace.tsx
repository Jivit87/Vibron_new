"use client";

/**
 * Workspace entry point.
 *
 * Thin wrapper: hydrate persisted chat history for this workspace, keep it
 * saved as the conversation grows, and hand off to the shell. Everything
 * else lives in `AppShell`.
 */

import { useEffect, useState } from "react";

import { AppShell } from "@/components/vibe/AppShell";
import { ProgressBar } from "@/components/ProgressBar";
import type { Graph } from "@/lib/graph";
import { sendPrompt } from "@/lib/client/agent-stream";
import { useViberon } from "@/store/viberon";

export interface WorkspaceProps {
  graph: Graph | null;
  jobId?: string;
  repoKey: string;
  repoLabel?: string;
  repoRef?: string;
  rootPath?: string;
  /** Prompt to auto-send on load, e.g. from a deep link. */
  initialQuery?: string;
}

export function Workspace({
  graph,
  jobId,
  repoKey,
  repoLabel,
  repoRef,
  rootPath,
  initialQuery,
}: WorkspaceProps) {
  // The graph an ingest job finished building while this page was open.
  const [ingested, setIngested] = useState<Graph | null>(null);
  const ready = graph ?? ingested;

  // Load this workspace's chat history and open the most recent thread.
  // A deep-linked prompt starts fresh instead, so the incoming request is not
  // appended to whatever the user was last discussing.
  useEffect(() => {
    if (!repoKey) return;
    const store = useViberon.getState();
    store.hydrateConversations(repoKey);
    if (initialQuery) store.newConversation();
  }, [repoKey, initialQuery]);

  // Persist on change, debounced. Streaming mutates `messages` on nearly
  // every frame; writing to localStorage that often would stall the UI.
  useEffect(() => {
    if (!repoKey) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useViberon.subscribe((state, previous) => {
      if (state.messages === previous.messages) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => useViberon.getState().persistConversation(), 600);
    });

    // A tab closed mid-stream must not lose the thread.
    const flush = () => useViberon.getState().persistConversation();
    window.addEventListener("beforeunload", flush);

    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [repoKey]);

  // Deep-linked prompt: fire once, after the shell has bound the workspace.
  useEffect(() => {
    const seed = initialQuery?.trim();
    if (!seed) return;
    const timer = setTimeout(() => void sendPrompt(seed), 400);
    return () => clearTimeout(timer);
  }, [initialQuery]);

  // An ingest job is still building the graph — show progress rather than an
  // empty IDE the user cannot do anything with yet.
  if (!ready && jobId) {
    return (
      <div
        className="flex h-screen w-full items-center justify-center"
        style={{ color: "var(--vb-text)" }}
      >
        <div className="flex w-full max-w-md flex-col gap-4 p-6">
          <p
            className="text-[11px] font-semibold uppercase tracking-[0.04em]"
            style={{ color: "var(--vb-text-faint)" }}
          >
            Indexing your code
          </p>
          <ProgressBar jobId={jobId} onComplete={() => setIngested(useViberon.getState().graph ?? null)} />
        </div>
      </div>
    );
  }

  return (
    <AppShell
      repoKey={repoKey}
      repoLabel={repoLabel ?? "Workspace"}
      repoRef={repoRef}
      rootPath={rootPath}
      graph={ready}
    />
  );
}

export default Workspace;

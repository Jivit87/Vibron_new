"use client";

/**
 * Hand context to whichever composer is visible. The composer listens for
 * `viberon:attach`; in the IDE the agent dock is opened to receive it.
 */

import type { ContextAttachment } from "@/lib/composer/types";
import { problemsToText, type Problem } from "@/lib/client/workspace-types";
import { useViberon } from "@/store/viberon";

export function attachToComposer(item: ContextAttachment): void {
  const store = useViberon.getState();
  const wide = typeof window !== "undefined" && window.innerWidth >= 1080;
  // Keep the user's shell: in the IDE, open the agent dock. Only a window too
  // narrow for the dock falls back to Chat, where a composer is always shown.
  if (store.appMode === "ide" && wide) {
    if (!store.agentDockOpen) store.setAgentDockOpen(true);
  } else if (store.appMode === "ide") {
    store.setAppMode("chat");
  }
  // Wait a frame so a freshly mounted composer has its listener attached.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("viberon:attach", { detail: item }))),
  );
}

export function attachProblems(problems: readonly Problem[]): void {
  if (problems.length === 0) return;
  attachToComposer({ kind: "problems", content: problemsToText(problems) });
}

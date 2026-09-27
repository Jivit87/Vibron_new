"use client";

/**
 * Cross-links between issues, tasks and pull requests.
 *
 * The Issues and Tasks panels publish what they last loaded here, so other
 * views (the other panel, the command palette, the graph's node panel) can
 * link to a task from its issue and back without fetching again. `reveal`
 * is a one-shot request to scroll a row into view and mark it.
 */

import { create } from "zustand";

import type { TaskRow } from "@/lib/client/deliver";
import type { IssueRow } from "@/lib/client/issues";

export type RevealTarget = { kind: "task"; id: string } | { kind: "issue"; url: string };

interface LinksState {
  issues: IssueRow[];
  tasks: TaskRow[];
  reveal: RevealTarget | null;
  setIssues: (issues: IssueRow[]) => void;
  setTasks: (tasks: TaskRow[]) => void;
  setReveal: (target: RevealTarget | null) => void;
}

export const useLinks = create<LinksState>((set) => ({
  issues: [],
  tasks: [],
  reveal: null,
  setIssues: (issues) => set({ issues }),
  setTasks: (tasks) => set({ tasks }),
  setReveal: (reveal) => set({ reveal }),
}));

/** `…/issues/52` → 52. */
export function issueNumber(url: string | undefined): number | null {
  const match = url ? /\/issues\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}

/** Normalised issue URL for matching (no trailing slash, hash or query). */
function issueKey(url: string): string {
  return url.replace(/[?#].*$/, "").replace(/\/$/, "").toLowerCase();
}

/** The task working on (or that worked on) an issue: by the issue's task id, else by URL. */
export function taskForIssue(issue: Pick<IssueRow, "url" | "task">, tasks: readonly TaskRow[]): TaskRow | undefined {
  if (issue.task) {
    const byId = tasks.find((t) => t.id === issue.task?.id);
    if (byId) return byId;
  }
  if (!issue.url) return undefined;
  const key = issueKey(issue.url);
  return tasks.find((t) => t.issueUrl && issueKey(t.issueUrl) === key);
}

/** The issue a task came from: by URL, else by the issue's task id. */
export function issueForTask(task: Pick<TaskRow, "id" | "issueUrl">, issues: readonly IssueRow[]): IssueRow | undefined {
  if (task.issueUrl) {
    const key = issueKey(task.issueUrl);
    const byUrl = issues.find((i) => i.url && issueKey(i.url) === key);
    if (byUrl) return byUrl;
  }
  return issues.find((i) => i.task?.id === task.id);
}

/** The PR for an issue: its task's, or the one the issue row carries. */
export function prForIssue(issue: Pick<IssueRow, "url" | "task">, tasks: readonly TaskRow[]): string | undefined {
  return issue.task?.prUrl ?? taskForIssue(issue, tasks)?.prUrl;
}

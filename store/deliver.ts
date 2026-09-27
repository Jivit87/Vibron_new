"use client";

/**
 * Ship state for a resolved fix run (client): the PR draft, the delivery,
 * the issue comment, the PR's CI status, re-runs and the "Fix CI" task.
 * Keyed by run id so switching between Chat and IDE (which remounts the run
 * view) keeps what the user typed and what the server said.
 */

import { create } from "zustand";

import {
  branchSlug,
  ciFailureTask,
  deliverPr,
  enqueueTask,
  fetchCi,
  reportOnIssue,
  rerunCheck,
  taskTitle,
  type CiStatus,
  type DeliveryEvidence,
} from "@/lib/client/deliver";
import { normalizeDescribe, postReview } from "@/lib/client/review";

export interface RerunState {
  asking: boolean;
  reason: string;
  sending: boolean;
  error?: string;
  done?: boolean;
}

export interface DeliverDraft {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
  describing: boolean;
  /** Title/body came from `/api/review` describe (vs. the prompt fallback). */
  described: boolean;
  phase: "edit" | "delivering" | "confirm" | "done";
  error: string | null;
  confirmFiles: string[];
  pr: { url: string; number?: number; branch: string; commit?: string; updated: boolean } | null;
  /** Pushed without a PR (`pushOnly`). */
  pushed?: { branch: string; commit?: string } | null;
  /** The last deliver said the remote is not on GitHub: offer a plain push. */
  notGithub?: boolean;
  comment: { state: "idle" | "posting" | "done" | "error"; url?: string; error?: string };
  ci: CiStatus | null;
  ciError: string | null;
  ciCheckedAt: number | null;
  ciLoading: boolean;
  reruns: Record<string, RerunState>;
  rerunCount?: number;
  rerunLimit?: number;
  fixTask: { state: "sending" | "queued" | "error"; id?: string; error?: string } | null;
}

interface DeliverStore {
  byRun: Record<string, DeliverDraft>;
  ensure: (runId: string, prompt: string) => DeliverDraft;
  patch: (runId: string, patch: Partial<DeliverDraft>) => void;
  describe: (runId: string, repoKey: string) => Promise<void>;
  deliver: (runId: string, input: { repoKey: string; files: string[]; issueUrl?: string; confirm?: boolean; pushOnly?: boolean }) => Promise<void>;
  comment: (runId: string, input: { repoKey: string; issueUrl: string; summary: string; evidence: DeliveryEvidence }) => Promise<void>;
  pollCi: (runId: string) => Promise<void>;
  setRerun: (runId: string, check: string, patch: Partial<RerunState>) => void;
  rerun: (runId: string, check: string) => Promise<void>;
  fixCi: (runId: string, repoKey: string) => Promise<void>;
}

export function initialDraft(prompt: string): DeliverDraft {
  const title = taskTitle(prompt);
  return {
    branch: branchSlug(title),
    title: title.slice(0, 120),
    body: "",
    draft: true,
    describing: false,
    described: false,
    phase: "edit",
    error: null,
    confirmFiles: [],
    pr: null,
    comment: { state: "idle" },
    ci: null,
    ciError: null,
    ciCheckedAt: null,
    ciLoading: false,
    reruns: {},
    fixTask: null,
  };
}

export const useDeliver = create<DeliverStore>((set, get) => {
  const cur = (runId: string) => get().byRun[runId];
  const patch = (runId: string, p: Partial<DeliverDraft>) =>
    set((s) => (s.byRun[runId] ? { byRun: { ...s.byRun, [runId]: { ...s.byRun[runId], ...p } } } : s));

  return {
    byRun: {},

    ensure: (runId, prompt) => {
      const existing = cur(runId);
      if (existing) return existing;
      const draft = initialDraft(prompt);
      set((s) => ({ byRun: { ...s.byRun, [runId]: draft } }));
      return draft;
    },

    patch,

    describe: async (runId, repoKey) => {
      const d = cur(runId);
      if (!d || d.describing) return;
      patch(runId, { describing: true });
      const result = await postReview({ repoKey, target: "working", tool: "describe" });
      const described = result.ok ? normalizeDescribe(result.body) : null;
      const now = cur(runId);
      if (!now) return;
      // Never overwrite what the user already typed over the fallback.
      patch(runId, {
        describing: false,
        described: Boolean(described),
        ...(described && now.phase === "edit"
          ? { title: described.title, body: now.body.trim() ? now.body : described.body }
          : {}),
      });
    },

    deliver: async (runId, { repoKey, files, issueUrl, confirm, pushOnly }) => {
      const d = cur(runId);
      if (!d || d.phase === "delivering") return;
      patch(runId, { phase: "delivering", error: null });
      const result = await deliverPr({
        repoKey,
        branch: d.branch.trim(),
        title: d.title.trim(),
        body: d.body,
        draft: d.draft,
        files,
        issueUrl,
        confirm,
        pushOnly,
      });
      if (result.ok && result.pushedOnly) {
        patch(runId, { phase: "done", error: null, notGithub: false, pushed: { branch: result.branch || d.branch, commit: result.commit } });
        return;
      }
      if (result.ok) {
        patch(runId, {
          phase: "done",
          error: null,
          confirmFiles: [],
          branch: result.branch || d.branch,
          pr: { url: result.prUrl, number: result.prNumber, branch: result.branch || d.branch, commit: result.commit, updated: result.updated },
        });
        void get().pollCi(runId);
        return;
      }
      patch(runId, {
        phase: result.needsConfirm && !confirm ? "confirm" : "edit",
        error: result.error,
        notGithub: Boolean(result.notGithub),
        confirmFiles: result.files ?? [],
      });
    },

    comment: async (runId, { repoKey, issueUrl, summary, evidence }) => {
      const d = cur(runId);
      if (!d?.pr || d.comment.state === "posting") return;
      patch(runId, { comment: { state: "posting" } });
      const result = await reportOnIssue({ repoKey, issueUrl, prUrl: d.pr.url, summary, evidence });
      patch(runId, {
        comment: result.ok ? { state: "done", url: result.commentUrl } : { state: "error", error: result.error },
      });
    },

    pollCi: async (runId) => {
      const d = cur(runId);
      if (!d?.pr || d.ciLoading) return;
      patch(runId, { ciLoading: true });
      const result = await fetchCi(d.pr.url);
      if (result.ok) {
        patch(runId, {
          ciLoading: false,
          ci: result.ci,
          ciError: null,
          ciCheckedAt: Date.now(),
          rerunCount: result.ci.reruns ?? cur(runId)?.rerunCount,
          rerunLimit: result.ci.rerunLimit ?? cur(runId)?.rerunLimit,
        });
      } else {
        patch(runId, { ciLoading: false, ciError: result.error, ciCheckedAt: Date.now() });
      }
    },

    setRerun: (runId, check, p) => {
      const d = cur(runId);
      if (!d) return;
      const prev = d.reruns[check] ?? { asking: false, reason: "", sending: false };
      patch(runId, { reruns: { ...d.reruns, [check]: { ...prev, ...p } } });
    },

    rerun: async (runId, check) => {
      const d = cur(runId);
      const r = d?.reruns[check];
      if (!d?.pr || !r || r.sending || !r.reason.trim()) return;
      get().setRerun(runId, check, { sending: true, error: undefined });
      const result = await rerunCheck({ prUrl: d.pr.url, checkName: check, evidence: r.reason.trim() });
      get().setRerun(runId, check, result.ok ? { sending: false, asking: false, done: true } : { sending: false, error: result.error });
      patch(runId, {
        rerunCount: result.reruns ?? cur(runId)?.rerunCount,
        rerunLimit: result.limit ?? cur(runId)?.rerunLimit,
      });
      if (result.ok) void get().pollCi(runId);
    },

    fixCi: async (runId, repoKey) => {
      const d = cur(runId);
      if (!d?.pr || !d.ci || d.fixTask?.state === "sending") return;
      patch(runId, { fixTask: { state: "sending" } });
      const result = await enqueueTask({ kind: "fix", repoKey, task: d.ci.fixTask || ciFailureTask(d.ci, d.pr.url), source: "ui" });
      patch(runId, {
        fixTask: result.ok ? { state: "queued", id: result.task?.id } : { state: "error", error: result.error },
      });
    },
  };
});

"use client";

/**
 * Client transport for the agent run.
 *
 * Opens the SSE stream, feeds every event into the store, and owns the side
 * effects that cannot live in a reducer: opening the tab an agent just
 * edited, wiring the preview URL, cancelling, and answering approvals.
 */

import { toast } from "sonner";

import type { ApprovalDecision, OrchestrationEvent, RunPlan, RunStatus } from "@/lib/agents/events";
import { RUN_ID_HEADER, type AgentRequest, type Interaction } from "@/lib/harness/contracts";
import type { ContextAttachment, ImageAttachment } from "@/lib/composer/types";
import { answerMockApproval, isMockMode, mockResponse, mockScript, mockTaskScript } from "@/lib/client/mock-run";
import { useViberon } from "@/store/viberon";

/** Parse one `data:`-prefixed SSE frame. */
export function parseFrame(frame: string): OrchestrationEvent | null {
  const payload = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!payload) return null;
  try {
    return JSON.parse(payload) as OrchestrationEvent;
  } catch {
    return null;
  }
}

let activeController: AbortController | null = null;
/** Server-issued run id (from `X-Run-Id` or `run_start`), for cancel. */
let activeRunId: string | null = null;

/**
 * Stop the run: ask the server to cancel (which denies pending approvals and
 * kills the run's processes), then abort the stream. The server's
 * `run_done{status:"cancelled"}` usually arrives first; the abort is the
 * backstop when the server is unreachable or predates the cancel route.
 */
export async function cancelRun(): Promise<void> {
  const controller = activeController;
  if (!controller) return;
  const runId = activeRunId;
  if (runId && !isMockMode()) {
    try {
      await Promise.race([
        fetch("/api/agent/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId }),
        }),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    } catch {
      // Fall through to the abort.
    }
  }
  controller.abort();
  if (activeController === controller) activeController = null;
}

export async function answerApproval(
  approvalId: string,
  decision: ApprovalDecision,
): Promise<void> {
  // Optimistic: the card collapses immediately. `approval_resolved` confirms.
  useViberon.getState().resolveApproval(approvalId, decision === "deny" ? "deny" : "allow");
  if (isMockMode()) {
    answerMockApproval(approvalId, decision);
    return;
  }
  try {
    const response = await fetch("/api/agent/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `approved` keeps servers that predate `decision` working.
      body: JSON.stringify({ approvalId, decision, approved: decision !== "deny" }),
    });
    if (!response.ok) throw new Error(String(response.status));
  } catch {
    toast.error("Could not send that decision. The run may have ended.");
  }
}

export interface SendPromptOptions {
  /** Skip appending the user message (used when replaying/retrying). */
  silent?: boolean;
  /** Override the composer's interaction for this send. */
  interaction?: Interaction;
  /** Execute this approved plan instead of planning again. */
  plan?: RunPlan;
  attachments?: ContextAttachment[];
  images?: ImageAttachment[];
}

export async function sendPrompt(
  prompt: string,
  options: SendPromptOptions = {},
): Promise<void> {
  const trimmed = prompt.trim();
  if (!trimmed) return;

  const store = useViberon.getState();
  if (store.streaming) {
    toast.error("A run is already in progress. Stop it first.");
    return;
  }

  const { repoKey, settings, messages } = store;
  if (!repoKey) {
    toast.error("No workspace is open.");
    return;
  }

  const interaction: Interaction = options.plan
    ? "agent"
    : (options.interaction ?? settings.interaction);

  const history = messages.slice(-16).map((m) => ({
    role: m.role,
    content: m.content,
  }));

  if (!options.silent) store.appendMessage("user", trimmed);
  store.startRun({
    prompt: trimmed,
    model: settings.model,
    mode: settings.agentMode,
    interaction,
  });
  store.appendMessage("assistant", "");

  const body: AgentRequest = {
    repoKey,
    prompt: trimmed,
    history,
    interaction,
    mode: settings.agentMode,
    plan: options.plan,
    model: settings.model,
    commandPolicy: settings.commandPolicy,
    editPolicy: settings.editPolicy,
    concurrency: settings.concurrency,
    showThinking: settings.showThinking,
    autoCheckpoint: settings.autoCheckpoint,
    attachments: options.attachments?.length ? options.attachments : undefined,
    images: options.images?.length ? options.images : undefined,
  };

  await pumpRun({
    conversational: true,
    open: (signal) =>
      isMockMode()
        ? Promise.resolve(mockResponse(mockScript({ prompt: trimmed, interaction, plan: options.plan }), signal))
        : fetch("/api/agent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
              ...body,
              // Read by servers that predate `AgentRequest`; harmless otherwise.
              retrievalDepth: settings.retrievalDepth,
              maxNodes: settings.maxNodes,
            }),
          }),
  });
}

/** The queued task whose event stream the run view is showing, if any. */
let attachedTaskId: string | null = null;

export function attachedTask(): string | null {
  return attachedTaskId;
}

/**
 * Show a queued task's live solve in the normal run view. The task's
 * `GET /api/tasks/:id/events` stream carries the same events as
 * `/api/agent`, so it goes through the same reader. Stopping detaches the
 * view; it does not cancel the task (that is the Tasks panel's Cancel).
 */
export async function attachTaskRun(task: { id: string; task: string }): Promise<void> {
  const store = useViberon.getState();
  if (store.streaming) {
    toast.error("A run is already in progress. Stop it first.");
    return;
  }
  store.startRun({ prompt: task.task, model: store.settings.model, mode: "single", interaction: "fix" });
  attachedTaskId = task.id;
  try {
    await pumpRun({
      conversational: false,
      open: (signal) =>
        isMockMode()
          ? Promise.resolve(mockResponse(mockTaskScript(), signal))
          : fetch(`/api/tasks/${encodeURIComponent(task.id)}/events`, {
              headers: { Accept: "text/event-stream" },
              signal,
            }),
    });
  } finally {
    if (attachedTaskId === task.id) attachedTaskId = null;
  }
}

/**
 * Read one run's SSE stream into the store. Conversational runs also write
 * the reply into the chat; an attached task run only drives the run view.
 */
async function pumpRun({
  open,
  conversational,
}: {
  open: (signal: AbortSignal) => Promise<Response>;
  conversational: boolean;
}): Promise<void> {
  const controller = new AbortController();
  activeController = controller;
  activeRunId = null;

  /**
   * Batch store writes. Token deltas arrive faster than React can render;
   * without coalescing, a long run drops frames on the whole UI.
   */
  const queue: OrchestrationEvent[] = [];
  let flushHandle: number | null = null;
  /** Whether the reply already streamed into the bubble via `answer`. */
  let answeredInline = false;
  let finalStatus: RunStatus | null = null;

  const flush = () => {
    flushHandle = null;
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    useViberon.getState().applyEvents(batch);
  };
  const schedule = () => {
    if (flushHandle !== null) return;
    flushHandle = window.requestAnimationFrame(flush);
  };

  try {
    const response = await open(controller.signal);

    if (!response.ok || !response.body) {
      const errorBody = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      throw new Error(errorBody?.error ?? `Request failed (${response.status})`);
    }

    // An attached task is cancelled from the Tasks panel, not /api/agent/cancel.
    activeRunId = conversational ? response.headers.get(RUN_ID_HEADER) : null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const event = parseFrame(frame);
        if (!event) continue;

        queue.push(event);
        schedule();

        switch (event.type) {
          case "run_start":
            if (conversational) activeRunId = activeRunId ?? event.runId;
            break;

          case "answer":
            if (!conversational) break;
            // Straight into the conversation. Flush first so token order
            // matches the order the model produced them in.
            flush();
            answeredInline = true;
            useViberon.getState().appendToLastAssistant(event.text);
            break;

          case "file_change": {
            const state = useViberon.getState();
            // Surface what the agent is writing as a preview tab, but never
            // steal focus from a file the user is editing.
            const current = state.tabs.find((t) => t.path === state.activeTabPath);
            if (event.kind !== "delete" && !current?.dirty && state.appMode === "ide") {
              state.openTab(event.path, event.after, { preview: true });
            }
            break;
          }

          case "command": {
            if (isMockMode()) {
              useViberon.getState().upsertTerminal({
                id: event.sessionId,
                command: event.command,
                status: event.status,
                exitCode: event.exitCode,
                output: `\x1b[2m> vitest run src/hooks\x1b[0m\n\n ✓ src/hooks/useTheme.test.ts (3 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n`,
                detectedUrl: null,
                startedAt: Date.now(),
                origin: "agent",
              });
              break;
            }
            void fetch(`/api/terminal?sessionId=${encodeURIComponent(event.sessionId)}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((session) => {
                if (!session) return;
                const state = useViberon.getState();
                state.upsertTerminal({ origin: "agent", ...session });
                if (session.detectedUrl) state.setPreviewUrl(session.detectedUrl);
              })
              .catch(() => {});
            break;
          }

          case "run_done": {
            flush();
            finalStatus = event.status ?? "done";
            const state = useViberon.getState();
            if (conversational && event.summary && !answeredInline) {
              state.appendToLastAssistant(event.summary);
            }
            break;
          }

          case "error":
            if (event.fatal) toast.error(event.message);
            break;
        }
      }
    }

    flush();
    useViberon.getState().endRun(finalStatus ?? "done");
  } catch (error) {
    flush();
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const state = useViberon.getState();
    if (aborted || finalStatus === "cancelled") {
      if (conversational) state.appendToLastAssistant("\n\n_Stopped._");
      state.endRun("cancelled");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
      if (conversational) state.appendToLastAssistant(`\n\n**Run failed.** ${message}`);
      state.endRun("failed");
    }
  } finally {
    if (flushHandle !== null) window.cancelAnimationFrame(flushHandle);
    if (activeController === controller) activeController = null;
    activeRunId = null;
    void refreshWorkspace();
  }
}

/** Execute a plan the user reviewed (and possibly edited). */
export async function runPlan(plan: RunPlan, prompt: string): Promise<void> {
  const state = useViberon.getState();
  if (state.run) state.updatePlan(plan);
  await sendPrompt(prompt, { plan, silent: true, interaction: "agent" });
}

/** Re-pull the file list and project memory after a run. */
export async function refreshWorkspace(): Promise<void> {
  const { repoKey } = useViberon.getState();
  if (!repoKey) return;

  await Promise.all([
    fetch(`/api/repos/files/${repoKey}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { files?: { path: string }[] } | null) => {
        if (body?.files) {
          useViberon.getState().setFileList(body.files.map((f) => f.path));
        }
      })
      .catch(() => {}),
    fetch(`/api/memory?repoKey=${encodeURIComponent(repoKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { memory?: unknown } | null) => {
        if (body?.memory) {
          useViberon.getState().setMemory(body.memory as never);
        }
      })
      .catch(() => {}),
  ]);
}

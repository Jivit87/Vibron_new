/**
 * POST /api/agent — the main agent endpoint.
 *
 * Streams the whole orchestration as SSE: plan, per-agent output, file
 * diffs, terminal output, token ledger, and the final summary.
 *
 * The run is registered before the stream opens, so its id can travel in
 * the `X-Run-Id` header as well as `run_start`. Approvals and Stop arrive
 * on other requests (`/api/agent/approve`, `/api/agent/cancel`) and find the
 * run through that id.
 */

import { orchestrate } from "@/lib/agents/orchestrator";
import type { EventSink, OrchestrationEvent, RunPlan } from "@/lib/agents/events";
import { encodeSse, sseHeaders } from "@/lib/sse";
import { fullReindex, openWorkspace } from "@/lib/workspace";
import { getGraph } from "@/lib/store";
import { createCheckpoint } from "@/lib/checkpoints";
import { sanitizeAttachments, sanitizeImages } from "@/lib/composer/types";
import { resolveAttachments } from "@/lib/harness/attachments";
import { RUN_ID_HEADER, type Interaction } from "@/lib/harness/contracts";
import { cancelRun, createRun, finishRun, requestApproval } from "@/lib/harness/runs";
import { solveTask } from "@/lib/harness/solve";
import { resolveModel } from "@/lib/ai";
import { detectVerifyCommands } from "@/lib/verify";
import { recordFixNote } from "@/lib/memory/graph";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MIN_CONCURRENCY } from "@/lib/limits";

export const runtime = "nodejs";
/** Long-horizon runs: a full-stack build can legitimately take minutes. */
export const maxDuration = 800;

type Body = Record<string, unknown>;

function parseHistory(raw: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (m): m is { role: "user" | "assistant"; content: string } =>
        Boolean(m) &&
        typeof m === "object" &&
        ((m as { role?: unknown }).role === "user" ||
          (m as { role?: unknown }).role === "assistant") &&
        typeof (m as { content?: unknown }).content === "string",
    )
    .slice(-16);
}

/** Shape-check an approved plan; `renormalizePlan` does the deep cleanup. */
function parsePlan(raw: unknown): RunPlan | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const plan = raw as Partial<RunPlan>;
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) return undefined;
  return {
    summary: typeof plan.summary === "string" ? plan.summary : "",
    steps: plan.steps.slice(0, 40).filter((s) => s && typeof s === "object"),
    waves: [],
  };
}

function clampInt(raw: unknown, min: number, max: number): number | undefined {
  const n = Number(raw);
  if (raw === undefined || raw === null || !Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "Body must be valid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!repoKey || !prompt) {
    return Response.json(
      { error: "repoKey and prompt are required" },
      { status: 400 },
    );
  }

  // `mode: "fix"` is a common mix-up for `interaction: "fix"`; honour it rather than silently build.
  const interaction: Interaction =
    body.interaction === "plan" || body.interaction === "ask" || body.interaction === "fix"
      ? body.interaction
      : body.mode === "fix"
        ? "fix"
        : "agent";
  const plan = interaction === "agent" ? parsePlan(body.plan) : undefined;
  const mode =
    body.mode === "single" || body.mode === "orchestrated" ? body.mode : "auto";
  const model = typeof body.model === "string" ? body.model : "auto";
  const commandPolicy =
    body.commandPolicy === "auto" || body.commandPolicy === "never"
      ? body.commandPolicy
      : "ask";
  const editPolicy = body.editPolicy === "ask" ? "ask" : "auto";
  const concurrency = Math.max(
    MIN_CONCURRENCY,
    Math.min(MAX_CONCURRENCY, Number(body.concurrency) || DEFAULT_CONCURRENCY),
  );
  const showThinking = body.showThinking !== false;
  const autoCheckpoint = body.autoCheckpoint !== false;
  const retrieval = {
    depth: clampInt(body.retrievalDepth, 1, 4),
    maxNodes: clampInt(body.maxNodes, 5, 60),
  };
  const attachments = sanitizeAttachments(body.attachments);
  const images = sanitizeImages(body.images);

  const handle = await openWorkspace(repoKey);
  if (interaction === "fix" && !handle.rootPath) {
    return Response.json(
      { error: "Fix mode needs a workspace on disk. Open a local folder or clone the repository first." },
      { status: 400 },
    );
  }

  // First run against a workspace needs a graph before the engine is useful.
  if (!(await getGraph(repoKey))) {
    await fullReindex(handle);
  }

  // Snapshot before we touch anything, so a run that goes wrong is one
  // click to undo rather than twenty individual reverts. Plan and ask runs
  // change nothing, so they get no checkpoint.
  const checkpoint =
    autoCheckpoint && interaction === "agent"
      ? await createCheckpoint(
          handle,
          prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt,
        ).catch(() => null)
      : null;

  // Events are forwarded to whatever stream is attached; until it is, and
  // after it closes, they are dropped.
  let sink: EventSink = () => {};
  const run = createRun(repoKey, (event) => sink(event));
  const { runId } = run;

  // A closed tab is a Stop: nobody is left to answer approvals or read output.
  request.signal.addEventListener("abort", () => cancelRun(runId));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: OrchestrationEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          closed = true;
        }
      };
      sink = send;

      // Heartbeat: a long planning turn can exceed proxy idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(new TextEncoder().encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);

      if (checkpoint) {
        send({
          type: "checkpoint",
          id: checkpoint.id,
          label: checkpoint.label,
          fileCount: checkpoint.fileCount,
        });
      }

      try {
        if (interaction === "fix") {
          // Autonomous fix: localize → fix → gate (original vs patched) → evidence.
          // The git snapshot is the checkpoint; solveTask streams its own run_start/run_done.
          const resolved = await resolveModel(model, { agenticOnly: true });
          const commands = await detectVerifyCommands(handle.rootPath!).catch(() => []);
          const result = await solveTask({
            handle,
            task: prompt,
            model: resolved,
            emit: send,
            signal: run.signal,
            runId,
            budget: { maxTurns: 40 },
            verify: { enabled: true, commands, timeoutMs: 300_000, baseline: true },
            useRepoRules: true,
            // Run memory: the next task on the same area sees what was fixed and why.
            onSolved: (solved) => {
              if (!solved.filesChanged.length) return;
              recordFixNote(handle.rootPath!, {
                issue: prompt,
                files: solved.filesChanged,
                rootCause: solved.summary,
                verified: solved.status === "resolved",
              });
            },
          });
          if (result.error && result.status === "error") {
            send({ type: "error", message: result.error, fatal: true });
          }
          return;
        }
        await orchestrate({
          repoKey,
          handle,
          request: prompt,
          history: parseHistory(body.history),
          mode,
          model,
          commandPolicy,
          editPolicy,
          concurrency,
          interaction,
          plan,
          showThinking,
          retrieval,
          attachments: await resolveAttachments(handle, attachments),
          images,
          emit: send,
          signal: run.signal,
          runId,
          requestApproval: (agentId, ask) => requestApproval(runId, agentId, ask),
        });
      } catch (error) {
        send({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          fatal: true,
        });
        send({
          type: "run_done",
          status: run.signal.aborted ? "cancelled" : "failed",
          summary: error instanceof Error ? error.message : String(error),
          filesChanged: 0,
          durationMs: Date.now() - run.startedAt,
          costUsd: 0,
        });
      } finally {
        clearInterval(heartbeat);
        finishRun(runId);
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
    cancel() {
      cancelRun(runId);
    },
  });

  return new Response(stream, {
    headers: { ...sseHeaders(), [RUN_ID_HEADER]: runId },
  });
}

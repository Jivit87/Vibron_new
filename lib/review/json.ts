/**
 * One structured model call: ask for a JSON object, parse it tolerantly
 * (code fences, prose around it), validate it, and on invalid output retry
 * once with the error shown to the model. Every turn goes through `runTurn`
 * (injectable for tests) so its cost is accounted like any other. Also
 * picks the default model for the review tools.
 */

import { availableModels, cliAutoOptIn, runTurn as defaultRunTurn, type AiTurnRequest, type AiUsage } from "@/lib/ai";

export interface TurnOutcome {
  text: string;
  usage: AiUsage;
  cost: number;
  uncachedCost?: number;
}

export type RunTurnFn = (request: AiTurnRequest) => Promise<TurnOutcome>;

export interface CallOptions {
  model: string;
  signal?: AbortSignal;
  runTurn?: RunTurnFn;
  /** Fired after every model turn, e.g. to add its cost to a run's ledger. */
  onTurn?: (turn: TurnOutcome) => void;
}

export class ReviewOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewOutputError";
  }
}

/** Validators return the typed value or an error string for the repair prompt. */
export type Validator<T> = (value: unknown) => T | { error: string };

export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found");
  return JSON.parse(body.slice(start, end + 1));
}

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && Object.keys(v).length === 1 && typeof (v as { error?: unknown }).error === "string";
}

export async function structuredCall<T>(
  opts: CallOptions & { system: string; user: string; maxTokens?: number },
  validate: Validator<T>,
): Promise<T> {
  const run = opts.runTurn ?? defaultRunTurn;
  const messages: AiTurnRequest["messages"] = [{ role: "user", content: [{ type: "text", text: opts.user }] }];
  let lastError = "";
  for (let round = 0; round < 2; round += 1) {
    const turn = await run({
      model: opts.model,
      system: [{ text: opts.system }],
      messages,
      maxTokens: opts.maxTokens ?? 4000,
      effort: "low",
      signal: opts.signal,
    });
    opts.onTurn?.(turn);
    let value: T | { error: string };
    try {
      value = validate(extractJson(turn.text));
    } catch (error) {
      value = { error: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
    }
    if (!isError(value)) return value;
    lastError = value.error;
    messages.push(
      { role: "assistant", content: [{ type: "text", text: turn.text || "(empty)" }] },
      {
        role: "user",
        content: [{ type: "text", text: `That reply was invalid: ${lastError}. Reply again with ONLY the JSON object, matching the schema exactly.` }],
      },
    );
  }
  throw new ReviewOutputError(`The model did not return valid output: ${lastError}`);
}

/* -------------------------------- model --------------------------------- */

const RANK: Record<string, number> = { fast: 0, balanced: 1, frontier: 2 };

/**
 * The cheapest agentic model with a configured key (fast tier first, then
 * price). With no key at all it returns the cheapest agentic model anyway,
 * so `ensureModelReady` produces the credential message.
 */
export async function reviewModel(preferred?: string): Promise<string> {
  if (preferred && preferred !== "auto") return preferred;
  // Never an implicit Claude CLI (subscription) pick; callers on the CLI pass it explicitly.
  const models = (await availableModels()).filter((m) => m.spec.agentic && (m.spec.provider !== "claude-cli" || cliAutoOptIn()));
  const pick = (list: typeof models) =>
    [...list].sort(
      (a, b) => RANK[a.spec.tier] - RANK[b.spec.tier] || a.spec.pricing.input - b.spec.pricing.input,
    )[0]?.spec.id;
  return pick(models.filter((m) => m.available)) ?? pick(models) ?? "claude-haiku-4-5";
}

/* ------------------------------ tiny schema ------------------------------ */

export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const int = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
};
export const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
export function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (values as readonly string[]).includes(s) ? (s as T) : null;
}

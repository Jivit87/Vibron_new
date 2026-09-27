/**
 * A scripted AI provider for harness tests.
 *
 * There are no API keys in CI, so every runner behaviour is exercised
 * against this instead: each `runTurn` consumes the next scripted turn,
 * streams its text through the handlers like a real provider, and records
 * the request so tests can assert on what the model was sent.
 */

import { setProviderOverride } from "@/lib/ai";
import type {
  AiContent,
  AiProvider,
  AiToolCall,
  AiTurnHandlers,
  AiTurnRequest,
  AiTurnResult,
  AiUsage,
} from "@/lib/ai/types";

export interface ScriptedCall {
  name: string;
  input?: Record<string, unknown>;
  id?: string;
  inputError?: string;
  partialInput?: Record<string, unknown>;
}

export type ScriptedTurn =
  | {
      text?: string;
      thinking?: string;
      calls?: ScriptedCall[];
      stopReason?: AiTurnResult["stopReason"];
      usage?: Partial<AiUsage>;
      /** Answer only after this long (a slow model). */
      delayMs?: number;
    }
  /** Throw this (after streaming `streamed`, if given). */
  | { error: unknown; streamed?: string }
  /** Park until the request's signal aborts, then reject like the SDK does. */
  | { hang: true }
  /** Decide from the request. */
  | ((request: AiTurnRequest) => ScriptedTurn);

let callCounter = 0;

export class FakeProvider implements AiProvider {
  readonly id = "anthropic" as const;
  readonly requests: AiTurnRequest[] = [];

  constructor(private turns: ScriptedTurn[] = []) {}

  /** Queue more turns. */
  push(...turns: ScriptedTurn[]): void {
    this.turns.push(...turns);
  }

  get remaining(): number {
    return this.turns.length;
  }

  isConfigured(): boolean {
    return true;
  }

  async runTurn(
    request: AiTurnRequest,
    handlers: AiTurnHandlers = {},
  ): Promise<AiTurnResult> {
    // Snapshot: the runner mutates its message array after the call.
    this.requests.push({ ...request, messages: structuredClone(request.messages) });
    let step: ScriptedTurn = this.turns.shift() ?? { text: "Done." };
    while (typeof step === "function") step = step(request);

    if ("hang" in step) {
      await new Promise<never>((_, reject) => {
        const abort = () => reject(Object.assign(new Error("Request was aborted."), { name: "AbortError" }));
        if (request.signal?.aborted) abort();
        request.signal?.addEventListener("abort", abort, { once: true });
      });
    }
    if ("error" in step) {
      if (step.streamed) handlers.onText?.(step.streamed);
      throw step.error;
    }
    if (!("hang" in step) && request.signal?.aborted) {
      throw Object.assign(new Error("Request was aborted."), { name: "AbortError" });
    }

    const turn = step as Exclude<ScriptedTurn, { error: unknown } | { hang: true } | ((r: AiTurnRequest) => ScriptedTurn)>;
    if (turn.delayMs) await new Promise((resolve) => setTimeout(resolve, turn.delayMs));
    if (turn.thinking) handlers.onThinking?.(turn.thinking);
    if (turn.text) handlers.onText?.(turn.text);

    const content: AiContent[] = [];
    if (turn.thinking) content.push({ type: "thinking", thinking: turn.thinking, signature: "sig" });
    if (turn.text) content.push({ type: "text", text: turn.text });
    const toolCalls: AiToolCall[] = (turn.calls ?? []).map((call) => {
      callCounter += 1;
      const toolCall: AiToolCall = {
        id: call.id ?? `call_${callCounter}`,
        name: call.name,
        input: call.input ?? {},
        ...(call.inputError ? { inputError: call.inputError } : {}),
        ...(call.partialInput ? { partialInput: call.partialInput } : {}),
      };
      handlers.onToolCallStart?.(call.name);
      content.push({ type: "tool_use", id: toolCall.id, name: toolCall.name, input: toolCall.input });
      return toolCall;
    });

    return {
      text: turn.text ?? "",
      thinking: turn.thinking ?? "",
      toolCalls,
      stopReason: turn.stopReason ?? (toolCalls.length ? "tool_use" : "end_turn"),
      content,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        ...turn.usage,
      },
    };
  }
}

/** Route every `runTurn` through a fresh fake. Retries never sleep. */
export function installFakeProvider(turns: ScriptedTurn[] = []): FakeProvider {
  const provider = new FakeProvider(turns);
  setProviderOverride(provider, { sleep: async () => {} });
  return provider;
}

export function uninstallFakeProvider(): void {
  setProviderOverride(null);
}

/** An error shaped like an SDK HTTP error. */
export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status });
}

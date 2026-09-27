/**
 * Text tool-calling protocol (ported from Pramana `llm/textproto.py`).
 *
 * Used when an endpoint rejects native tool calling, and as a safety net
 * when a model writes its tool calls as prose even though native tools were
 * offered. The canonical format carries raw values, with no JSON escaping,
 * which weak models get right far more often for code:
 *
 *     <tool name="edit_file">
 *     <path>src/mod.py</path>
 *     <find>    return a+b</find>
 *     <replace>    return a + b</replace>
 *     </tool>
 *
 * Also accepted: `<invoke name=..><parameter name=..>`, Qwen-style
 * `<function=name><parameter=x>`, Hermes `<tool_call>{json}</tool_call>`, and
 * fenced JSON objects carrying `name` + `arguments`. Anything the model
 * writes after its calls that looks like a tool *result* is imagined and is
 * discarded.
 */

import type { AiMessage, AiToolDef } from "@/lib/ai/types";

const TOOL_RE = /<tool\s+name\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)(?:<\/tool>|$)/g;
const PARAM_RE = /<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g;
const HERMES_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/g;
const QWEN_RE = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|$)/g;
const QWEN_PARAM_RE = /<parameter=([\w-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/g;
const FENCED_JSON_RE = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
const INVOKE_RE = /<invoke\s+name\s*=\s*["']?([\w.-]+)["']?\s*>([\s\S]*?)(?:<\/invoke>|$)/g;
const NAMED_PARAM_RE =
  /<parameter\s+name\s*=\s*["']?([\w-]+)["']?\s*>([\s\S]*?)(?:<\/parameter>|(?=<parameter\s)|$)/g;
/** A model writing its own tool results is hallucinating: everything from here on is dropped. */
const HALLUCINATED_RESULT_RE =
  /<(result|tool_result|function_results|output|observation)\b[^>]*>|^=== USER ===/m;
const CALL_START_RE = /<tool\s+name|<invoke\s+name|<function=|<tool_call>/;

export const MAX_TEXT_CALLS_PER_TURN = 5;
export const TEXT_STOP_SEQUENCES = ["<tool_result", "<function_results", "<result>", "=== USER ==="];

export interface TextToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `txt_${Date.now().toString(36)}_${counter}`;
}

/** Keep the reply only up to the first self-written tool result, if a call precedes it. */
export function truncateHallucination(text: string): string {
  const match = HALLUCINATED_RESULT_RE.exec(text ?? "");
  if (!match) return text;
  const head = text.slice(0, match.index);
  return CALL_START_RE.test(head) ? head.trimEnd() : text;
}

function stripOneNewline(value: string): string {
  let v = value;
  if (v.startsWith("\r\n")) v = v.slice(2);
  else if (v.startsWith("\n")) v = v.slice(1);
  if (v.endsWith("\r\n")) v = v.slice(0, -2);
  else if (v.endsWith("\n")) v = v.slice(0, -1);
  return v;
}

type PropSpec = { type?: string };

function coerce(value: string, spec: PropSpec | undefined): unknown {
  const type = spec?.type;
  const v = value.trim();
  try {
    if (type === "integer") {
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? n : value;
    }
    if (type === "number") {
      const n = Number(v);
      return Number.isFinite(n) ? n : value;
    }
    if (type === "boolean") return ["true", "1", "yes"].includes(v.toLowerCase());
    if (type === "array") {
      if (v.startsWith("[")) return JSON.parse(v);
      // Models often wrap each element in its own tag: <item>a</item><command>b</command>.
      const inner = [...v.matchAll(/<([A-Za-z_][\w-]*)>([\s\S]*?)<\/\1>/g)];
      if (inner.length) {
        return inner.map((m) => stripOneNewline(m[2]).trim()).filter(Boolean);
      }
      return v
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (type === "object") return JSON.parse(v);
  } catch {
    return value;
  }
  return value;
}

function schemaFor(name: string, tools?: AiToolDef[]): Record<string, PropSpec> {
  const tool = tools?.find((t) => t.name === name);
  return (tool?.input_schema.properties ?? {}) as Record<string, PropSpec>;
}

function escapeRawNewlinesInStrings(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) {
        esc = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        out += ch;
        continue;
      }
      if (ch === "\n") out += "\\n";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\r") out += "\\r";
      else out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

/**
 * Tolerant JSON-object parsing for tool arguments: fences, prose around the
 * object, raw newlines inside strings, and trailing commas are all repaired.
 */
export function parseJsonArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (raw === null || raw === undefined) return {};
  const s = String(raw).trim();
  if (!s) return {};
  const attempts = [s];
  const fenced = s.replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (fenced !== s) attempts.push(fenced);
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i !== -1 && j > i) attempts.push(s.slice(i, j + 1));
  for (const candidate of [...attempts]) {
    const escaped = escapeRawNewlinesInStrings(candidate);
    attempts.push(escaped, escaped.replace(/,\s*([}\]])/g, "$1"));
  }
  let lastError: unknown = null;
  for (const candidate of attempts) {
    try {
      const value = JSON.parse(candidate) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `could not parse tool arguments as a JSON object (${lastError instanceof Error ? lastError.message : "not an object"})`,
  );
}

/** Return the prose before the first call, and the calls. Empty list if none found. */
export function parseTextToolCalls(
  text: string,
  tools?: AiToolDef[],
): { prose: string; calls: TextToolCall[] } {
  if (!text) return { prose: "", calls: [] };
  const calls: TextToolCall[] = [];
  let firstPos: number | null = null;
  const mark = (index: number) => {
    if (firstPos === null) firstPos = index;
  };

  for (const m of text.matchAll(TOOL_RE)) {
    const [, name, body] = m;
    const props = schemaFor(name, tools);
    const args: Record<string, unknown> = {};
    for (const pm of body.matchAll(NAMED_PARAM_RE)) {
      const value = stripOneNewline(pm[2]);
      args[pm[1]] = pm[1] in props ? coerce(value, props[pm[1]]) : value;
    }
    for (const pm of body.matchAll(PARAM_RE)) {
      if (pm[1] === "parameter" || pm[1] in args) continue;
      const value = stripOneNewline(pm[2]);
      args[pm[1]] = pm[1] in props ? coerce(value, props[pm[1]]) : value;
    }
    if (Object.keys(args).length === 0 && body.trim().startsWith("{")) {
      try {
        Object.assign(args, parseJsonArgs(body));
      } catch {
        // Leave empty; the tool reports the missing arguments.
      }
    }
    calls.push({ id: newId(), name, input: args });
    mark(m.index ?? 0);
  }

  if (!calls.length) {
    for (const m of text.matchAll(INVOKE_RE)) {
      const [, name, body] = m;
      const props = schemaFor(name, tools);
      const args: Record<string, unknown> = {};
      for (const pm of body.matchAll(NAMED_PARAM_RE)) {
        const value = stripOneNewline(pm[2]);
        args[pm[1]] = pm[1] in props ? coerce(value, props[pm[1]]) : value;
      }
      calls.push({ id: newId(), name, input: args });
      mark(m.index ?? 0);
    }
  }

  if (!calls.length) {
    for (const m of text.matchAll(QWEN_RE)) {
      const [, name, body] = m;
      const props = schemaFor(name, tools);
      const args: Record<string, unknown> = {};
      for (const pm of body.matchAll(QWEN_PARAM_RE)) {
        const value = stripOneNewline(pm[2]);
        args[pm[1]] = pm[1] in props ? coerce(value, props[pm[1]]) : value;
      }
      calls.push({ id: newId(), name, input: args });
      mark(m.index ?? 0);
    }
  }

  if (!calls.length) {
    const known = new Set((tools ?? []).map((t) => t.name));
    for (const rx of [HERMES_RE, FENCED_JSON_RE]) {
      for (const m of text.matchAll(rx)) {
        let obj: Record<string, unknown>;
        try {
          obj = parseJsonArgs(m[1]);
        } catch {
          continue;
        }
        const name = String(obj.name ?? obj.tool ?? "");
        if (!name || (known.size && !known.has(name))) continue;
        let args = obj.arguments ?? obj.parameters ?? obj.input ?? {};
        if (typeof args === "string") {
          try {
            args = parseJsonArgs(args);
          } catch {
            args = {};
          }
        }
        calls.push({
          id: newId(),
          name,
          input: args && typeof args === "object" ? (args as Record<string, unknown>) : {},
        });
        mark(m.index ?? 0);
      }
      if (calls.length) break;
    }
  }

  const prose = firstPos !== null ? text.slice(0, firstPos).trim() : text.trim();
  return { prose, calls };
}

export function renderToolsPrompt(tools: AiToolDef[]): string {
  const lines = [
    "# How to call tools",
    "You act only through tools. To call a tool, write a block in exactly this format:",
    "",
    '<tool name="TOOL_NAME">',
    "<PARAMETER_NAME>value</PARAMETER_NAME>",
    "</tool>",
    "",
    "Rules: values are raw text (no quotes, no escaping; multi-line is fine). You may put several tool",
    "blocks in one reply: they run in order, so batch what does not depend on a result you have not seen",
    "yet (e.g. create a file, edit another, then finish). After your tool block(s), STOP your reply",
    "immediately: the harness runs the tools and sends the real results in the next message inside",
    "<tool_result> blocks. NEVER write <tool_result>/<result> blocks or guess what a tool returns;",
    "anything you write after your tool calls is discarded.",
    "",
    "# Available tools",
  ];
  for (const tool of tools) {
    lines.push(`## ${tool.name}`, tool.description.trim());
    const props = tool.input_schema.properties as Record<
      string,
      { type?: string; enum?: unknown[]; description?: string }
    >;
    const required = new Set(tool.input_schema.required ?? []);
    const entries = Object.entries(props ?? {});
    if (entries.length) {
      lines.push("Parameters:");
      for (const [name, spec] of entries) {
        let type = spec?.type ?? "string";
        if (spec?.enum) type += ` one of ${spec.enum.join("|")}`;
        const desc = (spec?.description ?? "").trim().replace(/\n/g, " ");
        lines.push(`- ${name} (${type}${required.has(name) ? ", required" : ""}): ${desc}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function renderCall(name: string, input: Record<string, unknown>): string {
  const parts = [`<tool name="${name}">`];
  for (const [key, value] of Object.entries(input ?? {})) {
    parts.push(`<${key}>${typeof value === "string" ? value : JSON.stringify(value)}</${key}>`);
  }
  parts.push("</tool>");
  return parts.join("\n");
}

export interface PlainMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Flatten a tool transcript into plain user/assistant text for an endpoint
 * without native tools: calls become `<tool>` blocks, results become
 * `<tool_result>` blocks, and the tool contract rides in the system prompt.
 */
export function toTextMessages(
  system: string,
  messages: AiMessage[],
  tools: AiToolDef[],
): PlainMessage[] {
  const out: PlainMessage[] = [];
  const push = (role: PlainMessage["role"], content: string) => {
    const last = out[out.length - 1];
    if (last && last.role === role && role !== "system") last.content += `\n\n${content}`;
    else out.push({ role, content });
  };
  const toolsPrompt = tools.length ? renderToolsPrompt(tools) : "";
  const sys = [system, toolsPrompt].filter(Boolean).join("\n\n");
  if (sys) out.push({ role: "system", content: sys });

  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      const texts: string[] = [];
      for (const block of message.content) {
        if (block.type === "text" && block.text) texts.push(block.text);
      }
      let content = texts.join("");
      const calls = message.content.filter((b) => b.type === "tool_use");
      if (calls.length && !content.includes("<tool name=")) {
        const rendered = calls
          .map((b) => (b.type === "tool_use" ? renderCall(b.name, b.input) : ""))
          .join("\n\n");
        content = content ? `${content}\n\n${rendered}` : rendered;
      }
      for (const b of calls) if (b.type === "tool_use") names.set(b.id, b.name);
      push("assistant", content || "(no content)");
      continue;
    }
    for (const block of message.content) {
      if (block.type === "tool_result") {
        push(
          "user",
          `<tool_result name="${names.get(block.tool_use_id) ?? ""}">\n${block.content || "(no output)"}\n</tool_result>`,
        );
      } else if (block.type === "text" && block.text) {
        push("user", block.text);
      }
    }
  }
  return out;
}

/**
 * Zero-token impact check (CodePlan's "may-impact" analysis, cut down to the
 * case that actually breaks builds): when an edit changes a symbol's
 * signature, name the callers in files the agent has not touched. Changing a
 * body is invisible to callers and is never reported, so the note stays rare.
 */
import type { Graph, GraphNode } from "@/lib/graph";

const MAX_SYMBOLS = 5;
const MAX_CALLERS = 6;

function key(node: Pick<GraphNode, "file" | "name">): string {
  return `${node.file}#${node.name}`;
}

function norm(signature: string): string {
  return signature.replace(/\s+/g, " ").trim();
}

/** file#name → signature; names defined twice in one file are ambiguous and dropped. */
export function signatureIndex(graph: Graph): Map<string, string> {
  const out = new Map<string, string>();
  const dup = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.signature || !node.name) continue;
    const k = key(node);
    if (out.has(k)) dup.add(k);
    else out.set(k, norm(node.signature));
  }
  for (const k of dup) out.delete(k);
  return out;
}

/**
 * The note for signatures changed in `changedFiles`, or null. `edited` holds
 * every file the agent changed this attempt (their callers are its own work);
 * `reported` is updated so each symbol is named once.
 */
export function signatureImpact(
  base: Map<string, string>,
  now: Graph,
  changedFiles: string[],
  edited: Set<string>,
  reported: Set<string>,
): string | null {
  const changed = new Set(changedFiles);
  const byId = new Map(now.nodes.map((n) => [n.id, n] as const));
  const lines: string[] = [];
  const current = signatureIndex(now);
  for (const node of now.nodes) {
    if (lines.length >= MAX_SYMBOLS) break;
    if (!changed.has(node.file)) continue;
    const k = key(node);
    const before = base.get(k);
    const after = current.get(k);
    if (!before || !after || before === after || reported.has(k)) continue;
    const callers = now.edges
      .filter((e) => e.kind === "call" && e.target === node.id)
      .map((e) => byId.get(e.source))
      .filter((c): c is GraphNode => Boolean(c) && !edited.has(c!.file));
    if (!callers.length) continue;
    reported.add(k);
    const unique = [...new Map(callers.map((c) => [c.id, c])).values()];
    const shown = unique
      .slice(0, MAX_CALLERS)
      .map((c) => `${c.file}:${c.startLine} \`${c.name}\``)
      .join(", ");
    const more = unique.length > MAX_CALLERS ? ` and ${unique.length - MAX_CALLERS} more` : "";
    lines.push(`- \`${node.name}\` (${node.file}): was \`${before}\`, now \`${after}\`. Called from ${shown}${more}.`);
  }
  if (!lines.length) return null;
  return [
    "[harness] Impact check: your edit changed these signatures, and they have callers in files you have not edited:",
    ...lines,
    "Make sure those calls still match, or change them too.",
  ].join("\n");
}

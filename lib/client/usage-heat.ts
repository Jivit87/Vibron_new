/**
 * Token heat for the code graph.
 *
 * The ledger attributes context to files and to graph nodes. The graph view
 * renders aggregated nodes (folder bubbles until expanded), so heat is
 * computed per symbol first and then summed into whatever render node the
 * symbol currently lives in:
 *
 *   symbol heat = its own node attribution
 *               + an even share of its file's tokens not already
 *                 attributed to specific nodes (whole-file reads, grep hits)
 */

import type { Graph } from "@/lib/graph";
import type { ContextStat } from "@/lib/client/usage";

export interface Heat {
  tokens: number;
  reads: number;
  /** Files that contributed, for the tooltip. */
  files: number;
}

export interface HeatMap {
  byRenderId: Map<string, Heat>;
  max: number;
  /** Symbols and files with any heat. */
  hotSymbols: number;
  hotFiles: number;
}

export function computeHeat(
  graph: Pick<Graph, "nodes">,
  symbolToRenderId: Map<string, string>,
  files: ContextStat[],
  nodes: ContextStat[],
): HeatMap {
  const nodeStat = new Map(nodes.map((n) => [n.key, n] as const));
  const bySymbol = new Map<string, number>();
  const symbolsByFile = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const list = symbolsByFile.get(node.file);
    if (list) list.push(node.id);
    else symbolsByFile.set(node.file, [node.id]);
    const stat = nodeStat.get(node.id);
    if (stat && stat.sentTokens > 0) bySymbol.set(node.id, stat.sentTokens);
  }

  const readsByRender = new Map<string, number>();
  const filesByRender = new Map<string, Set<string>>();
  const touch = (renderId: string, file: string, reads: number) => {
    let set = filesByRender.get(renderId);
    if (!set) {
      set = new Set();
      filesByRender.set(renderId, set);
    }
    if (!set.has(file)) {
      set.add(file);
      readsByRender.set(renderId, (readsByRender.get(renderId) ?? 0) + reads);
    }
  };

  let hotFiles = 0;
  for (const file of files) {
    const symbols = symbolsByFile.get(file.key);
    if (!symbols || symbols.length === 0) continue;
    if (file.sentTokens > 0 || file.reads > 0) hotFiles += 1;
    const attributed = symbols.reduce((sum, id) => sum + (nodeStat.get(id)?.sentTokens ?? 0), 0);
    const residual = Math.max(0, file.sentTokens - attributed);
    if (residual > 0) {
      const share = residual / symbols.length;
      for (const id of symbols) bySymbol.set(id, (bySymbol.get(id) ?? 0) + share);
    }
    for (const id of symbols) {
      const renderId = symbolToRenderId.get(id);
      if (renderId) touch(renderId, file.key, file.reads);
    }
  }

  // Nodes with attribution but no file row (older snapshots): count their reads.
  const fileKeys = new Set(files.map((f) => f.key));
  const fileOf = new Map(graph.nodes.map((n) => [n.id, n.file] as const));
  for (const stat of nodes) {
    const file = fileOf.get(stat.key);
    const renderId = symbolToRenderId.get(stat.key);
    if (!file || !renderId || fileKeys.has(file)) continue;
    touch(renderId, file, stat.reads);
  }

  const byRenderId = new Map<string, Heat>();
  for (const [symbolId, tokens] of bySymbol) {
    const renderId = symbolToRenderId.get(symbolId);
    if (!renderId || tokens <= 0) continue;
    const heat = byRenderId.get(renderId) ?? { tokens: 0, reads: 0, files: 0 };
    heat.tokens += tokens;
    byRenderId.set(renderId, heat);
  }
  let max = 0;
  for (const [renderId, heat] of byRenderId) {
    heat.tokens = Math.round(heat.tokens);
    heat.reads = readsByRender.get(renderId) ?? 0;
    heat.files = filesByRender.get(renderId)?.size ?? 0;
    if (heat.tokens > max) max = heat.tokens;
  }

  return { byRenderId, max, hotSymbols: bySymbol.size, hotFiles };
}

/**
 * 0..1 intensity on a square-root scale, so one enormous read does not
 * flatten every other node to invisible. Zero stays zero.
 */
export function heatIntensity(tokens: number, max: number): number {
  if (!(tokens > 0) || !(max > 0)) return 0;
  return Math.min(1, Math.sqrt(tokens / max));
}

/** Fill alpha for the single-hue ramp: visible floor, never fully opaque. */
export function heatAlpha(intensity: number): number {
  if (intensity <= 0) return 0;
  return 0.14 + 0.5 * intensity;
}

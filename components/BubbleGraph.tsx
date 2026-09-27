"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  aggregate,
  type RenderEdge,
  type RenderGraph,
  type RenderNode,
} from "@/lib/aggregate";
import type { GraphEdge } from "@/lib/graph";
import {
  entryForNote,
  fetchMemoryGraph,
  overlayMemory,
  readMemoryIndex,
  type AnchoredEntry,
  type MemoryGraph,
  type NoteOverlayNode,
} from "@/lib/client/memory-graph";
import { Segmented } from "@/components/vibe/primitives";
import { SCOPE_OPTIONS, useUsage } from "@/components/vibe/usage-ui";
import { computeHeat, heatAlpha, heatIntensity, type HeatMap } from "@/lib/client/usage-heat";
import { formatTok, type UsageScope } from "@/lib/client/usage";
import { useUsageStore } from "@/store/usage";
import { useViberon } from "@/store/viberon";

/**
 * The force-graph library renders `nodeLabel` with innerHTML, and symbol
 * names and paths come from whatever repository was opened. Escape them.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ForceGraph2D = dynamic(
  () => import("react-force-graph-2d").then((m) => m.default),
  { ssr: false },
);

/** Code nodes from the aggregator, plus memory notes when the overlay is on. */
type RFGNode = Omit<RenderNode, "kind"> & {
  kind: RenderNode["kind"] | "note";
  note?: NoteOverlayNode;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
};
type RFGLink = {
  source: string | RFGNode;
  target: string | RFGNode;
  kind: GraphEdge["kind"] | "memory";
  weight: number;
};

const NOTE_RADIUS = 4.5;

// ---- Color palette ---------------------------------------------------------
// Canvas can't resolve CSS custom properties, so the theme tokens are read
// from :root (and re-read whenever the theme attribute changes). Hex
// fallbacks match the dark theme.
type Palette = {
  bgBase: string;
  line: string;
  lineStrong: string;
  text: string;
  textMid: string;
  textDim: string;
  textFaint: string;
  accent: string;
  add: string;
};

const FALLBACK_PALETTE: Palette = {
  bgBase: "#151516",
  line: "#262628",
  lineStrong: "#34343a",
  text: "#d6d6d6",
  textMid: "#a8a8ab",
  textDim: "#8b8b8e",
  textFaint: "#5e5e62",
  accent: "#6b9eff",
  add: "#6cbf84",
};

function readPalette(): Palette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const cs = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    bgBase: get("--vb-bg-base", FALLBACK_PALETTE.bgBase),
    line: get("--vb-line", FALLBACK_PALETTE.line),
    lineStrong: get("--vb-line-strong", FALLBACK_PALETTE.lineStrong),
    text: get("--vb-text", FALLBACK_PALETTE.text),
    textMid: get("--vb-text-mid", FALLBACK_PALETTE.textMid),
    textDim: get("--vb-text-dim", FALLBACK_PALETTE.textDim),
    textFaint: get("--vb-text-faint", FALLBACK_PALETTE.textFaint),
    accent: get("--vb-accent", FALLBACK_PALETTE.accent),
    add: get("--vb-add", FALLBACK_PALETTE.add),
  };
}

/** Apply an alpha to a #rgb / #rrggbb / rgb() / rgba() color string. */
function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((ch) => ch + ch).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(c);
  if (rgb) {
    return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${alpha})`;
  }
  return c;
}

/** Flat rounded-rect path (does not rely on ctx.roundRect availability). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

// ---- Sizing ----------------------------------------------------------------
function nodeRadius(node: Pick<RFGNode, "kind" | "totalLoc">): number {
  if (node.kind === "note") return NOTE_RADIUS;
  if (node.kind === "folder") {
    // Folder super-nodes scale with total contained LOC, but capped so a
    // single huge folder doesn't dominate the canvas.
    return Math.max(10, Math.min(34, Math.sqrt(Math.max(0, node.totalLoc)) * 1.6));
  }
  return Math.max(4, Math.min(22, Math.sqrt(Math.max(0, node.totalLoc)) * 2));
}

function endpointId(end: string | RFGNode): string | undefined {
  return typeof end === "string" ? end : end?.id;
}

// Shared overlay styles (tokens only, flat).
const panelStyle: React.CSSProperties = {
  background: "var(--vb-bg-overlay)",
  border: "1px solid var(--vb-line)",
};
const dividerStyle: React.CSSProperties = { background: "var(--vb-line)" };

const TOOLTIP_BOX =
  "background: var(--vb-bg-overlay); border: 1px solid var(--vb-line-strong); padding: 8px 10px; border-radius: 4px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--vb-text); box-shadow: var(--vb-shadow-pop);";
const TOOLTIP_DIM = "color: var(--vb-text-dim); font-size: 11px;";

export function BubbleGraph() {
  const graph = useViberon((s) => s.graph);
  const pulseIds = useViberon((s) => s.pulseIds);
  const selectedNodeId = useViberon((s) => s.selectedNodeId);
  const expandedFolders = useViberon((s) => s.expandedFolders);
  // The current run's context ledger drives the "reading via graph" readout.
  const ledger = useViberon((s) => s.run?.ledger);
  const toggleFolderExpansion = useViberon((s) => s.toggleFolder);
  const setExpandedFolders = useViberon((s) => s.setExpandedFolders);
  const repoKey = useViberon((s) => s.repoKey);
  const rootPath = useViberon((s) => s.rootPath);
  // Token heatmap: an independent layer, composable with the memory overlay.
  const heatOn = useUsageStore((s) => s.graphHeat);
  const { scope: heatScope, usage } = useUsage();

  // Memory overlay: vault notes drawn over the code graph.
  const [layer, setLayer] = useState<"code" | "memory">("code");
  const [memGraph, setMemGraph] = useState<MemoryGraph | null>(null);
  const [memEntries, setMemEntries] = useState<AnchoredEntry[]>([]);
  const [openNote, setOpenNote] = useState<NoteOverlayNode | null>(null);
  useEffect(() => {
    if (layer !== "memory" || !repoKey) return;
    let live = true;
    void fetchMemoryGraph(repoKey, graph, rootPath)
      .then((g) => live && setMemGraph(g))
      .catch(() => live && setMemGraph({ nodes: [], links: [] }));
    void fetch(`/api/memory?repoKey=${encodeURIComponent(repoKey)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => live && setMemEntries(readMemoryIndex(body, { graph, rootPath }).entries));
    return () => {
      live = false;
    };
  }, [layer, repoKey, graph, rootPath]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // Theme tokens for canvas painting. Re-read when <html>'s theme changes.
  const [pal, setPal] = useState<Palette>(readPalette);
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => setPal(readPalette()));
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => mo.disconnect();
  }, []);

  // RAF-driven re-render so canvas painters can read `performance.now()`
  // and draw smooth animation each frame.
  const [, setTick] = useState(0);
  useEffect(() => {
    let id: number;
    const tick = () => {
      setTick((t) => (t + 1) % 1_000_000);
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, []);

  // One-shot pulse rings.
  const pulseStartRef = useRef<number>(0);
  useEffect(() => {
    pulseStartRef.current = performance.now();
  }, [pulseIds]);

  const selectPulseStartRef = useRef<number>(0);
  useEffect(() => {
    if (selectedNodeId) {
      selectPulseStartRef.current = performance.now();
      try {
        fgRef.current?.d3ReheatSimulation?.();
      } catch {
        // ignore
      }
    }
  }, [selectedNodeId]);

  // Idle reheat keeps the layout feeling alive when nothing's selected.
  useEffect(() => {
    if (selectedNodeId) return;
    const interval = setInterval(() => {
      try {
        fgRef.current?.d3ReheatSimulation?.();
      } catch {
        // ignore
      }
    }, 4500);
    return () => clearInterval(interval);
  }, [selectedNodeId]);

  // Container size tracking.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      setSize({ width: el.clientWidth, height: el.clientHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Aggregation ---------------------------------------------------------
  const renderGraph = useMemo<RenderGraph | null>(() => {
    if (!graph) return null;
    return aggregate(graph, expandedFolders);
  }, [graph, expandedFolders]);

  const heat = useMemo<HeatMap | null>(() => {
    if (!heatOn || !graph || !renderGraph) return null;
    return computeHeat(graph, renderGraph.symbolToRenderId, usage.files, usage.nodes);
  }, [heatOn, graph, renderGraph, usage.files, usage.nodes]);

  const overlay = useMemo(() => {
    if (layer !== "memory" || !memGraph || !graph || !renderGraph) return null;
    return overlayMemory(memGraph, graph, renderGraph.symbolToRenderId);
  }, [layer, memGraph, graph, renderGraph]);

  const data = useMemo(() => {
    if (!renderGraph) return { nodes: [] as RFGNode[], links: [] as RFGLink[] };
    const nodes: RFGNode[] = renderGraph.nodes.map((n) => ({ ...n }));
    const links: RFGLink[] = renderGraph.edges.map((e: RenderEdge) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      weight: e.weight,
    }));
    if (overlay) {
      for (const note of overlay.notes) {
        nodes.push({ id: note.id, kind: "note", name: note.label, note, totalLoc: 0, folder: "" });
      }
      for (const l of overlay.links) links.push({ source: l.source, target: l.target, kind: "memory", weight: 1 });
    }
    return { nodes, links };
  }, [renderGraph, overlay]);

  // Map raw symbol pulseIds → render ids (folder super-nodes when collapsed).
  const pulseSet = useMemo<Set<string>>(() => {
    if (!renderGraph) return new Set();
    const out = new Set<string>();
    for (const symbolId of pulseIds) {
      const renderId = renderGraph.symbolToRenderId.get(symbolId);
      if (renderId) out.add(renderId);
    }
    return out;
  }, [pulseIds, renderGraph]);

  // Top folders for the legend (off the raw graph for stability across
  // expansion changes).
  const folderList = useMemo<{ folder: string; count: number }[]>(() => {
    if (!graph) return [];
    const counts = new Map<string, number>();
    for (const n of graph.nodes) {
      counts.set(n.folder, (counts.get(n.folder) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([folder, count]) => ({ folder, count }));
  }, [graph]);

  // Adjacency over the aggregated render edges so hover/select highlights
  // operate on the current view.
  const neighborMap = useMemo<Map<string, Set<string>>>(() => {
    const map = new Map<string, Set<string>>();
    for (const e of data.links) {
      const source = endpointId(e.source);
      const target = endpointId(e.target);
      if (!source || !target || source === target) continue;
      let a = map.get(source);
      if (!a) {
        a = new Set();
        map.set(source, a);
      }
      a.add(target);
      let b = map.get(target);
      if (!b) {
        b = new Set();
        map.set(target, b);
      }
      b.add(source);
    }
    return map;
  }, [data]);

  // Hover wins; an open memory note keeps its code nodes lit.
  const focusId = hoveredId ?? openNote?.id ?? null;
  const highlightedSet = useMemo<Set<string> | null>(() => {
    if (!focusId) return null;
    const neighbors = neighborMap.get(focusId);
    const out = new Set<string>([focusId]);
    if (neighbors) for (const id of neighbors) out.add(id);
    return out;
  }, [focusId, neighborMap]);

  const selectedNeighborsSet = useMemo<Set<string> | null>(() => {
    if (!selectedNodeId) return null;
    const neighbors = neighborMap.get(selectedNodeId);
    const out = new Set<string>([selectedNodeId]);
    if (neighbors) for (const id of neighbors) out.add(id);
    return out;
  }, [selectedNodeId, neighborMap]);

  // Imperative controls.
  function zoomFit() {
    try {
      fgRef.current?.zoomToFit?.(400, 60);
    } catch {
      // ignore
    }
  }
  function zoomIn() {
    try {
      const cur = fgRef.current?.zoom?.() ?? 1;
      fgRef.current?.zoom?.(cur * 1.4, 250);
    } catch {
      // ignore
    }
  }
  function zoomOut() {
    try {
      const cur = fgRef.current?.zoom?.() ?? 1;
      fgRef.current?.zoom?.(cur / 1.4, 250);
    } catch {
      // ignore
    }
  }

  // Auto zoom-to-fit on first mount only. After that, the user's
  // zoom/pan is theirs to keep — re-running zoomFit on every data change
  // (folder expand, retrieval pulse, etc.) feels like the graph is fighting
  // the user.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (data.nodes.length === 0) return;
    const t = setTimeout(() => {
      zoomFit();
      didFitRef.current = true;
    }, 600);
    return () => clearTimeout(t);
  }, [data.nodes.length]);

  if (!graph || !renderGraph) return null;

  const symbolNodeCount = renderGraph.nodes.filter((n) => n.kind !== "folder").length;
  const folderNodeCount = renderGraph.nodes.length - symbolNodeCount;
  const graphReadSavedPct =
    ledger && ledger.baselineTokens > 0 ? ledger.savedPercent : null;

  // Derived canvas colors (flat, neutral; accent for selection, green for
  // retrieved/in-context only).
  const edgeCall = withAlpha(pal.textDim, 0.45);
  const edgeImport = withAlpha(pal.textDim, 0.25);
  const edgeDimmed = withAlpha(pal.textDim, 0.08);
  const edgeHover = withAlpha(pal.textMid, 0.7);
  const arrowDefault = withAlpha(pal.textDim, 0.6);
  const folderFill = pal.lineStrong;
  const folderStroke = pal.textFaint;
  const symbolFill = pal.textFaint;
  const symbolStroke = pal.textDim;
  const edgeMemory = withAlpha(pal.textMid, 0.45);

  return (
    <div ref={containerRef} className="pointer-events-auto absolute inset-0 touch-none">
      {size.width > 0 && size.height > 0 ? (
        <ForceGraph2D
          ref={fgRef}
          graphData={data}
          width={size.width}
          height={size.height}
          backgroundColor="transparent"
          cooldownTicks={140}
          enableNodeDrag
          enableZoomInteraction
          enablePanInteraction
          enablePointerInteraction
          warmupTicks={20}
          minZoom={0.05}
          maxZoom={8}
          // ---- Edges
          linkDirectionalArrowLength={(raw) => {
            const l = raw as RFGLink;
            if (l.kind === "memory") return 0;
            return l.kind === "call" ? 4 : 2.5;
          }}
          linkDirectionalArrowRelPos={0.92}
          linkDirectionalArrowColor={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!a || !b) return arrowDefault;
            if (pulseSet.has(a) && pulseSet.has(b)) return pal.add;
            if (selectedNodeId && (a === selectedNodeId || b === selectedNodeId)) {
              return pal.accent;
            }
            return arrowDefault;
          }}
          linkDirectionalParticles={(raw) => {
            const l = raw as RFGLink;
            if (l.kind === "memory") return 0;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (a && b && pulseSet.has(a) && pulseSet.has(b)) return 4;
            if (selectedNodeId && a && b && (a === selectedNodeId || b === selectedNodeId)) return 2;
            return 0;
          }}
          linkDirectionalParticleSpeed={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (a && b && pulseSet.has(a) && pulseSet.has(b)) return 0.014;
            return 0.007;
          }}
          linkDirectionalParticleWidth={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (a && b && pulseSet.has(a) && pulseSet.has(b)) return 3;
            return 2;
          }}
          linkDirectionalParticleColor={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (a && b && pulseSet.has(a) && pulseSet.has(b)) return pal.add;
            return pal.accent;
          }}
          linkColor={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!a || !b) return edgeImport;

            if (l.kind === "memory") {
              if (highlightedSet) return highlightedSet.has(a) && highlightedSet.has(b) ? edgeHover : edgeDimmed;
              return edgeMemory;
            }

            if (pulseSet.has(a) && pulseSet.has(b)) return pal.add;

            if (highlightedSet) {
              if (highlightedSet.has(a) && highlightedSet.has(b)) {
                return edgeHover;
              }
              return edgeDimmed;
            }

            if (selectedNodeId) {
              if (a === selectedNodeId || b === selectedNodeId) {
                return pal.accent;
              }
              return edgeDimmed;
            }

            return l.kind === "call" ? edgeCall : edgeImport;
          }}
          linkWidth={(raw) => {
            const l = raw as RFGLink;
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (!a || !b) return 1;
            if (l.kind === "memory") return highlightedSet?.has(a) && highlightedSet.has(b) ? 1 : 0.6;

            // Aggregated edges visually scale with weight (call/import count).
            const weighted = Math.min(2.4, 1.0 + Math.log10(Math.max(1, l.weight)) * 0.9);

            if (pulseSet.has(a) && pulseSet.has(b)) return Math.max(2.0, weighted);
            if (highlightedSet) {
              if (highlightedSet.has(a) && highlightedSet.has(b)) return Math.max(1.4, weighted);
              return 0.4;
            }
            if (selectedNodeId) {
              if (a === selectedNodeId || b === selectedNodeId) return Math.max(1.6, weighted);
              return 0.4;
            }
            return weighted;
          }}
          linkLineDash={(raw) => {
            const l = raw as RFGLink;
            if (l.kind === "memory") return [2, 2];
            const a = endpointId(l.source);
            const b = endpointId(l.target);
            if (a && b && pulseSet.has(a) && pulseSet.has(b)) return [5, 5];
            return null;
          }}
          // ---- Nodes
          nodeCanvasObjectMode={() => "replace"}
          nodeCanvasObject={(raw, ctx, scale) => {
            const n = raw as RFGNode;
            if (typeof n.x !== "number" || typeof n.y !== "number") return;

            if (n.kind === "note") {
              // Memory note: a small hollow ring, dimmed when stale.
              const px = 1 / Math.max(scale, 1);
              const open = openNote?.id === n.id;
              const hovered = hoveredId === n.id;
              const lit = !highlightedSet || highlightedSet.has(n.id);
              const prevAlpha = ctx.globalAlpha;
              ctx.globalAlpha = (n.note?.stale ? 0.4 : 1) * (lit ? 1 : 0.3);
              ctx.fillStyle = pal.bgBase;
              ctx.strokeStyle = open ? pal.accent : hovered ? pal.text : pal.textMid;
              ctx.lineWidth = (open ? 1.5 : 1.2) * px;
              ctx.beginPath();
              ctx.arc(n.x, n.y, NOTE_RADIUS, 0, 2 * Math.PI);
              ctx.fill();
              ctx.stroke();
              if (open || hovered || scale > 1.6) {
                const fontSize = 10.5 * px;
                ctx.font = `400 ${fontSize}px ui-monospace, Menlo, monospace`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = open || hovered ? pal.text : pal.textDim;
                ctx.fillText(n.name, n.x, n.y + NOTE_RADIUS + 3 * px);
              }
              ctx.globalAlpha = prevAlpha;
              return;
            }

            const isFolder = n.kind === "folder";
            const isSelected = n.id === selectedNodeId;
            const isPulsed = pulseSet.has(n.id);
            const isHovered = hoveredId === n.id;
            const baseR = nodeRadius(n);
            // Heatmap: one hue (the accent) whose opacity carries the value; hot
            // symbols also grow a little, since expanded symbols are small.
            const nodeHeat = heat?.byRenderId.get(n.id);
            const intensity = heat ? heatIntensity(nodeHeat?.tokens ?? 0, heat.max) : 0;
            const heatScale = !isFolder && intensity > 0 ? 1 + 0.6 * intensity : 1;
            const r = (isSelected ? baseR * 1.25 : isPulsed ? baseR * 1.1 : baseR) * heatScale;
            const px = 1 / Math.max(scale, 1);

            const prevAlpha = ctx.globalAlpha;
            const prevLineWidth = ctx.lineWidth;

            // Alpha
            let alpha: number;
            if (isPulsed) {
              alpha = 1.0;
            } else if (highlightedSet) {
              alpha = highlightedSet.has(n.id) ? 1.0 : 0.25;
            } else if (selectedNeighborsSet) {
              alpha = selectedNeighborsSet.has(n.id) ? 1.0 : 0.35;
            } else {
              alpha = 1.0;
            }
            // With the heatmap on, nodes that sent nothing recede.
            if (heat && intensity === 0 && !isPulsed && !isSelected && !isHovered) alpha *= 0.4;
            ctx.globalAlpha = alpha;

            // Flat fill + 1px outline. Folder super-nodes use a dashed
            // outline so they read as containers.
            if (heat && intensity > 0) {
              ctx.fillStyle = pal.bgBase;
              ctx.beginPath();
              ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
              ctx.fill();
              ctx.fillStyle = withAlpha(pal.accent, heatAlpha(intensity));
            } else {
              ctx.fillStyle = isFolder ? folderFill : symbolFill;
            }
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.fill();

            let outline = isFolder ? folderStroke : symbolStroke;
            if (heat && intensity > 0) outline = withAlpha(pal.accent, 0.5 + 0.5 * intensity);
            if (isHovered) outline = pal.textMid;
            if (isPulsed) outline = pal.add;
            if (isSelected) outline = pal.accent;
            const emphasized = isSelected || isPulsed;

            ctx.save();
            if (isFolder && !emphasized) ctx.setLineDash([3 * px, 2 * px]);
            ctx.strokeStyle = outline;
            ctx.lineWidth = (emphasized ? 1.5 : 1) * px;
            ctx.beginPath();
            ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.restore();

            // Folder count: number of contained symbols.
            if (isFolder && r >= 12 && scale > 0.5) {
              const sizeText = String(n.folderSize ?? 0);
              const badgeFont = Math.min(11, r * 0.55) * px;
              ctx.font = `500 ${badgeFont}px ui-monospace, Menlo, monospace`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = heat && intensity > 0.55 ? pal.bgBase : pal.textMid;
              ctx.fillText(sizeText, n.x, n.y);
            }

            // Retrieval ring (transient, expands once then disappears).
            if (isPulsed) {
              const elapsed = performance.now() - pulseStartRef.current;
              if (elapsed < 2500) {
                const t = elapsed / 2500;
                const ease = 1 - Math.pow(1 - t, 3);
                const ringR = r + (r * 2.5 - r) * ease;
                ctx.globalAlpha = 0.8 * (1 - ease);
                ctx.strokeStyle = pal.add;
                ctx.lineWidth = px;
                ctx.beginPath();
                ctx.arc(n.x, n.y, ringR, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.globalAlpha = alpha;
              }
            }

            // Selection ripple (transient)
            if (isSelected) {
              const elapsed = performance.now() - selectPulseStartRef.current;
              if (elapsed < 1200) {
                const t = elapsed / 1200;
                const ease = 1 - Math.pow(1 - t, 3);
                const ringR = r + (r * 2.2 - r) * ease;
                ctx.globalAlpha = 0.7 * (1 - ease);
                ctx.strokeStyle = pal.accent;
                ctx.lineWidth = px;
                ctx.beginPath();
                ctx.arc(n.x, n.y, ringR, 0, 2 * Math.PI);
                ctx.stroke();
                ctx.globalAlpha = alpha;
              }
            }

            // Labels: folder super-nodes always show their folder name when
            // legible. Symbols show on selected/pulsed/hovered, plus when
            // zoomed in enough.
            const showLabel =
              isSelected ||
              isPulsed ||
              isHovered ||
              (isFolder && scale > 0.3) ||
              (!isFolder && scale > 1.3 && r > 9);
            if (showLabel) {
              const label = n.name;
              ctx.globalAlpha = emphasized || isHovered ? 1 : Math.max(alpha, 0.6);
              const fontSize = 11 * px;
              ctx.font = `${isFolder ? 500 : 400} ${fontSize}px ui-monospace, Menlo, monospace`;
              ctx.textAlign = "center";
              ctx.textBaseline = "top";
              const padY = r + 4 * px;
              const textWidth = ctx.measureText(label).width;
              const padX = 4 * px;
              const labelH = 15 * px;
              const boxX = n.x - textWidth / 2 - padX;
              const boxY = n.y + padY;
              const boxW = textWidth + padX * 2;
              roundRectPath(ctx, boxX, boxY, boxW, labelH, 3 * px);
              ctx.fillStyle = withAlpha(pal.bgBase, 0.9);
              ctx.fill();
              ctx.strokeStyle = pal.line;
              ctx.lineWidth = px;
              ctx.stroke();
              ctx.fillStyle = emphasized || isHovered ? pal.text : pal.textMid;
              ctx.fillText(label, n.x, boxY + 2 * px);
            }

            ctx.globalAlpha = prevAlpha;
            ctx.lineWidth = prevLineWidth;
          }}
          nodePointerAreaPaint={(raw, color, ctx) => {
            const n = raw as RFGNode;
            if (typeof n.x !== "number" || typeof n.y !== "number") return;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(n.x, n.y, nodeRadius(n), 0, 2 * Math.PI);
            ctx.fill();
          }}
          nodeLabel={(raw) => {
            const node = raw as RFGNode;
            if (node.kind === "note") {
              return `
                <div style="${TOOLTIP_BOX}">
                  <div style="${TOOLTIP_DIM} margin-bottom: 4px;">note${node.note?.stale ? " · may be outdated" : ""}</div>
                  <div style="color: var(--vb-text)">${escapeHtml(node.name)}</div>
                </div>
              `;
            }
            const isRetrieved = pulseSet.has(node.id);
            const h = heat?.byRenderId.get(node.id);
            const heatLine = heat
              ? `<div style="${TOOLTIP_DIM} margin-top: 4px;">${
                  h && h.tokens > 0
                    ? `<span style="color: var(--vb-text)">${escapeHtml(formatTok(h.tokens))} tokens</span> sent · ${Number(h.reads)} read${h.reads === 1 ? "" : "s"}${node.kind === "folder" ? ` · ${Number(h.files)} file${h.files === 1 ? "" : "s"}` : " · click to open"}`
                  : "no context sent"
                }</div>`
              : "";
            const nameColor =
              node.id === selectedNodeId ? "var(--vb-accent)" : "var(--vb-text)";
            const status = isRetrieved
              ? `<span style="color: var(--vb-add); font-size: 11px;">In context</span>`
              : "";
            if (node.kind === "folder") {
              return `
                <div style="${TOOLTIP_BOX}">
                  <div style="${TOOLTIP_DIM} margin-bottom: 4px;">folder</div>
                  <div style="display: flex; align-items: baseline; gap: 8px;">
                    <span style="font-weight: 600; color: ${nameColor}">${escapeHtml(node.name)}</span>
                    <span style="${TOOLTIP_DIM}">${Number(node.folderSize ?? 0)} symbols</span>
                    ${status}
                  </div>
                  <div style="${TOOLTIP_DIM} margin-top: 4px;">${Number(node.totalLoc ?? 0)} total LOC · click to expand</div>
                  ${heatLine}
                </div>
              `;
            }
            const sym = node.symbol;
            return `
              <div style="${TOOLTIP_BOX}">
                <div style="${TOOLTIP_DIM} margin-bottom: 4px;">${escapeHtml(sym?.file ?? "")}</div>
                <div style="display: flex; align-items: baseline; gap: 8px;">
                  <span style="font-weight: 600; color: ${nameColor}">${escapeHtml(node.name)}</span>
                  <span style="${TOOLTIP_DIM}">${escapeHtml(node.kind)}</span>
                  ${status}
                </div>
                <div style="${TOOLTIP_DIM} margin-top: 4px;">${Number(sym?.loc ?? 0)} LOC · lines ${Number(sym?.startLine ?? 0)}–${Number(sym?.endLine ?? 0)}</div>
                ${heatLine}
              </div>
            `;
          }}
          onNodeHover={(raw) => {
            const id = (raw as RFGNode | null)?.id;
            setHoveredId(typeof id === "string" ? id : null);
          }}
          onNodeClick={(raw) => {
            const n = raw as RFGNode;
            if (n.kind === "note" && n.note) {
              setOpenNote((cur) => (cur?.id === n.id ? null : (n.note ?? null)));
              return;
            }
            if (n.kind === "folder" && n.folderPath) {
              toggleFolderExpansion(n.folderPath);
              return;
            }
            if (typeof n.id === "string") {
              const store = useViberon.getState();
              store.selectNode(n.id);
              // With the heatmap on, a hot symbol opens where its tokens went.
              if (heat?.byRenderId.get(n.id) && n.symbol?.file) {
                store.openTab(n.symbol.file, undefined, { preview: true });
              }
            }
          }}
        />
      ) : null}

      {/* Top toolbar overlay */}
      <div className="pointer-events-none absolute left-4 right-4 top-4 flex items-center justify-between gap-2">
        <div
          className="pointer-events-auto flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap rounded-[4px] px-2.5 py-1.5"
          style={panelStyle}
        >
          <div className="flex items-center gap-1.5">
            <span
              className="size-1.5 rounded-full"
              style={{ background: "var(--vb-add)" }}
            />
            <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              Live graph
            </span>
          </div>
          <span className="h-3 w-px" style={dividerStyle} />
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-mid)" }}>
            {graph.nodes.length} symbols · {graph.edges.length} edges
          </span>
          <span className="h-3 w-px" style={dividerStyle} />
          <span
            className="font-mono text-[11px]"
            style={{ color: "var(--vb-text-mid)" }}
            title={`Adaptive folder aggregation, depth ${renderGraph.depth}. Click a folder bubble to expand it.`}
          >
            {folderNodeCount} folders
            {symbolNodeCount > 0 ? ` · ${symbolNodeCount} expanded` : ""}
          </span>
          {overlay && (
            <>
              <span className="h-3 w-px" style={dividerStyle} />
              <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-mid)" }}>
                {overlay.notes.length} note{overlay.notes.length === 1 ? "" : "s"}
              </span>
            </>
          )}
          {pulseIds.length > 0 && (
            <>
              <span className="h-3 w-px" style={dividerStyle} />
              <span className="font-mono text-[11px]" style={{ color: "var(--vb-add)" }}>
                {pulseIds.length} in context
              </span>
            </>
          )}
          {ledger && ledger.sentTokens > 0 && (
            <>
              <span className="h-3 w-px" style={dividerStyle} />
              <span
                className="max-w-[260px] truncate font-mono text-[11px]"
                style={{ color: "var(--vb-text-mid)" }}
                title={`Sent ${ledger.sentTokens} tokens of graph slices where whole files would have cost ${ledger.baselineTokens}`}
              >
                graph context · {ledger.sentTokens} tokens
                {graphReadSavedPct !== null ? ` · ${graphReadSavedPct}% saved` : ""}
              </span>
            </>
          )}
          {expandedFolders.size > 0 && (
            <>
              <span className="h-3 w-px" style={dividerStyle} />
              <button
                onClick={() => setExpandedFolders(new Set())}
                className="rounded-[4px] px-1.5 py-0.5 text-[11px] text-[var(--vb-text-mid)] transition-colors hover:bg-[var(--vb-hover)] hover:text-[var(--vb-text)]"
              >
                Collapse all
              </button>
            </>
          )}
        </div>
        <div className="pointer-events-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => useUsageStore.getState().setGraphHeat(!heatOn)}
          aria-pressed={heatOn}
          title="Shade nodes by context tokens sent to the model"
          className="h-[24px] rounded-[4px] px-2 text-[11.5px] font-medium hover:bg-[var(--vb-hover)]"
          style={{
            ...panelStyle,
            color: heatOn ? "var(--vb-text-hi)" : "var(--vb-text-dim)",
            background: heatOn ? "var(--vb-active)" : panelStyle.background,
          }}
        >
          Tokens
        </button>
        <div className="rounded-[4px] p-px" style={panelStyle}>
          <Segmented<"code" | "memory">
            value={layer}
            options={[
              { value: "code", label: "Code" },
              { value: "memory", label: "+ Memory", title: "Overlay memory notes from the vault" },
            ]}
            onChange={(next) => {
              setLayer(next);
              if (next === "code") setOpenNote(null);
            }}
          />
        </div>
        <div
          className="flex items-center gap-0.5 rounded-[4px] p-0.5"
          style={panelStyle}
        >
          <button
            onClick={zoomOut}
            className="rounded-[4px] px-2 py-0.5 text-xs text-[var(--vb-text-mid)] transition-colors hover:bg-[var(--vb-hover)] hover:text-[var(--vb-text)]"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomFit}
            className="rounded-[4px] px-2 py-0.5 text-[11px] text-[var(--vb-text-mid)] transition-colors hover:bg-[var(--vb-hover)] hover:text-[var(--vb-text)]"
          >
            Fit
          </button>
          <button
            onClick={zoomIn}
            className="rounded-[4px] px-2 py-0.5 text-xs text-[var(--vb-text-mid)] transition-colors hover:bg-[var(--vb-hover)] hover:text-[var(--vb-text)]"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
        </div>
      </div>

      {openNote && (
        <NoteCard
          note={openNote}
          entry={entryForNote(memEntries, openNote)}
          onClose={() => setOpenNote(null)}
        />
      )}

      {/* Bottom-left legend */}
      <div className="pointer-events-none absolute bottom-4 left-4 flex flex-col gap-2">
        {heat && <HeatLegend heat={heat} scope={heatScope} accent={pal.accent} />}
        <div className="rounded-[4px] px-2.5 py-2" style={panelStyle}>
          <div className="mb-1.5 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            Legend
          </div>
          <div
            className="flex flex-col gap-1 text-[11px]"
            style={{ color: "var(--vb-text-mid)" }}
          >
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{
                  background: "var(--vb-line-strong)",
                  border: "1px dashed var(--vb-text-faint)",
                }}
              />
              folder (click to expand)
            </div>
            <div className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{
                  background: "var(--vb-text-faint)",
                  border: "1px solid var(--vb-text-dim)",
                }}
              />
              function / class
            </div>
            <div className="flex items-center gap-2">
              <span className="h-px w-6" style={{ background: edgeCall }} />
              call edge
            </div>
            <div className="flex items-center gap-2">
              <span className="h-px w-6" style={{ background: edgeImport }} />
              import edge
            </div>
            <div className="flex items-center gap-2">
              <span className="h-px w-6" style={{ background: "var(--vb-add)" }} />
              in chat context
            </div>
            {overlay && (
              <>
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full"
                    style={{ border: "1px solid var(--vb-text-mid)" }}
                  />
                  memory note
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className="size-2.5 rounded-full opacity-40"
                    style={{ border: "1px solid var(--vb-text-mid)" }}
                  />
                  note, may be outdated
                </div>
              </>
            )}
          </div>
        </div>
        {folderList.length > 0 && (
          <div className="rounded-[4px] px-2.5 py-2" style={panelStyle}>
            <div className="mb-1.5 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              Top folders
            </div>
            <div
              className="flex flex-col gap-1 text-[11px]"
              style={{ color: "var(--vb-text-mid)" }}
            >
              {folderList.map(({ folder, count }) => (
                <div key={folder} className="flex items-center gap-3">
                  <span className="truncate font-mono">{folder || "/"}</span>
                  <span className="ml-auto font-mono" style={{ color: "var(--vb-text-dim)" }}>
                    {count}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Heatmap key: the ramp, its range, and which scope it shows. */
function HeatLegend({ heat, scope, accent }: { heat: HeatMap; scope: UsageScope; accent: string }) {
  const steps = [0.1, 0.3, 0.5, 0.75, 1];
  return (
    <div className="pointer-events-auto flex w-[252px] flex-col gap-2 rounded-[4px] px-2.5 py-2" style={panelStyle}>
      <div className="flex items-center gap-2">
        <span className="whitespace-nowrap text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          Context tokens
        </span>
        <span className="flex-1" />
        <Segmented<UsageScope>
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={(next) => useUsageStore.getState().setScope(next)}
        />
      </div>
      {heat.max > 0 ? (
        <>
          <div className="flex h-2 overflow-hidden rounded-[2px]" style={{ background: "var(--vb-bg-base)" }}>
            {steps.map((step) => (
              <span key={step} className="h-full flex-1" style={{ background: withAlpha(accent, heatAlpha(step)) }} />
            ))}
          </div>
          <div className="flex items-center font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
            <span>0</span>
            <span className="flex-1" />
            <span>{formatTok(heat.max)}</span>
          </div>
          <div className="text-[11px]" style={{ color: "var(--vb-text-mid)" }}>
            {heat.hotFiles} file{heat.hotFiles === 1 ? "" : "s"} · {heat.hotSymbols} symbol{heat.hotSymbols === 1 ? "" : "s"} in context
          </div>
        </>
      ) : (
        <div className="text-[11px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
          No context sent in this scope yet.
        </div>
      )}
    </div>
  );
}

/** The text of a clicked memory note, pinned to the bottom-right of the graph. */
function NoteCard({
  note,
  entry,
  onClose,
}: {
  note: NoteOverlayNode;
  entry?: AnchoredEntry;
  onClose: () => void;
}) {
  const text = entry?.text ?? note.text ?? note.label;
  const stale = entry?.stale ?? note.stale;
  return (
    <div
      className="pointer-events-auto absolute bottom-4 right-4 flex w-[300px] max-w-[calc(100%-2rem)] flex-col gap-1 rounded-[4px] px-2.5 py-2"
      style={panelStyle}
      role="dialog"
      aria-label="Memory note"
    >
      <div className="flex items-center gap-2 text-[11px]">
        <span className="font-mono" style={{ color: "var(--vb-text-faint)" }}>
          {entry?.kind ?? "note"}
        </span>
        {stale && <span style={{ color: "var(--vb-amber)" }}>may be outdated</span>}
        <span className="min-w-0 flex-1 truncate font-mono" style={{ color: "var(--vb-text-faint)" }} title={note.noteId}>
          {note.noteId}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded-[3px] px-1 hover:bg-[var(--vb-hover)] hover:text-[var(--vb-text)]"
          style={{ color: "var(--vb-text-dim)" }}
          aria-label="Close note"
        >
          ×
        </button>
      </div>
      <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: "var(--vb-text)" }}>
        {text}
      </p>
      {entry && entry.anchors.length > 0 && (
        <p className="truncate font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }} title={entry.anchors.join("\n")}>
          {entry.anchors.join(" · ")}
        </p>
      )}
    </div>
  );
}

export default BubbleGraph;

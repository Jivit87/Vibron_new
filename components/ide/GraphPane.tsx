"use client";

import { BubbleGraph } from "@/components/BubbleGraph";
import { useViberon } from "@/store/viberon";

export function GraphPane() {
  const hasGraph = useViberon((s) => Boolean(s.graph?.nodes.length));
  return (
    <div className="relative h-full w-full">
      {hasGraph ? (
        <BubbleGraph />
      ) : (
        <div className="flex h-full items-center justify-center">
          <div className="flex max-w-[320px] flex-col gap-1 text-center">
            <span className="text-[12.5px]" style={{ color: "var(--vb-text)" }}>
              No code graph yet
            </span>
            <span className="text-[12px] leading-relaxed" style={{ color: "var(--vb-text-dim)" }}>
              The graph appears once this workspace is indexed. Functions, classes and their calls and imports show here.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export default GraphPane;

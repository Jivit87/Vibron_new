"use client";

/**
 * Model picker: a searchable, grouped model list in a window positioned
 * against the viewport.
 *
 * The catalog grew past twenty models across five providers, and a plain
 * absolutely-positioned menu both ran off the top of the window (it opens
 * upward from the composer) and was clipped by the agent dock's overflow.
 * This panel is portalled to <body>, placed with fixed coordinates computed
 * from the trigger, flips above/below to whichever side has room, and caps
 * its height to the space it has. The list scrolls; the search box and the
 * detail footer stay put.
 */

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cx } from "@/components/vibe/primitives";
import {
  AUTO,
  displayLabel,
  formatContext,
  formatPrice,
  groupModels,
  matchesModel,
  setupAction,
  type ModelOption,
} from "@/lib/client/model-picker";

export type { ModelOption } from "@/lib/client/model-picker";
import { useViberon } from "@/store/viberon";

const WIDTH = 384;
const MAX_HEIGHT = 480;
const GAP = 6;
const MARGIN = 8;

interface Placement {
  top?: number;
  bottom?: number;
  left: number;
  maxHeight: number;
}

function place(trigger: DOMRect): Placement {
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;
  const above = trigger.top - GAP - MARGIN;
  const below = viewportH - trigger.bottom - GAP - MARGIN;
  const left = Math.min(Math.max(MARGIN, trigger.left), Math.max(MARGIN, viewportW - WIDTH - MARGIN));
  if (above >= below) {
    return { bottom: viewportH - trigger.top + GAP, left, maxHeight: Math.min(MAX_HEIGHT, above) };
  }
  return { top: trigger.bottom + GAP, left, maxHeight: Math.min(MAX_HEIGHT, below) };
}

export function ModelPicker({
  value,
  models,
  onChange,
  onOpen,
}: {
  value: string;
  models: ModelOption[];
  onChange: (model: string) => void;
  /** Called each time the window opens, so the caller can refresh availability. */
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = value === "auto" ? AUTO : models.find((m) => m.id === value);
  const label = value === "auto" ? "Auto model" : (current?.label ?? value);

  const groups = useMemo(() => groupModels(models, query), [models, query]);
  const showAuto = matchesModel(AUTO, query) || query.trim() === "";
  // Flat, selectable order for keyboard navigation.
  const flat = useMemo(
    () => [...(showAuto ? [AUTO] : []), ...groups.flatMap((g) => g.models.filter((m) => m.available))],
    [groups, showAuto],
  );
  const focused = flat[Math.min(highlight, Math.max(0, flat.length - 1))];

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      if (triggerRef.current) setPlacement(place(triggerRef.current.getBoundingClientRect()));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      const target = event.target as Node;
      if (!panelRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Opening starts on the current model; typing starts on the first match.
  useEffect(() => {
    if (!open) return;
    const index = flat.findIndex((m) => m.id === value);
    setHighlight(query ? 0 : Math.max(0, index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(focused?.id ?? "")}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  function choose(model: ModelOption) {
    if (!model.available) return;
    onChange(model.id);
    setOpen(false);
    setQuery("");
    triggerRef.current?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((h) => Math.min(flat.length - 1, h + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (focused) choose(focused);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }

  function row(model: ModelOption) {
    const selected = model.id === value;
    const isFocused = focused?.id === model.id;
    return (
      <button
        key={model.id}
        type="button"
        role="option"
        aria-selected={selected}
        aria-disabled={!model.available}
        data-model-id={model.id}
        onMouseEnter={() => {
          const index = flat.findIndex((m) => m.id === model.id);
          if (index >= 0) setHighlight(index);
        }}
        onClick={() => choose(model)}
        className={cx(
          "flex h-[26px] w-full items-center gap-2 rounded-[3px] px-2 text-left text-[12.5px]",
          !model.available && "cursor-not-allowed",
        )}
        style={{
          background: isFocused && model.available ? "var(--vb-accent-soft)" : undefined,
          color: model.available ? "var(--vb-text-hi)" : "var(--vb-text-faint)",
        }}
      >
        <span className="flex w-3.5 shrink-0 justify-center">
          {selected && <Check className="size-3.5" strokeWidth={2} style={{ color: "var(--vb-accent)" }} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{displayLabel(model)}</span>
        {!model.agentic && model.id !== "auto" && (
          <span className="shrink-0 text-[10.5px]" style={{ color: "var(--vb-text-faint)" }} title="Less reliable at long multi-step tool loops">
            basic
          </span>
        )}
        {model.contextWindow ? (
          <span className="w-10 shrink-0 text-right font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {formatContext(model.contextWindow)}
          </span>
        ) : null}
      </button>
    );
  }

  const panel =
    open && placement
      ? createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label="Choose a model"
            onKeyDown={onKeyDown}
            className="vb-pop fixed z-[100] flex flex-col overflow-hidden"
            style={{
              width: WIDTH,
              maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
              left: placement.left,
              top: placement.top,
              bottom: placement.bottom,
              maxHeight: placement.maxHeight,
            }}
          >
            <div className="flex h-9 shrink-0 items-center gap-2 border-b px-2.5" style={{ borderColor: "var(--vb-line)" }}>
              <Search className="size-3.5 shrink-0" style={{ color: "var(--vb-text-dim)" }} />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models"
                aria-label="Search models"
                aria-controls="model-picker-list"
                className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-[var(--vb-text-faint)]"
                style={{ color: "var(--vb-text-hi)" }}
              />
              <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                {models.filter((m) => m.available).length} ready
              </span>
            </div>

            <div ref={listRef} id="model-picker-list" role="listbox" className="min-h-0 flex-1 overflow-y-auto p-1">
              {showAuto && row(AUTO)}
              {groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.label} className="mt-1">
                  <div className="flex h-6 items-center justify-between px-2">
                    <span className="text-[10.5px] font-medium uppercase tracking-[0.06em]" style={{ color: "var(--vb-text-dim)" }}>
                      {group.label}
                    </span>
                    {!group.configured && (
                      <button
                        type="button"
                        onClick={() => {
                          setOpen(false);
                          useViberon.getState().openSettingsTab();
                        }}
                        className="text-[11px] underline-offset-2 hover:underline"
                        style={{ color: "var(--vb-accent)" }}
                      >
                        {setupAction(group.id)}
                      </button>
                    )}
                  </div>
                  {group.models.map(row)}
                </div>
              ))}
              {!showAuto && groups.length === 0 && (
                <p className="px-2 py-3 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
                  No models match &ldquo;{query}&rdquo;
                </p>
              )}
            </div>

            {focused && (
              <div className="shrink-0 border-t px-3 py-2" style={{ borderColor: "var(--vb-line)" }}>
                <p className="text-[11.5px] leading-snug" style={{ color: "var(--vb-text)" }}>
                  {focused.blurb}
                </p>
                {focused.id !== "auto" && (
                  <p className="mt-1 flex items-center gap-2 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                    <span className="truncate">{focused.id}</span>
                    <span className="ml-auto shrink-0">{formatPrice(focused.pricing)}</span>
                  </p>
                )}
              </div>
            )}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((v) => !v);
        }}
        title={current ? `${current.label}${current.id !== "auto" ? ` (${current.id})` : ""}` : "Model"}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="inline-flex h-[22px] items-center gap-1 rounded-[3px] px-1.5 text-[11.5px] hover:bg-[var(--vb-hover)]"
        style={{ color: "var(--vb-text-dim)" }}
      >
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown className="size-3 opacity-70" />
      </button>
      {panel}
    </>
  );
}

"use client";

/**
 * IDE mode.
 *
 * The full development surface: activity bar, sidebar, editor, a resizable
 * bottom panel (terminal / ledger), an optional preview pane, and the agent
 * run stream docked on the right so you can watch the work while editing.
 *
 * Layout:
 *   ┌──┬────────────┬──────────────────────────┬───────────────┐
 *   │A │ Sidebar    │ Editor / Preview         │ Agent stream  │
 *   │c │            ├──────────────────────────┤               │
 *   │t │            │ Terminal / Ledger        │               │
 *   └──┴────────────┴──────────────────────────┴───────────────┘
 */

import { useEffect, useRef, useState } from "react";
import {
  Brain,
  Files,
  GitBranch,
  GitCompare,
  Network,
  Plus,
  Search,
  Settings as SettingsIcon,
  X,
} from "lucide-react";

import { AgentRunView } from "@/components/vibe/AgentRunView";
import { ChangesPanel } from "@/components/vibe/ChangesPanel";
import { Composer } from "@/components/vibe/Composer";
import { ConversationHistory } from "@/components/vibe/ConversationHistory";
import { EditorPane } from "@/components/vibe/EditorPane";
import { FileTree } from "@/components/vibe/FileTree";
import { LedgerPanel } from "@/components/vibe/LedgerPanel";
import { MemoryPanel } from "@/components/vibe/MemoryPanel";
import { PreviewPanel } from "@/components/vibe/PreviewPanel";
import { ProblemsPanel } from "@/components/vibe/ProblemsPanel";
import { ScmPanel } from "@/components/vibe/ScmPanel";
import { SearchPanel } from "@/components/vibe/SearchPanel";
import { TerminalPanel } from "@/components/vibe/TerminalPanel";
import { TasksPanel } from "@/components/vibe/TasksPanel";
import { IssuesPanel } from "@/components/vibe/IssuesPanel";
import { ReviewPanel } from "@/components/vibe/CodeReview";
import { useReview } from "@/store/review";
import { AssistantMessage } from "@/components/AssistantMessage";
import { useProblems } from "@/store/problems";
import { useScm } from "@/store/scm";
import { useViberon, type BottomPanel, type SidebarView } from "@/store/viberon";
import { cx, Dot, EmptyState, IconButton } from "@/components/vibe/primitives";

const ACTIVITY_ITEMS: {
  view: SidebarView;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
}[] = [
  { view: "explorer", icon: <Files className="size-[18px]" />, label: "Explorer", shortcut: "⌘⇧E" },
  { view: "search", icon: <Search className="size-[18px]" />, label: "Search", shortcut: "⌘⇧F" },
  { view: "scm", icon: <GitBranch className="size-[18px]" />, label: "Source Control", shortcut: "⌘⇧G" },
  { view: "changes", icon: <GitCompare className="size-[18px]" />, label: "Agent Changes" },
  { view: "graph", icon: <Network className="size-[18px]" />, label: "Graph", shortcut: "⌘G" },
  { view: "memory", icon: <Brain className="size-[18px]" />, label: "Memory" },
];

/**
 * Panels are sized in pixels, so collapse optional panes as the window
 * narrows rather than squeeze the editor to nothing.
 */
const AGENT_DOCK_MIN_VIEWPORT = 1080;
const SIDEBAR_MIN_VIEWPORT = 760;
const EDITOR_MIN_WIDTH = 260;

function useResponsiveLayout(): { wide: boolean; roomy: boolean } {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1600 : window.innerWidth,
  );
  useEffect(() => {
    function onResize() {
      setWidth(window.innerWidth);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return { wide: width >= AGENT_DOCK_MIN_VIEWPORT, roomy: width >= SIDEBAR_MIN_VIEWPORT };
}

export function IdeShell() {
  const sidebarOpen = useViberon((s) => s.sidebarOpen);
  const sidebarView = useViberon((s) => s.sidebarView);
  const bottomPanel = useViberon((s) => s.bottomPanel);
  const previewOpen = useViberon((s) => s.previewOpen);
  const previewUrl = useViberon((s) => s.previewUrl);
  const agentDockOpen = useViberon((s) => s.agentDockOpen);

  const [sidebarWidth, setSidebarWidth] = useState(250);
  const [agentWidth, setAgentWidth] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < 1280 ? 330 : 380,
  );
  const [bottomHeight, setBottomHeight] = useState(220);

  const { wide, roomy } = useResponsiveLayout();
  const showPreview = previewOpen && Boolean(previewUrl);
  const showAgentDock = agentDockOpen && wide && !showPreview;
  const showSidebar = sidebarOpen && roomy;

  return (
    <div className="flex h-full min-h-0">
      <ActivityBar />

      {showSidebar && (
        <>
          <aside className="flex shrink-0 flex-col" style={{ width: sidebarWidth, background: "var(--vb-bg-void)" }}>
            <SidebarBody view={sidebarView} />
          </aside>
          <Divider orientation="vertical" value={sidebarWidth} min={200} max={460} onChange={setSidebarWidth} />
        </>
      )}

      <main className="flex flex-1 flex-col" style={{ minWidth: EDITOR_MIN_WIDTH }}>
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1">
            <EditorPane />
          </div>
          {showPreview && (
            <div className="w-[46%] min-w-[300px] shrink-0 border-l" style={{ borderColor: "var(--vb-line)" }}>
              <PreviewPanel />
            </div>
          )}
        </div>

        {bottomPanel && (
          <>
            <Divider orientation="horizontal" value={bottomHeight} min={120} max={620} onChange={setBottomHeight} />
            <div className="flex shrink-0 flex-col" style={{ height: bottomHeight, background: "var(--vb-bg-base)" }}>
              <BottomTabs current={bottomPanel} />
              <div className="min-h-0 flex-1">
                {bottomPanel === "terminal" ? (
                  <TerminalPanel />
                ) : bottomPanel === "problems" ? (
                  <ProblemsPanel />
                ) : bottomPanel === "tasks" ? (
                  <TasksPanel />
                ) : bottomPanel === "issues" ? (
                  <IssuesPanel />
                ) : bottomPanel === "review" ? (
                  <ReviewPanel />
                ) : (
                  <LedgerPanel />
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {showAgentDock && (
        <>
          <Divider orientation="vertical" reversed value={agentWidth} min={300} max={640} onChange={setAgentWidth} />
          <aside className="flex shrink-0 flex-col" style={{ width: agentWidth, background: "var(--vb-bg-base)" }}>
            <AgentDock />
          </aside>
        </>
      )}
    </div>
  );
}

/** VS Code-style panel tabs: Problems / Terminal / Tokens. */
function BottomTabs({ current }: { current: Exclude<BottomPanel, null> }) {
  const problems = useProblems((s) => s.problems.length);
  const reviewCount = useReview((s) => (s.pr ? (s.pr.review?.findings.length ?? 0) : (s.review?.findings.length ?? 0)));
  const tabs: { id: Exclude<BottomPanel, null>; label: string; count?: number }[] = [
    { id: "problems", label: "Problems", count: problems },
    { id: "terminal", label: "Terminal" },
    { id: "tasks", label: "Tasks" },
    { id: "issues", label: "Issues" },
    { id: "review", label: "Review", count: reviewCount },
    { id: "ledger", label: "Usage" },
  ];
  return (
    <div className="flex h-[30px] shrink-0 items-stretch gap-4 border-b px-3" style={{ borderColor: "var(--vb-line)" }}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => useViberon.getState().setBottomPanel(tab.id)}
          className="relative flex items-center gap-1.5 text-[11px] uppercase tracking-[0.04em]"
          style={{ color: tab.id === current ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && (
            <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-dim)" }}>
              {tab.count}
            </span>
          )}
          {tab.id === current && (
            <span className="absolute inset-x-0 bottom-0 h-px" style={{ background: "var(--vb-text-hi)" }} />
          )}
        </button>
      ))}
      <div className="flex-1" />
      <span className="flex items-center">
        <IconButton title="Close panel" onClick={() => useViberon.getState().setBottomPanel(null)}>
          <X className="size-3.5" />
        </IconButton>
      </span>
    </div>
  );
}

/* --------------------------- activity bar -------------------------------- */

function ActivityBar() {
  const sidebarView = useViberon((s) => s.sidebarView);
  const sidebarOpen = useViberon((s) => s.sidebarOpen);
  const run = useViberon((s) => s.run);
  const scmCount = useScm((s) => s.snapshot?.status?.files.length ?? 0);

  const changeCount = new Set(run?.changes.map((c) => c.path) ?? []).size;

  function select(view: SidebarView) {
    const store = useViberon.getState();
    if (view === "graph") {
      store.openGraphTab();
      return;
    }
    // Clicking the active icon collapses the sidebar, like VS Code.
    if (store.sidebarView === view && store.sidebarOpen) {
      store.setSidebarOpen(false);
    } else {
      store.setSidebarView(view);
    }
  }

  return (
    <nav
      // Extra bottom padding keeps the settings icon clear of overlays that
      // dock to the bottom-left corner (the Next.js dev indicator, browser
      // status bubbles) which would otherwise sit on top of it.
      className="flex w-11 shrink-0 flex-col items-center border-r pb-10 pt-1"
      style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}
      aria-label="Views"
    >
      {ACTIVITY_ITEMS.map((item) => (
        <ActivityIcon
          key={item.view}
          active={sidebarOpen && sidebarView === item.view}
          onClick={() => select(item.view)}
          label={item.label}
          shortcut={item.shortcut}
          badge={
            item.view === "changes" && changeCount > 0
              ? changeCount
              : item.view === "scm" && scmCount > 0
                ? scmCount
                : undefined
          }
        >
          {item.icon}
        </ActivityIcon>
      ))}

      <div className="flex-1" />

      <ActivityIcon
        active={false}
        onClick={() => useViberon.getState().openSettingsTab()}
        label="Settings"
        shortcut="⌘,"
      >
        <SettingsIcon className="size-[18px]" />
      </ActivityIcon>
    </nav>
  );
}

function ActivityIcon({
  active,
  onClick,
  label,
  shortcut,
  badge,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  shortcut?: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      className="relative flex h-10 w-11 items-center justify-center hover:text-[var(--vb-text-hi)]"
      style={{ color: active ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
    >
      {active && (
        <span className="absolute inset-y-0 left-0 w-[2px]" style={{ background: "var(--vb-text-hi)" }} />
      )}
      {children}
      {badge !== undefined && (
        <span
          className="absolute bottom-1.5 right-1.5 flex h-[14px] min-w-[14px] items-center justify-center rounded-[3px] px-[3px] font-mono text-[9.5px]"
          style={{ background: "var(--vb-accent)", color: "var(--vb-accent-fg)" }}
        >
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function SidebarBody({ view }: { view: SidebarView }) {
  switch (view) {
    case "search":
      return <SearchPanel />;
    case "scm":
      return <ScmPanel />;
    case "changes":
      return <ChangesPanel />;
    case "memory":
      return <MemoryPanel />;
    case "explorer":
    case "graph":
    default:
      return <FileTree />;
  }
}

/* ----------------------------- agent dock -------------------------------- */

/** The run stream, docked beside the editor with its own composer. */
function AgentDock() {
  const run = useViberon((s) => s.run);
  const streaming = useViberon((s) => s.streaming);
  const messages = useViberon((s) => s.messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      const target = scrollRef.current;
      if (!target) return;
      pinnedRef.current =
        target.scrollHeight - target.scrollTop - target.clientHeight < 80;
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [run, messages]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className="flex h-[30px] shrink-0 items-center gap-1.5 border-b pl-1.5 pr-1.5"
        style={{ borderColor: "var(--vb-line)" }}
      >
        <ConversationHistory compact align="right" />
        {streaming && <Dot color="var(--vb-accent)" live size={5} />}
        <div className="flex-1" />
        <IconButton
          title={streaming ? "Stop the current run first" : "New chat"}
          disabled={streaming || messages.length === 0}
          onClick={() => useViberon.getState().newConversation()}
        >
          <Plus className="size-3.5" />
        </IconButton>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {!run ? (
          <EmptyState
            title="No run yet"
            body="Describe a change below. Tool calls, approvals and edited files show here as they happen."
          />
        ) : (
          <div className="flex flex-col gap-2.5">
            <div
              className="whitespace-pre-wrap rounded-[4px] border px-2.5 py-1.5 text-[12.5px] leading-relaxed"
              style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-raised)", color: "var(--vb-text-hi)" }}
            >
              {run.prompt}
            </div>
            <AgentRunView run={run} />
            {lastAssistant?.content.trim() && (!streaming || run.intent === "ask") && (
              <AssistantMessage content={lastAssistant.content} />
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 p-2">
        <Composer />
      </div>
    </div>
  );
}

/* ------------------------------ divider ---------------------------------- */

/**
 * Drag handle between panes. Pointer capture keeps the drag alive even when
 * the cursor crosses the iframe in the preview pane, which would otherwise
 * swallow the pointer events.
 */
function Divider({
  orientation,
  value,
  min = 0,
  max = 9999,
  reversed = false,
  onChange,
}: {
  orientation: "vertical" | "horizontal";
  value: number;
  min?: number;
  max?: number;
  reversed?: boolean;
  onChange: (value: number) => void;
}) {
  const dragging = useRef(false);
  const start = useRef({ pos: 0, value: 0 });

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    start.current = {
      pos: orientation === "vertical" ? event.clientX : event.clientY,
      value,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragging.current) return;
    const current = orientation === "vertical" ? event.clientX : event.clientY;
    let delta = current - start.current.pos;
    // Panels anchored to the right/bottom grow as the pointer moves the
    // other way.
    if (reversed || orientation === "horizontal") delta = -delta;
    onChange(Math.max(min, Math.min(max, start.current.value + delta)));
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    dragging.current = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={cx(
        "group relative shrink-0 transition-colors",
        orientation === "vertical"
          ? "w-px cursor-col-resize"
          : "h-px cursor-row-resize",
      )}
      style={{ background: "var(--vb-line)" }}
    >
      <span
        className={cx(
          "absolute opacity-0 transition-opacity group-hover:opacity-100",
          orientation === "vertical"
            ? "-inset-x-[3px] inset-y-0"
            : "-inset-y-[3px] inset-x-0",
        )}
        style={{ background: "var(--vb-accent)" }}
      />
    </div>
  );
}

export default IdeShell;

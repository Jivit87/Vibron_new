"use client";

/**
 * The application shell: title bar, status bar, palette and the global
 * keyboard map. The mode toggle swaps Chat and IDE without unmounting
 * shared state, so switching mid-run is instant and lossless.
 */

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  FolderOpen,
  GitBranch,
  Monitor,
  PanelRight,
  SquarePlus,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { ChatShell } from "@/components/vibe/ChatShell";
import { CloneDialog } from "@/components/vibe/CloneDialog";
import { takePendingFix } from "@/lib/client/clone";
import { CommandPalette } from "@/components/vibe/CommandPalette";
import { IdeShell } from "@/components/vibe/IdeShell";
import { refreshWorkspace } from "@/lib/client/agent-stream";
import { fixAllIssuesInOnePr, takePendingIssueBatch } from "@/lib/client/issues";
import { isMockMode } from "@/lib/client/mock-run";
import { openFolderDialog, recordWorkspace } from "@/lib/client/recent-workspaces";
import type { Graph } from "@/lib/graph";
import { useProblems } from "@/store/problems";
import { useScm } from "@/store/scm";
import { resolveTheme, useViberon } from "@/store/viberon";
import { cx, Dot, formatCost, formatTokens, Kbd, MenuItem, Popover, Segmented } from "@/components/vibe/primitives";

export interface AppShellProps {
  repoKey: string;
  repoLabel: string;
  repoRef?: string;
  rootPath?: string;
  graph: Graph | null;
}

export function AppShell({ repoKey, repoLabel, repoRef, rootPath, graph }: AppShellProps) {
  const appMode = useViberon((s) => s.appMode);
  const theme = useViberon((s) => s.settings.theme);
  const settingsHydrated = useViberon((s) => s.settingsHydrated);

  useEffect(() => {
    useViberon.getState().hydrateSettings();
  }, []);

  // Theme: the inline script in layout.tsx sets it before paint; this keeps
  // it in sync with the setting (and with the OS for "system"). Until saved
  // settings are read, `theme` is only the default, so leave the page alone.
  useEffect(() => {
    if (!settingsHydrated) return;
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme, settingsHydrated]);

  // Bind this workspace into the store, then pull files, memory, models,
  // git and problems. Git/problems 404 gracefully on servers without them.
  useEffect(() => {
    const store = useViberon.getState();
    store.init({ repoKey, repoLabel, rootPath });
    if (graph) store.setGraph(graph);
    recordWorkspace({ repoKey, label: repoLabel, rootPath });
    // Arrived here from "Clone and fix": hand the issue to the composer.
    const pendingIssue = takePendingFix(repoKey);
    if (pendingIssue) {
      // Stay in the current shell; in the IDE the draft goes to the agent dock.
      if (store.appMode === "ide") store.setAgentDockOpen(true);
      store.setComposerDraft({ text: "", interaction: "fix", issue: pendingIssue });
    }
    const pendingBatch = takePendingIssueBatch(repoKey);
    if (pendingBatch) void fixAllIssuesInOnePr(repoKey, pendingBatch.model, pendingBatch.prompt).then((error) => {
      if (error) toast.error(error);
    });
    void refreshWorkspace();
    useScm.getState().reset();
    void useScm.getState().refresh(repoKey);
    void useProblems.getState().load(repoKey);

    void fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { anyConfigured?: boolean } | null) => {
        if (!body) return;
        useViberon.getState().setProvidersConfigured(body.anyConfigured !== false);
        if (body.anyConfigured === false && !isMockMode()) {
          useViberon.getState().openSettingsTab();
          toast.info("Add an API key to start.", { duration: 6000 });
        }
      })
      .catch(() => {});
  }, [repoKey, repoLabel, rootPath, graph]);

  // Refresh git state when the window regains focus (external commits).
  useEffect(() => {
    const onFocus = () => void useScm.getState().refresh(useViberon.getState().repoKey);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Global keyboard map.
  useEffect(() => {
    function typing(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return true;
      if (target.isContentEditable) return true;
      return Boolean(target.closest(".monaco-editor"));
    }

    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      const store = useViberon.getState();

      if (mod && event.key.toLowerCase() === "k" && !event.shiftKey) {
        event.preventDefault();
        store.setPaletteOpen(!store.paletteOpen);
        return;
      }
      if (event.key === "Escape" && store.paletteOpen) {
        store.setPaletteOpen(false);
        return;
      }
      if (!mod) return;

      const key = event.key.toLowerCase();

      if (event.shiftKey && key === "m") {
        event.preventDefault();
        store.toggleAppMode();
        return;
      }
      if (key === "p" && !event.shiftKey) {
        event.preventDefault();
        store.setPaletteOpen(true);
        return;
      }
      if (event.shiftKey && key === "f") {
        event.preventDefault();
        store.setAppMode("ide");
        store.setSidebarView("search");
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("viberon:focusSearch")));
        return;
      }
      if (event.shiftKey && key === "g") {
        event.preventDefault();
        store.setAppMode("ide");
        store.setSidebarView("scm");
        return;
      }
      if (event.shiftKey && key === "e") {
        event.preventDefault();
        store.setAppMode("ide");
        store.setSidebarView("explorer");
        return;
      }
      if (event.shiftKey && key === "u") {
        event.preventDefault();
        store.setAppMode("ide");
        store.setBottomPanel(store.bottomPanel === "problems" ? null : "problems");
        return;
      }
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        store.toggleSidebar();
        return;
      }
      if (event.key === "`") {
        event.preventDefault();
        store.setAppMode("ide");
        store.setBottomPanel(store.bottomPanel === "terminal" ? null : "terminal");
        return;
      }
      if (key === "g" && !event.shiftKey) {
        event.preventDefault();
        store.setAppMode("ide");
        store.openGraphTab();
        return;
      }
      if (event.key === ",") {
        event.preventDefault();
        store.openSettingsTab();
        return;
      }
      if (key === "w" && !event.shiftKey && store.appMode === "ide" && store.activeTabPath) {
        event.preventDefault();
        store.closeTab(store.activeTabPath);
        return;
      }
      if (key === "i" && !typing(event.target)) {
        event.preventDefault();
        store.setAppMode("chat");
        requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("viberon:focusComposer")));
      }
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="flex h-screen w-full flex-col overflow-hidden"
      style={{ background: "var(--vb-bg-base)", color: "var(--vb-text)" }}
    >
      <TitleBar repoLabel={repoLabel} repoRef={repoRef} rootPath={rootPath} />
      <div className="min-h-0 flex-1">{appMode === "chat" ? <ChatShell /> : <IdeShell />}</div>
      <StatusBar />
      <CommandPalette />
      <CloneDialog />
    </div>
  );
}

/* ----------------------------- title bar --------------------------------- */

function TitleBar({
  repoLabel,
  repoRef,
  rootPath,
}: {
  repoLabel: string;
  repoRef?: string;
  rootPath?: string;
}) {
  const appMode = useViberon((s) => s.appMode);
  const setAppMode = useViberon((s) => s.setAppMode);
  const previewUrl = useViberon((s) => s.previewUrl);
  const previewOpen = useViberon((s) => s.previewOpen);
  const bottomPanel = useViberon((s) => s.bottomPanel);
  const agentDockOpen = useViberon((s) => s.agentDockOpen);

  // Only known after mount: reading `window.electronAPI` during render
  // would mismatch the server HTML.
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    setIsDesktop(Boolean(window.electronAPI?.newWindow));
  }, []);

  return (
    <header
      className="flex h-[34px] shrink-0 items-center gap-2 border-b pl-3 pr-2"
      style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}
    >
      <span className="text-[12.5px] font-medium" style={{ color: "var(--vb-text-hi)" }}>
        {repoLabel}
      </span>
      {(rootPath || repoRef) && (
        <span
          className="hidden min-w-0 truncate font-mono text-[11px] lg:inline"
          style={{ color: "var(--vb-text-faint)" }}
          title={rootPath ?? repoRef}
        >
          {rootPath ?? repoRef}
        </span>
      )}

      <div className="flex-1" />

      <Segmented
        value={appMode}
        options={[
          { value: "chat", label: "Chat", title: "Chat mode (⌘⇧M)" },
          { value: "ide", label: "IDE", title: "IDE mode (⌘⇧M)" },
        ]}
        onChange={setAppMode}
      />

      <div className="flex items-center">
        {appMode === "ide" && (
          <ChromeButton
            title={agentDockOpen ? "Hide agent panel" : "Show agent panel"}
            active={agentDockOpen}
            onClick={() => useViberon.getState().toggleAgentDock()}
          >
            <PanelRight className="size-3.5" />
          </ChromeButton>
        )}
        {previewUrl && (
          <ChromeButton
            title={`Preview ${previewUrl}`}
            active={previewOpen}
            onClick={() => {
              useViberon.getState().setAppMode("ide");
              useViberon.getState().setPreviewOpen(!previewOpen);
            }}
          >
            <Monitor className="size-3.5" />
          </ChromeButton>
        )}
        <ChromeButton
          title="Terminal (⌘`)"
          active={bottomPanel === "terminal"}
          onClick={() => {
            const store = useViberon.getState();
            store.setAppMode("ide");
            store.setBottomPanel(bottomPanel === "terminal" ? null : "terminal");
          }}
        >
          <TerminalSquare className="size-3.5" />
        </ChromeButton>
        <Popover
          label=""
          icon={<FolderOpen className="size-3.5" />}
          title="Open or clone"
          placement="bottom"
          align="right"
          chevron={false}
          width={220}
        >
          {(close) => (
            <>
              <MenuItem
                active={false}
                title="Open folder…"
                onClick={() => {
                  close();
                  void openFolderDialog().then((r) => {
                    if (!r.ok && r.error) toast.error(r.error);
                  });
                }}
              />
              <MenuItem
                active={false}
                title="Clone repository…"
                hint="Git URL, owner/repo, or issue URL"
                onClick={() => {
                  close();
                  useViberon.getState().setCloneOpen(true);
                }}
              />
            </>
          )}
        </Popover>
        {isDesktop && (
          <ChromeButton title="New window" onClick={() => void window.electronAPI?.newWindow?.()}>
            <SquarePlus className="size-3.5" />
          </ChromeButton>
        )}
      </div>

      <button
        type="button"
        onClick={() => useViberon.getState().setPaletteOpen(true)}
        className="hidden h-[22px] items-center gap-2 rounded-[3px] border pl-2 pr-1 text-[11.5px] hover:bg-[var(--vb-hover)] sm:flex"
        style={{ borderColor: "var(--vb-line)", color: "var(--vb-text-dim)" }}
      >
        Commands
        <Kbd>⌘K</Kbd>
      </button>
    </header>
  );
}

function ChromeButton({
  title,
  active = false,
  onClick,
  children,
}: {
  title: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cx(
        "inline-flex size-[26px] items-center justify-center rounded-[3px] hover:bg-[var(--vb-hover)]",
        active && "bg-[var(--vb-active)]",
      )}
      style={{ color: active ? "var(--vb-text-hi)" : "var(--vb-text-dim)" }}
    >
      {children}
    </button>
  );
}

/* ----------------------------- status bar -------------------------------- */

function StatusBar() {
  const run = useViberon((s) => s.run);
  const streaming = useViberon((s) => s.streaming);
  const fileList = useViberon((s) => s.fileList);
  const settings = useViberon((s) => s.settings);
  const providersConfigured = useViberon((s) => s.providersConfigured);
  const snapshot = useScm((s) => s.snapshot);
  const checked = useProblems((s) => s.problems);
  const diagnostics = useProblems((s) => s.diagnostics);
  const problems = [...checked, ...Object.values(diagnostics).flat()];

  const branch = snapshot?.status?.branch;
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;
  const activeAgents = run?.agents.filter((a) => a.status === "running").length ?? 0;
  const pendingApprovals = run?.approvals.filter((a) => !a.resolution).length ?? 0;

  const openScm = () => {
    const store = useViberon.getState();
    store.setAppMode("ide");
    store.setSidebarView("scm");
  };

  return (
    <footer
      className="flex h-[22px] shrink-0 items-center border-t px-1 text-[11.5px]"
      style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)", color: "var(--vb-text-dim)" }}
    >
      {branch && (
        <StatusItem onClick={openScm} title={`${branch.head ?? "detached"}${branch.upstream ? ` → ${branch.upstream}` : ""}`}>
          <GitBranch className="size-3" />
          <span className="max-w-[160px] truncate">{branch.head ?? branch.oid ?? "detached"}</span>
          {(branch.ahead > 0 || branch.behind > 0) && (
            <span className="flex items-center gap-0.5 font-mono text-[11px]">
              {branch.behind > 0 && (
                <>
                  <ArrowDown className="size-2.5" />
                  {branch.behind}
                </>
              )}
              {branch.ahead > 0 && (
                <>
                  <ArrowUp className="size-2.5" />
                  {branch.ahead}
                </>
              )}
            </span>
          )}
        </StatusItem>
      )}

      <StatusItem
        title="Problems (⌘⇧U)"
        onClick={() => {
          const store = useViberon.getState();
          store.setAppMode("ide");
          store.setBottomPanel(store.bottomPanel === "problems" ? null : "problems");
        }}
      >
        <CircleAlert className="size-3" />
        <span className="font-mono">{errors}</span>
        <TriangleAlert className="size-3" />
        <span className="font-mono">{warnings}</span>
      </StatusItem>

      {!providersConfigured ? (
        <StatusItem onClick={() => useViberon.getState().openSettingsTab()} title="Open settings">
          <span style={{ color: "var(--vb-amber)" }}>No API key</span>
        </StatusItem>
      ) : streaming ? (
        <StatusItem title="Run in progress">
          <Dot color="var(--vb-accent)" live size={5} />
          {pendingApprovals > 0
            ? `${pendingApprovals} waiting for approval`
            : activeAgents > 1
              ? `${activeAgents} agents working`
              : "Agent working"}
        </StatusItem>
      ) : null}

      <div className="flex-1" />

      {run && run.tokensIn > 0 && (
        <StatusItem
          title="Token ledger"
          onClick={() => {
            const store = useViberon.getState();
            store.setAppMode("ide");
            store.setBottomPanel("ledger");
          }}
        >
          <span className="font-mono">
            {formatTokens(run.tokensIn)} in · {formatTokens(run.tokensOut)} out · {formatCost(run.costUsd)}
          </span>
        </StatusItem>
      )}
      <StatusItem title={`${fileList.length} files indexed`}>
        <span className="font-mono">{fileList.length} files</span>
      </StatusItem>
      <StatusItem title="Model" onClick={() => useViberon.getState().openSettingsTab()}>
        {settings.model === "auto" ? "Auto model" : settings.model}
      </StatusItem>
    </footer>
  );
}

function StatusItem({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const className = "flex h-full items-center gap-1 px-1.5 whitespace-nowrap";
  if (!onClick) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  }
  return (
    <button type="button" onClick={onClick} title={title} className={cx(className, "hover:bg-[var(--vb-hover)]")}>
      {children}
    </button>
  );
}

export default AppShell;

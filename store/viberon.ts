import { create } from "zustand";

import type { Graph } from "@/lib/graph";
import type { OrchestrationEvent, PlanStep, RunPlan } from "@/lib/agents/events";
import type { Interaction } from "@/lib/harness/contracts";
import {
  closeTabsState,
  moveTab as moveTabInList,
  openTabState,
  pinTabState,
} from "@/lib/editor/tabs";
import type { ReviewDecision } from "@/lib/editor/review";
import {
  createRun,
  reduceRun,
  type ApprovalResolution,
  type RunState,
} from "@/lib/client/run-reducer";
import { isMockMode } from "@/lib/client/mock-run";
import type { LedgerSnapshot } from "@/lib/context/ledger";
import type { ProjectMemory } from "@/lib/memory/types";
import {
  createConversationMeta,
  deleteConversation as deleteStoredConversation,
  loadConversation,
  loadIndex,
  migrateLegacyThread,
  renameConversation as renameStoredConversation,
  saveConversation,
  type ConversationMeta,
  type StoredRun,
} from "@/lib/client/conversations";

/* ============================================================================
 * Viberon application state.
 *
 * One store for the whole app. The two shells (Chat and IDE) render different
 * views over the *same* state, which is what makes the mode toggle instant
 * and lossless — nothing is unmounted-and-refetched when you switch.
 * ========================================================================= */

/* ------------------------------- chat ----------------------------------- */

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  at: number;
  /** Set on assistant messages once the run that produced them finishes. */
  runId?: string;
}

/* ------------------------------ agents ---------------------------------- */

// Run shapes and the event reducer live in a pure module so they are
// unit-testable without the store. Re-exported here for existing imports.
export type {
  AgentLane,
  AgentStatus,
  ApprovalRequest,
  ApprovalResolution,
  FeedItem,
  FileChangeRecord,
  RunState,
  ToolCallRecord,
} from "@/lib/client/run-reducer";

/* ------------------------------ editor ---------------------------------- */

export interface EditorTab {
  path: string;
  label: string;
  source?: string | null;
  /** Local edits not yet persisted. */
  dirty?: boolean;
  /** Single-click preview tab: italic, replaced by the next preview open. */
  preview?: boolean;
}

export const WELCOME_TAB_PATH = "__welcome__";
export const GRAPH_TAB_PATH = "__graph__";
export const SETTINGS_TAB_PATH = "__settings__";
export const REVIEW_TAB_PATH = "__review__";

/** Synthetic tabs have sentinel paths and never touch the disk. */
export function isSyntheticTab(path: string): boolean {
  return path.startsWith("__");
}

/* ------------------------------ panels ---------------------------------- */

export type AppMode = "chat" | "ide";
export type SidebarView =
  | "explorer"
  | "search"
  | "scm"
  | "graph"
  | "changes"
  | "memory";
export type BottomPanel = "terminal" | "problems" | "ledger" | "tasks" | "issues" | "review" | null;

export interface TerminalSessionView {
  id: string;
  command: string;
  status: string;
  exitCode: number | null;
  output: string;
  detectedUrl: string | null;
  startedAt: number;
  /** Who started it. Absent from older servers; treat as "user". */
  origin?: "user" | "agent";
  runId?: string;
  /** Byte offset of the last streamed chunk, for `since=` resume. */
  offset?: number;
}

/* ----------------------------- settings --------------------------------- */

export type AgentMode = "auto" | "single" | "orchestrated";
export type CommandPolicy = "auto" | "ask" | "never";
export type EditPolicy = "auto" | "ask";
export type ThemeSetting = "dark" | "light" | "system";
export type { Interaction };

export interface AppSettings {
  /** Model id, or "auto" to let the server pick the best available. */
  model: string;
  agentMode: AgentMode;
  commandPolicy: CommandPolicy;
  /** Max specialists running at once. */
  concurrency: number;
  /** Show the model's reasoning summary in the trace. */
  showThinking: boolean;
  /** Retrieval knobs, passed through to the graph engine. */
  retrievalDepth: number;
  maxNodes: number;
  /** Auto-open the preview pane when a dev server URL is detected. */
  autoPreview: boolean;
  /** Snapshot the workspace before every run. */
  autoCheckpoint: boolean;
  editorFontSize: number;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  /** Agent (build), Plan (plan first, then approve), or Ask (read-only). */
  interaction: Interaction;
  /** Whether agent file edits need approval. */
  editPolicy: EditPolicy;
  theme: ThemeSetting;
}

export const DEFAULT_SETTINGS: AppSettings = {
  model: "auto",
  agentMode: "auto",
  commandPolicy: "ask",
  concurrency: 3,
  showThinking: true,
  retrievalDepth: 2,
  maxNodes: 30,
  autoPreview: true,
  autoCheckpoint: true,
  editorFontSize: 13,
  editorWordWrap: false,
  editorMinimap: true,
  interaction: "agent",
  editPolicy: "auto",
  theme: "dark",
};

const SETTINGS_KEY = "viberon.settings.v2";

function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return clampSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function clampSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    concurrency: Math.max(1, Math.min(6, Math.round(settings.concurrency))),
    retrievalDepth: Math.max(1, Math.min(4, Math.round(settings.retrievalDepth))),
    maxNodes: Math.max(5, Math.min(60, Math.round(settings.maxNodes))),
    editorFontSize: Math.max(10, Math.min(22, Math.round(settings.editorFontSize))),
    interaction: ["agent", "plan", "ask", "fix"].includes(settings.interaction)
      ? settings.interaction
      : "agent",
    editPolicy: settings.editPolicy === "ask" ? "ask" : "auto",
    theme: ["dark", "light", "system"].includes(settings.theme) ? settings.theme : "dark",
  };
}

function persistSettings(settings: AppSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode / quota — settings simply do not persist this session.
  }
}

const APP_MODE_KEY = "viberon.appMode";

/** The last shell the user chose, so a reload or a new workspace opens in it. */
function loadAppMode(): AppMode {
  if (typeof window === "undefined") return "chat";
  try {
    return window.localStorage.getItem(APP_MODE_KEY) === "ide" ? "ide" : "chat";
  } catch {
    return "chat";
  }
}

function persistAppMode(appMode: AppMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APP_MODE_KEY, appMode);
  } catch {
    // Private mode / quota: the mode just does not survive a reload.
  }
}

/* ------------------------------- store ----------------------------------- */

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter}`;
}

function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] || path;
}

/**
 * The index entry for the thread currently open.
 *
 * Reuses the stored meta when there is one so `createdAt` and a user-set
 * title survive; synthesizes a fresh entry for a thread that has never been
 * saved. The save path re-derives title/preview, so only identity matters.
 */
function currentMeta(state: ViberonState): ConversationMeta {
  const existing = state.conversations.find((c) => c.id === state.conversationId);
  if (existing) return existing;
  return {
    ...createConversationMeta(),
    id: state.conversationId || createConversationMeta().id,
  };
}

/** Compact a finished run into the durable receipt kept with the thread. */
function toStoredRun(run: RunState, messageId?: string): StoredRun {
  return {
    id: run.id,
    prompt: run.prompt,
    intent: run.intent,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    // Deduplicated: an agent editing one file five times is one changed file.
    filesChanged: [...new Set(run.changes.map((c) => c.path))],
    agentCount: run.agents.length,
    costUsd: run.costUsd,
    tokensIn: run.tokensIn,
    tokensOut: run.tokensOut,
    checkpointId: run.checkpointId,
    messageId,
  };
}

export interface IssueRef {
  title: string;
  body: string;
  url: string;
}

export interface ComposerDraft {
  text: string;
  interaction?: Interaction;
  issue?: IssueRef;
}

export interface ViberonState {
  /* identity */
  repoKey: string;
  repoLabel: string;
  rootPath?: string;

  /* shell */
  appMode: AppMode;
  sidebarView: SidebarView;
  sidebarOpen: boolean;
  bottomPanel: BottomPanel;
  paletteOpen: boolean;
  /** "Clone repository" dialog. */
  cloneOpen: boolean;
  /**
   * Text (and an expanded issue) for the composer to pick up, e.g. after a
   * clone that came from an issue URL. The composer clears it once read.
   */
  composerDraft: ComposerDraft | null;
  previewUrl: string | null;
  previewOpen: boolean;
  /** Right-hand agent stream. Auto-collapses on narrow viewports. */
  agentDockOpen: boolean;

  /* graph + files */
  graph?: Graph;
  fileList: string[];
  selectedNodeId?: string;
  pulseIds: string[];
  expandedFolders: Set<string>;

  /* editor */
  tabs: EditorTab[];
  activeTabPath: string | null;

  /* chat + agents */
  messages: ChatMessage[];
  run: RunState | null;
  /** Finished runs, newest first. Bounded. */
  runHistory: RunState[];
  streaming: boolean;

  /* conversations */
  /** Active thread. Messages above belong to this conversation. */
  conversationId: string;
  /** Every thread in this workspace, newest first. Titles only. */
  conversations: ConversationMeta[];
  /** Durable receipts for runs in the active conversation. */
  conversationRuns: StoredRun[];

  /* terminal */
  terminals: TerminalSessionView[];
  activeTerminalId: string | null;

  /* memory */
  memory: ProjectMemory | null;

  /* config */
  settings: AppSettings;
  providersConfigured: boolean;

  /* review: decision per `${runId}::${path}` */
  reviewDecisions: Record<string, ReviewDecision>;

  /* ---- actions ---- */
  init: (input: { repoKey: string; repoLabel: string; rootPath?: string }) => void;
  setGraph: (graph: Graph) => void;
  setFileList: (paths: string[]) => void;
  selectNode: (id: string | undefined) => void;
  pulse: (ids: string[]) => void;
  toggleFolder: (path: string) => void;
  setExpandedFolders: (folders: Set<string>) => void;

  setAppMode: (mode: AppMode) => void;
  toggleAppMode: () => void;
  setSidebarView: (view: SidebarView) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setBottomPanel: (panel: BottomPanel) => void;
  setPaletteOpen: (open: boolean) => void;
  setCloneOpen: (open: boolean) => void;
  setComposerDraft: (draft: ComposerDraft | null) => void;
  setPreviewUrl: (url: string | null) => void;
  setPreviewOpen: (open: boolean) => void;
  setAgentDockOpen: (open: boolean) => void;
  toggleAgentDock: () => void;

  openTab: (
    path: string,
    source?: string | null,
    options?: { preview?: boolean; activate?: boolean; label?: string },
  ) => void;
  pinTab: (path: string) => void;
  updateTabSource: (path: string, source: string | null, dirty?: boolean) => void;
  closeTab: (path: string) => void;
  closeTabs: (paths: string[]) => void;
  moveTab: (from: number, to: number) => void;
  activateTab: (path: string) => void;
  openWelcomeTab: () => void;
  openGraphTab: () => void;
  openSettingsTab: () => void;
  openReviewTab: () => void;

  appendMessage: (role: ChatRole, content: string) => string;
  appendToLastAssistant: (chunk: string) => void;
  setMessages: (messages: ChatMessage[]) => void;
  clearConversation: () => void;

  /** Load this workspace's threads and open the most recent (or a new one). */
  hydrateConversations: (repoKey: string) => void;
  /** Start an empty thread, saving the current one first. */
  newConversation: () => void;
  /** Save the current thread, then load another by id. */
  switchConversation: (id: string) => void;
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  /** Flush the active thread to storage. Safe to call often. */
  persistConversation: () => void;

  startRun: (input: {
    prompt: string;
    model: string;
    mode: AgentMode;
    interaction?: Interaction;
  }) => void;
  applyEvent: (event: OrchestrationEvent) => void;
  /** Fold a frame's worth of events in one store write (one render). */
  applyEvents: (events: readonly OrchestrationEvent[]) => void;
  endRun: (status: RunState["status"]) => void;
  markChangeReverted: (changeId: string) => void;
  dismissApproval: (approvalId: string) => void;
  resolveApproval: (approvalId: string, resolution: ApprovalResolution) => void;
  /** Replace the plan while it awaits approval (user edits). */
  updatePlan: (plan: RunPlan) => void;
  setReviewDecisions: (decisions: Record<string, ReviewDecision>) => void;

  setTerminals: (sessions: TerminalSessionView[]) => void;
  upsertTerminal: (session: TerminalSessionView) => void;
  appendTerminalOutput: (id: string, text: string, offset?: number) => void;
  setActiveTerminal: (id: string | null) => void;

  setMemory: (memory: ProjectMemory | null) => void;
  /** True once saved settings have been read after mount. */
  settingsHydrated: boolean;
  /**
   * Read saved settings from localStorage. Called after mount rather than at
   * store creation so the server render and the first client render agree.
   */
  hydrateSettings: () => void;
  setSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
  setProvidersConfigured: (configured: boolean) => void;
}

const WELCOME_TAB: EditorTab = { path: WELCOME_TAB_PATH, label: "Welcome" };
const GRAPH_TAB: EditorTab = { path: GRAPH_TAB_PATH, label: "Graph" };
const SETTINGS_TAB: EditorTab = { path: SETTINGS_TAB_PATH, label: "Settings" };
const REVIEW_TAB: EditorTab = { path: REVIEW_TAB_PATH, label: "Review changes" };

const MAX_RUN_HISTORY = 10;

export const useViberon = create<ViberonState>((set) => ({
  repoKey: "",
  repoLabel: "Workspace",
  rootPath: undefined,

  appMode: "chat",
  sidebarView: "explorer",
  sidebarOpen: true,
  bottomPanel: null,
  paletteOpen: false,
  cloneOpen: false,
  composerDraft: null,
  previewUrl: null,
  previewOpen: false,
  agentDockOpen: true,

  graph: undefined,
  fileList: [],
  selectedNodeId: undefined,
  pulseIds: [],
  expandedFolders: new Set<string>(),

  tabs: [WELCOME_TAB],
  activeTabPath: WELCOME_TAB_PATH,

  messages: [],
  run: null,
  runHistory: [],
  streaming: false,

  conversationId: "",
  conversations: [],
  conversationRuns: [],

  terminals: [],
  activeTerminalId: null,

  memory: null,

  settings: DEFAULT_SETTINGS,
  settingsHydrated: false,
  providersConfigured: true,

  reviewDecisions: {},

  /* ---------------------------- identity ---------------------------- */

  init: ({ repoKey, repoLabel, rootPath }) =>
    set({
      repoKey,
      repoLabel,
      rootPath,
      tabs: [WELCOME_TAB],
      activeTabPath: WELCOME_TAB_PATH,
      selectedNodeId: undefined,
      pulseIds: [],
      expandedFolders: new Set<string>(),
    }),

  setGraph: (graph) => set({ graph }),
  setFileList: (fileList) => set({ fileList }),
  selectNode: (selectedNodeId) => set({ selectedNodeId }),
  pulse: (pulseIds) => set({ pulseIds }),

  toggleFolder: (path) =>
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { expandedFolders: next };
    }),

  setExpandedFolders: (expandedFolders) => set({ expandedFolders }),

  /* ------------------------------ shell ----------------------------- */

  setAppMode: (appMode) => {
    persistAppMode(appMode);
    set({ appMode });
  },
  toggleAppMode: () =>
    set((state) => {
      const appMode: AppMode = state.appMode === "chat" ? "ide" : "chat";
      persistAppMode(appMode);
      return { appMode };
    }),
  setSidebarView: (sidebarView) => set({ sidebarView, sidebarOpen: true }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setBottomPanel: (bottomPanel) => set({ bottomPanel }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setCloneOpen: (cloneOpen) => set({ cloneOpen }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setPreviewUrl: (previewUrl) =>
    set((state) => ({
      previewUrl,
      previewOpen: previewUrl
        ? state.settings.autoPreview || state.previewOpen
        : false,
    })),
  setPreviewOpen: (previewOpen) => set({ previewOpen }),
  setAgentDockOpen: (agentDockOpen) => set({ agentDockOpen }),
  toggleAgentDock: () =>
    set((state) => ({ agentDockOpen: !state.agentDockOpen })),

  /* ----------------------------- editor ----------------------------- */

  openTab: (path, source, options = {}) =>
    set((state) => {
      // Re-opening an existing tab without saying otherwise keeps its
      // preview state; only an explicit pin (double-click, edit) pins it.
      const exists = state.tabs.some((t) => t.path === path);
      const preview = options.preview ?? exists;
      return openTabState(
        state,
        {
          path,
          label: options.label ?? basename(path),
          ...(source !== undefined ? { source } : {}),
        },
        { preview, activate: options.activate },
      );
    }),

  pinTab: (path) => set((state) => pinTabState(state, path)),

  updateTabSource: (path, source, dirty = false) =>
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.path === path
          ? // Editing a preview tab pins it, as in VS Code.
            { ...t, source, dirty, preview: dirty ? false : t.preview }
          : t,
      ),
    })),

  closeTab: (path) => set((state) => closeTabsState(state, [path], WELCOME_TAB)),

  closeTabs: (paths) => set((state) => closeTabsState(state, paths, WELCOME_TAB)),

  moveTab: (from, to) => set((state) => ({ tabs: moveTabInList(state.tabs, from, to) })),

  activateTab: (activeTabPath) => set({ activeTabPath }),

  openWelcomeTab: () =>
    set((state) => ({
      tabs: state.tabs.some((t) => t.path === WELCOME_TAB_PATH)
        ? state.tabs
        : [WELCOME_TAB, ...state.tabs],
      activeTabPath: WELCOME_TAB_PATH,
    })),

  openGraphTab: () => set((state) => openTabState(state, GRAPH_TAB)),

  openSettingsTab: () =>
    set((state) => {
      persistAppMode("ide");
      return { ...openTabState(state, SETTINGS_TAB), appMode: "ide" as AppMode };
    }),

  openReviewTab: () =>
    set((state) => {
      persistAppMode("ide");
      return { ...openTabState(state, REVIEW_TAB), appMode: "ide" as AppMode };
    }),

  /* ------------------------------ chat ------------------------------ */

  appendMessage: (role, content) => {
    const id = nextId("msg");
    set((state) => ({
      messages: [...state.messages, { id, role, content, at: Date.now() }],
    }));
    return id;
  },

  appendToLastAssistant: (chunk) =>
    set((state) => {
      const last = state.messages.at(-1);
      if (last?.role === "assistant") {
        const messages = state.messages.slice(0, -1);
        messages.push({ ...last, content: last.content + chunk });
        return { messages };
      }
      return {
        messages: [
          ...state.messages,
          { id: nextId("msg"), role: "assistant", content: chunk, at: Date.now() },
        ],
      };
    }),

  setMessages: (messages) => set({ messages }),

  clearConversation: () =>
    set({
      messages: [],
      run: null,
      runHistory: [],
      conversationRuns: [],
      pulseIds: [],
    }),

  /* -------------------------- conversations ------------------------- */

  hydrateConversations: (repoKey) =>
    set((state) => {
      if (!repoKey) return state;

      // One-time fold of the pre-history flat thread, so upgrading does not
      // look like the app deleted the user's chat.
      migrateLegacyThread(repoKey);

      const conversations = loadIndex(repoKey);
      const mostRecent = conversations[0];
      if (!mostRecent) {
        return {
          conversations: [],
          conversationId: createConversationMeta().id,
          conversationRuns: [],
          messages: [],
          run: null,
          runHistory: [],
        };
      }

      const record = loadConversation(repoKey, mostRecent.id);
      return {
        conversations,
        conversationId: mostRecent.id,
        messages: record?.messages ?? [],
        conversationRuns: record?.runs ?? [],
        run: null,
        runHistory: [],
      };
    }),

  newConversation: () =>
    set((state) => {
      // Persist whatever is open before walking away from it.
      if (state.repoKey && state.messages.length > 0) {
        saveConversation(state.repoKey, {
          meta: currentMeta(state),
          messages: state.messages,
          runs: state.conversationRuns,
        });
      }
      const meta = createConversationMeta();
      return {
        conversations: state.repoKey ? loadIndex(state.repoKey) : [],
        conversationId: meta.id,
        messages: [],
        conversationRuns: [],
        run: null,
        runHistory: [],
        pulseIds: [],
      };
    }),

  switchConversation: (id) =>
    set((state) => {
      if (id === state.conversationId) return state;
      if (state.repoKey && state.messages.length > 0) {
        saveConversation(state.repoKey, {
          meta: currentMeta(state),
          messages: state.messages,
          runs: state.conversationRuns,
        });
      }
      const record = state.repoKey ? loadConversation(state.repoKey, id) : null;
      return {
        conversations: state.repoKey ? loadIndex(state.repoKey) : state.conversations,
        conversationId: id,
        messages: record?.messages ?? [],
        conversationRuns: record?.runs ?? [],
        run: null,
        runHistory: [],
        pulseIds: [],
      };
    }),

  renameConversation: (id, title) =>
    set((state) => {
      if (!state.repoKey) return state;
      return {
        conversations: renameStoredConversation(state.repoKey, id, title),
      };
    }),

  deleteConversation: (id) =>
    set((state) => {
      if (!state.repoKey) return state;
      const conversations = deleteStoredConversation(state.repoKey, id);
      // Deleting the thread you are reading has to land somewhere sensible:
      // the next most recent, or a fresh empty one.
      if (id !== state.conversationId) return { conversations };

      const next = conversations[0];
      if (!next) {
        return {
          conversations,
          conversationId: createConversationMeta().id,
          messages: [],
          conversationRuns: [],
          run: null,
          runHistory: [],
        };
      }
      const record = loadConversation(state.repoKey, next.id);
      return {
        conversations,
        conversationId: next.id,
        messages: record?.messages ?? [],
        conversationRuns: record?.runs ?? [],
        run: null,
        runHistory: [],
      };
    }),

  persistConversation: () =>
    set((state) => {
      if (!state.repoKey || state.messages.length === 0) return state;
      return {
        conversations: saveConversation(state.repoKey, {
          meta: currentMeta(state),
          messages: state.messages,
          runs: state.conversationRuns,
        }),
      };
    }),

  /* ----------------------------- agents ----------------------------- */

  startRun: ({ prompt, model, mode, interaction = "agent" }) =>
    set({
      streaming: true,
      run: createRun({
        id: nextId("run"),
        prompt,
        model,
        mode:
          interaction === "plan"
            ? "plan"
            : mode === "single" || interaction === "fix"
              ? "single"
              : "orchestrated",
        now: Date.now(),
        interaction,
      }),
    }),

  applyEvent: (event) =>
    set((state) => {
      if (!state.run) return state;
      const run = reduceRun(state.run, event, { now: Date.now(), nextId });
      if (event.type !== "file_change") return { run };
      // Mirror into any open tab so the editor shows the change live.
      const tabs = state.tabs.map((tab) =>
        tab.path === event.path ? { ...tab, source: event.after, dirty: false } : tab,
      );
      return { run, tabs };
    }),

  applyEvents: (events) =>
    set((state) => {
      if (!state.run || events.length === 0) return state;
      const now = Date.now();
      let run = state.run;
      const written = new Map<string, string | null>();
      for (const event of events) {
        run = reduceRun(run, event, { now, nextId });
        if (event.type === "file_change") written.set(event.path, event.after);
      }
      if (written.size === 0) return { run };
      const tabs = state.tabs.map((tab) =>
        written.has(tab.path) ? { ...tab, source: written.get(tab.path) ?? null, dirty: false } : tab,
      );
      return { run, tabs };
    }),

  endRun: (status) =>
    set((state) => {
      if (!state.run) return { streaming: false };
      const finished: RunState = {
        ...state.run,
        // The server's `run_done.status` wins over the transport's guess.
        status:
          state.run.status === "failed" || state.run.status === "cancelled"
            ? state.run.status
            : state.run.status === "done"
              ? "done"
              : status,
        endedAt: state.run.endedAt ?? Date.now(),
      };

      // Tie the run to the assistant message it produced so the history and
      // changes panels can scroll straight to the reply it belongs to.
      const lastAssistant = [...state.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const messages = lastAssistant
        ? state.messages.map((m) =>
            m.id === lastAssistant.id ? { ...m, runId: finished.id } : m,
          )
        : state.messages;

      const conversationRuns = [
        ...state.conversationRuns,
        toStoredRun(finished, lastAssistant?.id),
      ];

      // Persist immediately: a finished run is exactly the moment a user
      // might close the window, and losing it would lose the thread.
      const conversations = state.repoKey
        ? saveConversation(state.repoKey, {
            meta: currentMeta(state),
            messages,
            runs: conversationRuns,
          })
        : state.conversations;

      return {
        streaming: false,
        run: finished,
        messages,
        conversationRuns,
        conversations,
        runHistory: [finished, ...state.runHistory].slice(0, MAX_RUN_HISTORY),
      };
    }),

  markChangeReverted: (changeId) =>
    set((state) => {
      if (!state.run) return state;
      return {
        run: {
          ...state.run,
          changes: state.run.changes.map((c) =>
            c.id === changeId ? { ...c, reverted: true } : c,
          ),
        },
      };
    }),

  dismissApproval: (approvalId) =>
    set((state) => {
      if (!state.run) return state;
      return {
        run: {
          ...state.run,
          approvals: state.run.approvals.filter(
            (a) => a.approvalId !== approvalId,
          ),
        },
      };
    }),

  resolveApproval: (approvalId, resolution) =>
    set((state) => {
      if (!state.run) return state;
      return {
        run: {
          ...state.run,
          approvals: state.run.approvals.map((a) =>
            a.approvalId === approvalId ? { ...a, resolution } : a,
          ),
        },
      };
    }),

  updatePlan: (plan) =>
    set((state) => (state.run ? { run: { ...state.run, plan } } : state)),

  setReviewDecisions: (decisions) =>
    set((state) => ({ reviewDecisions: { ...state.reviewDecisions, ...decisions } })),

  /* ---------------------------- terminal ---------------------------- */

  setTerminals: (terminals) =>
    set((state) => ({
      terminals,
      activeTerminalId: state.activeTerminalId ?? terminals[0]?.id ?? null,
    })),

  upsertTerminal: (session) =>
    set((state) => {
      const exists = state.terminals.some((t) => t.id === session.id);
      return {
        terminals: exists
          ? state.terminals.map((t) => (t.id === session.id ? session : t))
          : [session, ...state.terminals].slice(0, 12),
        activeTerminalId: session.id,
      };
    }),

  appendTerminalOutput: (id, text, offset) =>
    set((state) => ({
      terminals: state.terminals.map((t) =>
        t.id === id
          ? { ...t, output: (t.output + text).slice(-400_000), offset: offset ?? t.offset }
          : t,
      ),
    })),

  setActiveTerminal: (activeTerminalId) => set({ activeTerminalId }),

  /* ----------------------------- config ----------------------------- */

  setMemory: (memory) => set({ memory }),

  hydrateSettings: () => set({ settings: loadSettings(), appMode: loadAppMode(), settingsHydrated: true }),

  setSettings: (patch) =>
    set((state) => {
      const settings = clampSettings({ ...state.settings, ...patch });
      persistSettings(settings);
      return { settings };
    }),

  resetSettings: () => {
    persistSettings(DEFAULT_SETTINGS);
    set({ settings: DEFAULT_SETTINGS });
  },

  // `?mock=1` replays a canned run, so it never needs a key.
  setProvidersConfigured: (providersConfigured) =>
    set({ providersConfigured: providersConfigured || isMockMode() }),
}));

/** Convenience selector used by several panels. */
export function activeTab(state: ViberonState): EditorTab | undefined {
  return state.tabs.find((t) => t.path === state.activeTabPath);
}

/** "system" resolved against the OS preference. */
export function resolveTheme(theme: ThemeSetting): "dark" | "light" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export { nextId };
export type { RunPlan, PlanStep, LedgerSnapshot, ProjectMemory, ReviewDecision };
export type { ConversationMeta, StoredRun };

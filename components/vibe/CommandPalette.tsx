"use client";

/**
 * Command palette (⌘K).
 *
 * One entry point to everything: files, commands, panels, modes, and shell
 * commands. Typing a bare query searches files; prefixes switch namespace
 * (`>` commands, `$` run a shell command, `@` jump to a symbol).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CircleAlert,
  CircleDot,
  GitBranch,
  GitPullRequest,
  ListTodo,
  ArrowRight,
  Brain,
  FileCode2,
  Hash,
  Layers,
  MessageSquare,
  MessageSquareText,
  Monitor,
  Network,
  Search,
  Settings,
  TerminalSquare,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { loadFile } from "@/lib/file-loader";
import { refreshWorkspace } from "@/lib/client/agent-stream";
import { isPrUrl } from "@/lib/client/review";
import { useReview } from "@/store/review";
import { useUsageStore } from "@/store/usage";
import { useViberon, type TerminalSessionView } from "@/store/viberon";
import { cx, Kbd, truncatePath } from "@/components/vibe/primitives";

const PR_REVIEW_ID = "review.pr";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  keys?: string[];
  run: () => void;
}

export function CommandPalette() {
  const open = useViberon((s) => s.paletteOpen);
  const setOpen = useViberon((s) => s.setPaletteOpen);
  const fileList = useViberon((s) => s.fileList);
  const graph = useViberon((s) => s.graph);
  const repoKey = useViberon((s) => s.repoKey);
  const rootPath = useViberon((s) => s.rootPath);
  const conversations = useViberon((s) => s.conversations);

  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [askPr, setAskPr] = useState(false);
  const [prInvalid, setPrInvalid] = useState(false);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setAskPr(false);
      setPrInvalid(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const commands: Command[] = useMemo(() => {
    const store = useViberon.getState();
    return [
      {
        id: "mode.chat",
        label: "Switch to Chat mode",
        hint: "Full-screen conversation",
        icon: <MessageSquareText className="size-3.5" />,
        keys: ["⌘", "⇧", "M"],
        run: () => store.setAppMode("chat"),
      },
      {
        id: "mode.ide",
        label: "Switch to IDE mode",
        hint: "Editor, explorer, terminal",
        icon: <Layers className="size-3.5" />,
        keys: ["⌘", "⇧", "M"],
        run: () => store.setAppMode("ide"),
      },
      {
        id: "repo.clone",
        label: "Clone repository",
        hint: "Git URL, owner/repo, or a GitHub issue to fix",
        icon: <GitBranch className="size-3.5" />,
        run: () => store.setCloneOpen(true),
      },
      {
        id: "chat.new",
        label: "New chat",
        hint: "Start a fresh conversation in this workspace",
        icon: <MessageSquare className="size-3.5" />,
        run: () => {
          store.setAppMode("chat");
          store.newConversation();
          requestAnimationFrame(() =>
            window.dispatchEvent(new CustomEvent("viberon:focusComposer")),
          );
        },
      },
      {
        id: "panel.terminal",
        label: "Toggle terminal",
        icon: <TerminalSquare className="size-3.5" />,
        keys: ["⌘", "`"],
        run: () =>
          store.setBottomPanel(store.bottomPanel === "terminal" ? null : "terminal"),
      },
      {
        id: "panel.preview",
        label: "Toggle preview",
        hint: store.previewUrl ?? "No dev server detected yet",
        icon: <Monitor className="size-3.5" />,
        run: () => store.setPreviewOpen(!store.previewOpen),
      },
      {
        id: "view.graph",
        label: "Open code graph",
        icon: <Network className="size-3.5" />,
        keys: ["⌘", "G"],
        run: () => {
          store.setAppMode("ide");
          store.openGraphTab();
        },
      },
      {
        id: "view.explorer",
        label: "Show explorer",
        icon: <FileCode2 className="size-3.5" />,
        keys: ["⌘", "B"],
        run: () => {
          store.setAppMode("ide");
          store.setSidebarView("explorer");
        },
      },
      {
        id: "view.search",
        label: "Search in files",
        icon: <Search className="size-3.5" />,
        keys: ["⌘", "⇧", "F"],
        run: () => {
          store.setAppMode("ide");
          store.setSidebarView("search");
          requestAnimationFrame(() =>
            window.dispatchEvent(new CustomEvent("viberon:focusSearch")),
          );
        },
      },
      {
        id: "view.memory",
        label: "Project memory",
        hint: "What the agents know about this project",
        icon: <Brain className="size-3.5" />,
        run: () => {
          store.setAppMode("ide");
          store.setSidebarView("memory");
        },
      },
      {
        id: "view.changes",
        label: "Agent changes",
        icon: <FileCode2 className="size-3.5" />,
        run: () => {
          store.setAppMode("ide");
          store.setSidebarView("changes");
        },
      },
      {
        id: "view.ledger",
        label: "Token usage",
        hint: "Tokens, cost, context and what the graph and cache saved",
        icon: <Zap className="size-3.5" />,
        run: () => {
          store.setAppMode("ide");
          store.setBottomPanel("ledger");
        },
      },
      {
        id: "view.tokenHeatmap",
        label: "Toggle token heatmap",
        hint: "Shade the code graph by context tokens sent",
        icon: <Zap className="size-3.5" />,
        run: () => {
          const next = !useUsageStore.getState().graphHeat;
          useUsageStore.getState().setGraphHeat(next);
          if (next) {
            store.setAppMode("ide");
            store.openGraphTab();
          }
        },
      },
      {
        id: "view.settings",
        label: "Settings",
        icon: <Settings className="size-3.5" />,
        keys: ["⌘", ","],
        run: () => store.openSettingsTab(),
      },
      {
        id: "view.scm",
        label: "Source control",
        icon: <GitBranch className="size-3.5" />,
        keys: ["⌘", "⇧", "G"],
        run: () => {
          store.setAppMode("ide");
          store.setSidebarView("scm");
        },
      },
      {
        id: "view.problems",
        label: "Problems",
        icon: <CircleAlert className="size-3.5" />,
        keys: ["⌘", "⇧", "U"],
        run: () => {
          store.setAppMode("ide");
          store.setBottomPanel("problems");
        },
      },
      {
        id: "view.review",
        label: "Review agent edits",
        icon: <FileCode2 className="size-3.5" />,
        run: () => store.openReviewTab(),
      },
      {
        id: "theme.toggle",
        label: "Toggle light / dark theme",
        icon: <Settings className="size-3.5" />,
        run: () =>
          store.setSettings({ theme: store.settings.theme === "light" ? "dark" : "light" }),
      },
      {
        id: PR_REVIEW_ID,
        label: "Review a GitHub pull request…",
        hint: "Paste a PR URL; findings open in the Review panel",
        icon: <GitPullRequest className="size-3.5" />,
        run: () => {},
      },
      {
        id: "review.learn",
        label: "Learn review style from GitHub",
        hint: "Read recent PR review comments and save the conventions to memory",
        icon: <Brain className="size-3.5" />,
        run: () => void useReview.getState().learn(repoKey),
      },
      {
        id: "view.tasks",
        label: "Tasks",
        hint: "Queued and running fix / review tasks",
        icon: <ListTodo className="size-3.5" />,
        run: () => {
          store.setAppMode("ide");
          store.setBottomPanel("tasks");
        },
      },
      {
        id: "view.issues",
        label: "GitHub issues: fix and open PRs",
        hint: "List open issues, queue fixes that deliver draft pull requests",
        icon: <CircleDot className="size-3.5" />,
        run: () => {
          store.setAppMode("ide");
          store.setBottomPanel("issues");
        },
      },
      {
        id: "workspace.reindex",
        label: "Re-index workspace",
        hint: "Rebuild the symbol graph and memory",
        icon: <Network className="size-3.5" />,
        run: () => {
          void refreshWorkspace();
          toast.success("Re-indexing…");
        },
      },
      ...(rootPath
        ? [
            {
              id: "run.install",
              label: "Run: install dependencies",
              hint: "npm install",
              icon: <TerminalSquare className="size-3.5" />,
              run: () => void runShell(repoKey, "npm install"),
            },
            {
              id: "run.dev",
              label: "Run: start dev server",
              hint: "npm run dev",
              icon: <TerminalSquare className="size-3.5" />,
              run: () => void runShell(repoKey, "npm run dev"),
            },
            {
              id: "run.build",
              label: "Run: build",
              hint: "npm run build",
              icon: <TerminalSquare className="size-3.5" />,
              run: () => void runShell(repoKey, "npm run build"),
            },
            {
              id: "run.test",
              label: "Run: tests",
              hint: "npm test",
              icon: <TerminalSquare className="size-3.5" />,
              run: () => void runShell(repoKey, "npm test"),
            },
          ]
        : []),
    ];
  }, [repoKey, rootPath]);

  const trimmed = query.trim();
  const namespace = trimmed.startsWith(">")
    ? "commands"
    : trimmed.startsWith("@")
      ? "symbols"
      : trimmed.startsWith("$")
        ? "shell"
        : trimmed.startsWith("#")
          ? "chats"
          : "files";
  const needle = trimmed.replace(/^[>@$#]\s*/, "").toLowerCase();

  const results = useMemo(() => {
    if (namespace === "shell") {
      return needle
        ? [
            {
              kind: "shell" as const,
              id: "shell",
              label: `Run: ${needle}`,
              hint: rootPath ?? "No folder on disk",
            },
          ]
        : [];
    }

    if (namespace === "chats") {
      return conversations
        .filter(
          (c) =>
            !needle ||
            c.title.toLowerCase().includes(needle) ||
            c.preview.toLowerCase().includes(needle),
        )
        .slice(0, 40)
        .map((c) => ({
          kind: "chat" as const,
          id: c.id,
          label: c.title,
          hint: c.preview || undefined,
        }));
    }

    if (namespace === "symbols") {
      if (!graph) return [];
      return graph.nodes
        .filter((n) => !needle || n.name.toLowerCase().includes(needle))
        .slice(0, 40)
        .map((n) => ({
          kind: "symbol" as const,
          id: n.id,
          label: n.name,
          hint: `${truncatePath(n.file, 34)}:${n.startLine}`,
          file: n.file,
        }));
    }

    if (namespace === "commands" || (!needle && !trimmed)) {
      const list = commands.filter(
        (c) => !needle || c.label.toLowerCase().includes(needle),
      );
      if (namespace === "commands" || !trimmed) {
        return list.map((c) => ({
          kind: "command" as const,
          id: c.id,
          label: c.label,
          hint: c.hint,
          icon: c.icon,
          keys: c.keys,
          run: c.run,
        }));
      }
    }

    // Bare query → files, with matching commands appended.
    const files = fileList
      .filter((p) => p.toLowerCase().includes(needle))
      .slice(0, 40)
      .map((p) => ({ kind: "file" as const, id: p, label: p, hint: undefined }));
    const matchingCommands = commands
      .filter((c) => c.label.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((c) => ({
        kind: "command" as const,
        id: c.id,
        label: c.label,
        hint: c.hint,
        icon: c.icon,
        keys: c.keys,
        run: c.run,
      }));
    // A bare query should also surface past conversations — searching for a
    // topic you discussed is as common as searching for a file.
    const matchingChats = conversations
      .filter(
        (c) =>
          c.title.toLowerCase().includes(needle) ||
          c.preview.toLowerCase().includes(needle),
      )
      .slice(0, 5)
      .map((c) => ({
        kind: "chat" as const,
        id: c.id,
        label: c.title,
        hint: c.preview || undefined,
      }));

    return [...files, ...matchingChats, ...matchingCommands];
  }, [namespace, needle, trimmed, fileList, graph, commands, rootPath, conversations]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function submitPrUrl() {
    const url = query.trim();
    if (!isPrUrl(url)) {
      setPrInvalid(true);
      return;
    }
    setOpen(false);
    void useReview.getState().reviewPr(repoKey, url);
  }

  function choose(index: number) {
    const item = results[index];
    if (!item) return;
    if (item.kind === "command" && item.id === PR_REVIEW_ID) {
      // Second step in place: the input becomes the URL field.
      setAskPr(true);
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    setOpen(false);
    const store = useViberon.getState();

    switch (item.kind) {
      case "command":
        item.run();
        break;
      case "file":
        store.setAppMode("ide");
        void loadFile(repoKey, item.label);
        break;
      case "symbol":
        store.setAppMode("ide");
        store.selectNode(item.id);
        void loadFile(repoKey, item.file);
        break;
      case "chat":
        store.setAppMode("chat");
        store.switchConversation(item.id);
        break;
      case "shell":
        void runShell(repoKey, needle);
        break;
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: "rgba(0,0,0,0.25)" }}
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="vb-pop vb-in w-full max-w-[600px] overflow-hidden rounded-[4px]"
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="flex items-center gap-2 border-b px-3.5 py-2.5"
          style={{ borderColor: "var(--vb-line-faint)" }}
        >
          <Search className="size-4 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPrInvalid(false);
            }}
            onKeyDown={(event) => {
              if (askPr) {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAskPr(false);
                  setQuery("");
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  submitPrUrl();
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                choose(cursor);
              }
            }}
            placeholder={
              askPr
                ? "https://github.com/owner/repo/pull/123"
                : "Search files · > commands · @ symbols · # chats · $ run"
            }
            aria-label={askPr ? "Pull request URL" : "Command palette query"}
            className="min-w-0 flex-1 bg-transparent text-[13.5px] outline-none placeholder:text-[var(--vb-text-faint)]"
            style={{ color: "var(--vb-text-hi)" }}
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {askPr ? (
            <div className="flex flex-col gap-0.5 px-2.5 py-1.5 text-[12px]">
              <span style={{ color: "var(--vb-text)" }}>Review a GitHub pull request</span>
              <span style={{ color: prInvalid ? "var(--vb-rose)" : "var(--vb-text-faint)" }}>
                {prInvalid
                  ? "That is not a pull request URL (github.com/owner/repo/pull/N)."
                  : "Enter to review · Esc to go back. Uses the GitHub token from Settings."}
              </span>
            </div>
          ) : results.length === 0 ? (
            <p
              className="px-3 py-6 text-center text-[12px]"
              style={{ color: "var(--vb-text-faint)" }}
            >
              Nothing matches.
            </p>
          ) : (
            results.map((item, index) => (
              <button
                key={`${item.kind}-${item.id}`}
                type="button"
                data-selected={index === cursor}
                onMouseMove={() => setCursor(index)}
                onClick={() => choose(index)}
                className={cx(
                  "flex min-h-[28px] w-full items-center gap-2.5 rounded-[3px] px-2.5 py-1 text-left",
                )}
                style={
                  index === cursor
                    ? { background: "var(--vb-accent-soft)" }
                    : undefined
                }
              >
                <span
                  className="shrink-0"
                  style={{
                    color: index === cursor ? "var(--vb-text-hi)" : "var(--vb-text-faint)",
                  }}
                >
                  {item.kind === "command" && "icon" in item ? (
                    item.icon
                  ) : item.kind === "symbol" ? (
                    <Hash className="size-3.5" />
                  ) : item.kind === "chat" ? (
                    <MessageSquare className="size-3.5" />
                  ) : item.kind === "shell" ? (
                    <TerminalSquare className="size-3.5" />
                  ) : (
                    <FileCode2 className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[12.5px]"
                    style={{
                      color:
                        index === cursor ? "var(--vb-text-hi)" : "var(--vb-text)",
                    }}
                  >
                    {item.kind === "file" ? truncatePath(item.label, 56) : item.label}
                  </span>
                  {item.hint && (
                    <span
                      className="block truncate text-[11px]"
                      style={{ color: "var(--vb-text-faint)" }}
                    >
                      {item.hint}
                    </span>
                  )}
                </span>
                {item.kind === "command" && "keys" in item && item.keys && (
                  <span className="flex shrink-0 gap-0.5">
                    {item.keys.map((key, i) => (
                      <Kbd key={i}>{key}</Kbd>
                    ))}
                  </span>
                )}
                {index === cursor && (
                  <ArrowRight className="size-3 shrink-0" style={{ color: "var(--vb-text-hi)" }} />
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

async function runShell(repoKey: string, command: string): Promise<void> {
  const store = useViberon.getState();
  if (!store.rootPath) {
    toast.error("Open a local folder to run commands.");
    return;
  }
  store.setAppMode("ide");
  store.setBottomPanel("terminal");

  const response = await fetch("/api/terminal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoKey, command }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    toast.error(body?.error ?? "Could not run that command.");
    return;
  }
  const session = (await response.json()) as TerminalSessionView;
  useViberon.getState().upsertTerminal(session);
}

export default CommandPalette;

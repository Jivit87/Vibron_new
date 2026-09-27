"use client";

/**
 * Chat mode: one conversation column. Directing rather than editing.
 */

import { useEffect, useRef } from "react";
import { Copy, Plus } from "lucide-react";
import { toast } from "sonner";

import { AssistantMessage } from "@/components/AssistantMessage";
import { AgentRunView } from "@/components/vibe/AgentRunView";
import { MessageUsage } from "@/components/vibe/usage-ui";
import { Composer } from "@/components/vibe/Composer";
import { ConversationHistory } from "@/components/vibe/ConversationHistory";
import { useViberon, type ChatMessage, type RunState } from "@/store/viberon";
import { cx, formatAgo, Kbd } from "@/components/vibe/primitives";

export function ChatShell() {
  const messages = useViberon((s) => s.messages);
  const run = useViberon((s) => s.run);
  const streaming = useViberon((s) => s.streaming);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const isEmptyThread = messages.length === 0;

  // Follow the stream, but stop following once the user scrolls up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onScroll() {
      const target = scrollRef.current;
      if (!target) return;
      pinnedRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 90;
    }
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [isEmptyThread]);

  useEffect(() => {
    if (!pinnedRef.current) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, run]);

  // Jump to a specific reply (fired by the Changes panel).
  useEffect(() => {
    function onScrollTo(event: Event) {
      const messageId = (event as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (!messageId) return;
      pinnedRef.current = false;
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-message-id="${messageId}"]`);
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        el?.classList.add("vb-flash");
        window.setTimeout(() => el?.classList.remove("vb-flash"), 1400);
      });
    }
    window.addEventListener("viberon:scrollToMessage", onScrollTo);
    return () => window.removeEventListener("viberon:scrollToMessage", onScrollTo);
  }, []);

  if (messages.length === 0 && !run) return <EmptyChat />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConversationBar />

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-5 py-5">
          {messages.map((message, index) => (
            <MessageBlock
              key={message.id}
              message={message}
              run={run && message.role === "assistant" && index === messages.length - 1 ? run : null}
              streaming={streaming && index === messages.length - 1}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="shrink-0 px-5 pb-4 pt-2">
        <div className="mx-auto w-full max-w-[760px]">
          <Composer />
        </div>
      </div>
    </div>
  );
}

/** Empty thread: the composer, and the threads you can go back to. */
function EmptyChat() {
  const repoLabel = useViberon((s) => s.repoLabel);
  const conversations = useViberon((s) => s.conversations);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ConversationBar />
      <div className="min-h-0 flex-1 overflow-y-auto px-5">
        <div className="mx-auto flex w-full max-w-[680px] flex-col gap-3 pt-[14vh] pb-10">
          <p className="text-[13px]" style={{ color: "var(--vb-text-mid)" }}>
            {repoLabel}
          </p>
          <Composer large autoFocus />
          <div className="flex items-center gap-3 text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
            <span className="flex items-center gap-1">
              <Kbd>@</Kbd> add files
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>⇧</Kbd>
              <Kbd>M</Kbd> switch to IDE
            </span>
            <span className="flex items-center gap-1">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd> commands
            </span>
          </div>

          {conversations.length > 0 && (
            <div className="mt-6 flex flex-col">
              <p className="vb-label pb-1">Recent</p>
              {conversations.slice(0, 6).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => useViberon.getState().switchConversation(c.id)}
                  className="flex h-[26px] items-center gap-3 rounded-[3px] px-1.5 text-left hover:bg-[var(--vb-hover)]"
                >
                  <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: "var(--vb-text)" }}>
                    {c.title}
                  </span>
                  <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                    {formatAgo(c.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationBar() {
  const streaming = useViberon((s) => s.streaming);
  const messages = useViberon((s) => s.messages);
  const intent = useViberon((s) => s.run?.intent);

  return (
    <div
      className="flex h-[30px] shrink-0 items-center gap-1.5 border-b px-2"
      style={{ borderColor: "var(--vb-line)" }}
    >
      <ConversationHistory />
      {intent && (
        <span className="hidden font-mono text-[11px] sm:inline" style={{ color: "var(--vb-text-dim)" }}>
          {intent === "ask" ? "read-only" : "editing"}
        </span>
      )}
      <div className="flex-1" />
      {messages.length > 0 && (
      <button
        type="button"
        disabled={streaming}
        onClick={() => useViberon.getState().newConversation()}
        title={streaming ? "Stop the current run first" : "New chat"}
        className="vb-btn vb-btn-ghost"
      >
        <Plus className="size-3.5" />
        <span className="hidden sm:inline">New chat</span>
      </button>
      )}
    </div>
  );
}

function MessageBlock({
  message,
  run,
  streaming,
}: {
  message: ChatMessage;
  run: RunState | null;
  streaming: boolean;
}) {
  if (message.role === "user") {
    return (
      <div
        className="whitespace-pre-wrap break-words rounded-[4px] border px-3 py-2 text-[13px] leading-relaxed"
        style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-raised)", color: "var(--vb-text-hi)" }}
      >
        {message.content}
      </div>
    );
  }

  return (
    <div className="group flex flex-col gap-2" data-message-id={message.id}>
      {run && <AgentRunView run={run} />}
      {(message.content.trim() || (streaming && !run)) && (
        <div className="relative">
          <AssistantMessage content={message.content} />
          {!streaming && <MessageUsage message={message} />}
          {message.content && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(message.content);
                toast.success("Copied");
              }}
              className={cx(
                "absolute -top-1 right-0 rounded-[3px] p-1 opacity-0 hover:bg-[var(--vb-hover)] group-hover:opacity-100",
              )}
              style={{ color: "var(--vb-text-dim)" }}
              title="Copy reply"
            >
              <Copy className="size-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

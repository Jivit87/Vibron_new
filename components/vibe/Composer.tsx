"use client";

/**
 * The prompt composer, shared by both shells.
 *
 * Everything that changes how the next run behaves sits in one toolbar
 * under the input: Agent / Plan / Ask, Auto / Solo / Team, the model, and
 * the approval policy. `@` opens a file picker; picks become chips that
 * travel as structured attachments rather than pasted text.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, CircleDot, FileText, Folder, Loader2, Square, X } from "lucide-react";
import { toast } from "sonner";

import { cancelRun, sendPrompt } from "@/lib/client/agent-stream";
import { cloneRepository, fetchIssue, findIssueUrl, issuePrompt, recordClone } from "@/lib/client/clone";
import { fixAllIssuesInOnePr, isAllIssuesFixRequest, issuePromptRepo, stashPendingIssueBatch } from "@/lib/client/issues";
import { findMentionTrigger, fuzzyScore, removeTrigger } from "@/lib/composer/parsing";
import {
  attachmentKey,
  attachmentLabel,
  MAX_ATTACHMENTS,
  MAX_INLINE_CONTENT,
  type ContextAttachment,
} from "@/lib/composer/types";
import { problemsToText } from "@/lib/client/workspace-types";
import { useProblems } from "@/store/problems";
import {
  useViberon,
  type AgentMode,
  type CommandPolicy,
  type EditPolicy,
  type Interaction,
  type IssueRef,
} from "@/store/viberon";
import { cx, MenuItem, Popover, Segmented } from "@/components/vibe/primitives";

interface ModelOption {
  id: string;
  label: string;
  blurb: string;
  tier: string;
  provider: string;
  available: boolean;
  agentic: boolean;
}

const INTERACTIONS: { value: Interaction; label: string; title: string }[] = [
  { value: "agent", label: "Agent", title: "Make changes to the workspace" },
  { value: "plan", label: "Plan", title: "Propose a plan first; nothing runs until you approve it" },
  { value: "ask", label: "Ask", title: "Answer from the code without changing files" },
  { value: "fix", label: "Fix", title: "Find the cause of a bug, fix it, and prove the fix with the repo's tests" },
];

const MODES: { value: AgentMode; label: string; title: string }[] = [
  { value: "auto", label: "Auto", title: "One agent for small tasks, a team for large ones" },
  { value: "single", label: "Solo", title: "One generalist agent" },
  { value: "orchestrated", label: "Team", title: "Plan and dispatch specialists in parallel" },
];

const COMMAND_POLICIES: { value: CommandPolicy; label: string; hint: string }[] = [
  { value: "ask", label: "Ask", hint: "Confirm commands outside the safe list" },
  { value: "auto", label: "Auto", hint: "Run commands without asking" },
  { value: "never", label: "Off", hint: "Never run shell commands" },
];

const EDIT_POLICIES: { value: EditPolicy; label: string; hint: string }[] = [
  { value: "auto", label: "Auto", hint: "Apply edits, review afterwards" },
  { value: "ask", label: "Ask", hint: "Approve each edit before it is written" },
];

/** Pseudo-files offered in the `@` menu alongside real paths. */
const SPECIAL_MENTIONS: { id: string; label: string; hint: string }[] = [
  { id: "problems", label: "problems", hint: "Current Problems list" },
  { id: "git_diff", label: "git diff", hint: "Uncommitted changes" },
  { id: "terminal", label: "terminal", hint: "Active terminal output" },
];

type Suggestion =
  | { kind: "file"; path: string; folder: boolean }
  | { kind: "special"; id: string; label: string; hint: string };


export function Composer({
  placeholder = "Describe a change, or ask a question",
  autoFocus = false,
  large = false,
}: {
  placeholder?: string;
  autoFocus?: boolean;
  large?: boolean;
}) {
  const router = useRouter();
  const streaming = useViberon((s) => s.streaming);
  const settings = useViberon((s) => s.settings);
  const setSettings = useViberon((s) => s.setSettings);
  const providersConfigured = useViberon((s) => s.providersConfigured);
  const rootPath = useViberon((s) => s.rootPath);
  const fileList = useViberon((s) => s.fileList);

  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<ContextAttachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [issue, setIssue] = useState<IssueRef | null>(null);
  const [issueLoading, setIssueLoading] = useState<string | null>(null);
  const [fixingAll, setFixingAll] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerDraft = useViberon((s) => s.composerDraft);

  // A draft handed over by another surface (clone → fix): take it once.
  useEffect(() => {
    if (!composerDraft) return;
    const state = useViberon.getState();
    state.setComposerDraft(null);
    if (composerDraft.interaction) state.setSettings({ interaction: composerDraft.interaction });
    setValue(composerDraft.text);
    setIssue(composerDraft.issue ?? null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerDraft]);

  /** Fix mode: a pasted issue URL becomes a chip with the issue's title. */
  function expandIssue(text: string) {
    const url = findIssueUrl(text);
    if (!url || issueLoading) return;
    setValue(text.replace(url, "").replace(/^\s+/, ""));
    setIssueLoading(url);
    void fetchIssue(url).then((found) => {
      setIssueLoading(null);
      const number = /\/issues\/(\d+)/.exec(url)?.[1] ?? "";
      setIssue(found ?? { title: `Issue #${number}`, body: "", url });
    });
  }

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { models?: ModelOption[]; anyConfigured?: boolean } | null) => {
        if (cancelled || !body) return;
        setModels(body.models ?? []);
        useViberon.getState().setProvidersConfigured(body.anyConfigured !== false);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function focus() {
      textareaRef.current?.focus();
    }
    function attach(event: Event) {
      const item = (event as CustomEvent<ContextAttachment>).detail;
      if (item) addAttachment(item);
      focus();
    }
    window.addEventListener("viberon:focusComposer", focus);
    window.addEventListener("viberon:attach", attach);
    return () => {
      window.removeEventListener("viberon:focusComposer", focus);
      window.removeEventListener("viberon:attach", attach);
    };
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, large ? 240 : 180)}px`;
  }, [value, large]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const folders = new Set<string>();
    for (const path of fileList) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i += 1) folders.add(parts.slice(0, i).join("/"));
    }
    const scored: { s: Suggestion; score: number }[] = [];
    for (const special of SPECIAL_MENTIONS) {
      const score = fuzzyScore(special.label, q);
      if (score >= 0) scored.push({ s: { kind: "special", ...special }, score: score + (q ? 0 : 900) });
    }
    for (const path of fileList) {
      const score = fuzzyScore(path, q);
      if (score >= 0) scored.push({ s: { kind: "file", path, folder: false }, score });
    }
    if (q) {
      for (const path of folders) {
        const score = fuzzyScore(path, q);
        if (score >= 0) scored.push({ s: { kind: "file", path, folder: true }, score: score - 5 });
      }
    }
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((x) => x.s);
  }, [trigger, fileList]);

  function addAttachment(item: ContextAttachment) {
    setAttachments((prev) => {
      if (prev.length >= MAX_ATTACHMENTS) return prev;
      const key = attachmentKey(item);
      return prev.some((a) => attachmentKey(a) === key) ? prev : [...prev, item];
    });
  }

  function syncTrigger(text: string, caret: number) {
    const match = findMentionTrigger(text, caret);
    setTrigger(match);
    setHighlight(0);
  }

  function pick(suggestion: Suggestion) {
    const el = textareaRef.current;
    if (!trigger || !el) return;
    const caret = el.selectionStart ?? value.length;
    const next = removeTrigger(value, trigger.start, caret);
    setValue(next.text);
    setTrigger(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });

    if (suggestion.kind === "file") {
      addAttachment({ kind: suggestion.folder ? "folder" : "file", path: suggestion.path });
      return;
    }
    if (suggestion.id === "git_diff") {
      addAttachment({ kind: "git_diff" });
    } else if (suggestion.id === "problems") {
      const problems = useProblems.getState().problems;
      addAttachment({ kind: "problems", content: problemsToText(problems) || "No problems." });
    } else if (suggestion.id === "terminal") {
      const state = useViberon.getState();
      const term =
        state.terminals.find((t) => t.id === state.activeTerminalId) ?? state.terminals[0];
      if (term) {
        addAttachment({
          kind: "terminal",
          label: term.command,
          content: term.output.slice(-MAX_INLINE_CONTENT),
        });
      }
    }
  }

  async function fixAll(prompt?: string) {
    const repoKey = useViberon.getState().repoKey;
    if (!repoKey || fixingAll) return;
    setFixingAll(true);
    const target = prompt ? issuePromptRepo(prompt) : null;
    if (target) {
      const cloned = await cloneRepository(target, () => {});
      setFixingAll(false);
      if (cloned.type !== "done") {
        toast.error(cloned.type === "error" ? cloned.message : "Could not open the repository.");
        return;
      }
      recordClone({ repoKey: cloned.repoKey, label: cloned.label, url: target, rootPath: cloned.rootPath });
      if (cloned.repoKey === repoKey) {
        const error = await fixAllIssuesInOnePr(repoKey, settings.model, prompt);
        if (error) toast.error(error);
        else setValue("");
        return;
      }
      stashPendingIssueBatch(cloned.repoKey, prompt!, settings.model);
      setValue("");
      router.push(`/workspace/${encodeURIComponent(cloned.repoKey)}`);
      return;
    }
    const error = await fixAllIssuesInOnePr(repoKey, settings.model, prompt);
    setFixingAll(false);
    if (error) toast.error(error);
    else setValue("");
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    // An explicit prompt can start the full issue workflow from Agent or Fix.
    if ((settings.interaction === "fix" || settings.interaction === "agent") && !issue && isAllIssuesFixRequest(value)) {
      void fixAll(value);
      return;
    }
    const fixIssue = settings.interaction === "fix" ? issue : null;
    const prompt = fixIssue ? issuePrompt(fixIssue, value) : value.trim();
    if (!prompt || streaming || issueLoading) return;
    setValue("");
    setIssue(null);
    const sent = attachments;
    setAttachments([]);
    setTrigger(null);
    void sendPrompt(prompt, { attachments: sent });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (trigger && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        pick(suggestions[highlight]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setTrigger(null);
        return;
      }
    }
    if (event.key === "Backspace" && value === "" && attachments.length > 0) {
      setAttachments((prev) => prev.slice(0, -1));
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      submit();
    }
  }

  const disabled = !providersConfigured;
  const fixMode = settings.interaction === "fix";
  const sendLabel =
    settings.interaction === "plan"
      ? "Plan"
      : settings.interaction === "ask"
        ? "Ask"
        : fixMode
          ? "Fix"
          : "Send";
  const canSend = value.trim().length > 0 || (fixMode && issue !== null);

  return (
    <form
      onSubmit={submit}
      className="relative flex flex-col rounded-[4px] border focus-within:border-[var(--vb-line-strong)]"
      style={{ background: "var(--vb-bg-input)", borderColor: "var(--vb-line)" }}
    >
      {trigger && suggestions.length > 0 && (
        <div role="listbox" className="vb-pop absolute bottom-[calc(100%+4px)] left-0 z-50 w-[360px] max-w-full py-1">
          {suggestions.map((s, i) => (
            <button
              key={s.kind === "file" ? s.path : s.id}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setHighlight(i)}
              className="flex h-[24px] w-full items-center gap-2 px-2.5 text-left text-[12.5px]"
              style={{
                background: i === highlight ? "var(--vb-accent-soft)" : undefined,
                color: "var(--vb-text)",
              }}
            >
              {s.kind === "file" ? (
                <>
                  {s.folder ? (
                    <Folder className="size-3.5 shrink-0" style={{ color: "var(--vb-text-dim)" }} />
                  ) : (
                    <FileText className="size-3.5 shrink-0" style={{ color: "var(--vb-text-dim)" }} />
                  )}
                  <span className="truncate">{s.path.split("/").pop()}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
                    {s.path.split("/").slice(0, -1).join("/")}
                  </span>
                </>
              ) : (
                <>
                  <span className="w-3.5 shrink-0 text-center font-mono" style={{ color: "var(--vb-text-dim)" }}>
                    @
                  </span>
                  <span>{s.label}</span>
                  <span className="text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
                    {s.hint}
                  </span>
                </>
              )}
            </button>
          ))}
        </div>
      )}

      {fixMode && (issue || issueLoading) && (
        <div className="flex px-2 pt-2">
          <span
            className="inline-flex h-[22px] min-w-0 max-w-full items-center gap-1.5 rounded-[3px] border pl-1.5 pr-0.5 text-[12px]"
            style={{ borderColor: "var(--vb-line)", background: "var(--vb-fill)", color: "var(--vb-text)" }}
            title={issue?.url ?? issueLoading ?? ""}
          >
            {issueLoading ? (
              <Loader2 className="size-3 shrink-0 animate-spin" style={{ color: "var(--vb-text-dim)" }} />
            ) : (
              <CircleDot className="size-3 shrink-0" style={{ color: "var(--vb-mint)" }} />
            )}
            <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
              {issueRefLabel(issue?.url ?? issueLoading ?? "")}
            </span>
            <span className="min-w-0 truncate">{issueLoading ? "Fetching issue" : issue?.title}</span>
            {issue && (
              <button
                type="button"
                aria-label="Remove issue"
                onClick={() => setIssue(null)}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-[2px] hover:bg-[var(--vb-hover)]"
              >
                <X className="size-3" />
              </button>
            )}
          </span>
        </div>
      )}

      {fixMode && !issue && !issueLoading && rootPath && (
        <div className="flex items-center gap-2 px-2 pt-2 text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
          <CircleDot className="size-3 shrink-0" style={{ color: "var(--vb-mint)" }} />
          <span className="min-w-0 truncate">Paste an issue URL, describe a bug, or</span>
          <button
            type="button"
            className="vb-btn shrink-0"
            style={{ height: 20, padding: "0 6px" }}
            disabled={streaming || fixingAll}
            title="Fix every open GitHub issue of this repository on one branch and open one pull request"
            onClick={() => void fixAll()}
          >
            {fixingAll ? <Loader2 className="size-3 animate-spin" /> : null}
            Fix all GitHub issues → 1 PR
          </button>
        </div>
      )}

      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1 px-2 pt-2">
          {attachments.map((a) => (
            <span
              key={attachmentKey(a)}
              className="inline-flex h-[20px] max-w-[220px] items-center gap-1 rounded-[3px] border pl-1.5 pr-0.5 font-mono text-[11px]"
              style={{ borderColor: "var(--vb-line)", background: "var(--vb-fill)", color: "var(--vb-text-mid)" }}
              title={"path" in a ? a.path : attachmentLabel(a)}
            >
              <span className="truncate">{attachmentLabel(a)}</span>
              <button
                type="button"
                aria-label={`Remove ${attachmentLabel(a)}`}
                onClick={() => setAttachments((prev) => prev.filter((x) => attachmentKey(x) !== attachmentKey(a)))}
                className="inline-flex size-4 items-center justify-center rounded-[2px] hover:bg-[var(--vb-hover)]"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          syncTrigger(e.target.value, e.target.selectionStart ?? e.target.value.length);
          if (fixMode && !issue) expandIssue(e.target.value);
        }}
        onKeyDown={onKeyDown}
        onClick={(e) => syncTrigger(value, e.currentTarget.selectionStart ?? value.length)}
        onBlur={() => setTimeout(() => setTrigger(null), 100)}
        placeholder={
          disabled
            ? "Add an API key in Settings to start"
            : fixMode
              ? issue
                ? "Add notes for this fix (optional)"
                : "Describe the bug, or paste a GitHub issue URL"
              : placeholder
        }
        disabled={disabled}
        autoFocus={autoFocus}
        rows={large ? 3 : 2}
        aria-label="Prompt"
        className={cx(
          "w-full resize-none bg-transparent px-2.5 pt-2 pb-1 outline-none disabled:cursor-not-allowed",
          "text-[13px] leading-[1.5]",
        )}
        style={{ color: "var(--vb-text-hi)" }}
      />

      <div className="flex flex-wrap items-center gap-1 px-1.5 pb-1.5">
        <Segmented
          value={settings.interaction}
          options={INTERACTIONS}
          onChange={(interaction) => setSettings({ interaction })}
        />
        {settings.interaction !== "ask" && !fixMode && (
          <Segmented value={settings.agentMode} options={MODES} onChange={(agentMode) => setSettings({ agentMode })} />
        )}
        <ModelPicker value={settings.model} models={models} onChange={(model) => setSettings({ model })} />
        {rootPath && (settings.interaction === "agent" || fixMode) && (
          <PolicyPicker
            command={settings.commandPolicy}
            edit={settings.editPolicy}
            onCommand={(commandPolicy) => setSettings({ commandPolicy })}
            onEdit={(editPolicy) => setSettings({ editPolicy })}
          />
        )}

        <div className="flex-1" />

        {streaming ? (
          <button type="button" onClick={() => void cancelRun()} className="vb-btn" title="Stop the run">
            <Square className="size-3 fill-current" />
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !canSend || issueLoading !== null}
            className="vb-btn vb-btn-primary"
            title={`${sendLabel} (Enter)`}
          >
            <ArrowUp className="size-3.5" />
            {sendLabel}
          </button>
        )}
      </div>
    </form>
  );
}

/** "owner/repo#12" from an issue URL. */
function issueRefLabel(url: string): string {
  const m = /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/.exec(url);
  return m ? `${m[1]}/${m[2]}#${m[3]}` : "issue";
}

/* ------------------------------ controls --------------------------------- */

function ModelPicker({
  value,
  models,
  onChange,
}: {
  value: string;
  models: ModelOption[];
  onChange: (model: string) => void;
}) {
  const current = models.find((m) => m.id === value);
  const label = value === "auto" ? "Auto model" : (current?.label ?? value);

  return (
    <Popover label={label} title="Model" width={290}>
      {(close) => (
        <>
          <MenuItem
            active={value === "auto"}
            onClick={() => {
              onChange("auto");
              close();
            }}
            title="Auto"
            hint="Best available model for each role"
          />
          <div className="my-1 h-px" style={{ background: "var(--vb-line)" }} />
          {models.length === 0 && (
            <p className="px-2.5 py-1 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
              No models loaded
            </p>
          )}
          {models.map((model) => (
            <MenuItem
              key={model.id}
              active={value === model.id}
              disabled={!model.available}
              onClick={() => {
                onChange(model.id);
                close();
              }}
              title={model.label}
              hint={model.available ? model.blurb : `Needs a ${model.provider} key`}
              trailing={
                !model.agentic ? (
                  <span
                    className="text-[10.5px]"
                    style={{ color: "var(--vb-text-faint)" }}
                    title="Less reliable at long multi-step tool loops"
                  >
                    basic
                  </span>
                ) : undefined
              }
            />
          ))}
        </>
      )}
    </Popover>
  );
}

function PolicyPicker({
  command,
  edit,
  onCommand,
  onEdit,
}: {
  command: CommandPolicy;
  edit: EditPolicy;
  onCommand: (policy: CommandPolicy) => void;
  onEdit: (policy: EditPolicy) => void;
}) {
  const commandLabel = COMMAND_POLICIES.find((p) => p.value === command)?.label ?? command;
  const editLabel = EDIT_POLICIES.find((p) => p.value === edit)?.label ?? edit;
  return (
    <Popover label={`Cmd ${commandLabel} · Edit ${editLabel}`} title="Approval policy" width={250}>
      {(close) => (
        <>
          <p className="px-2.5 pb-0.5 pt-0.5 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            Shell commands
          </p>
          {COMMAND_POLICIES.map((option) => (
            <MenuItem
              key={option.value}
              active={command === option.value}
              onClick={() => {
                onCommand(option.value);
                close();
              }}
              title={option.label}
              hint={option.hint}
            />
          ))}
          <div className="my-1 h-px" style={{ background: "var(--vb-line)" }} />
          <p className="px-2.5 pb-0.5 text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
            File edits
          </p>
          {EDIT_POLICIES.map((option) => (
            <MenuItem
              key={option.value}
              active={edit === option.value}
              onClick={() => {
                onEdit(option.value);
                close();
              }}
              title={option.label}
              hint={option.hint}
            />
          ))}
        </>
      )}
    </Popover>
  );
}

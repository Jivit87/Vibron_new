"use client";

/**
 * Settings, as an editor tab: category list on the left, one column of
 * setting rows on the right (label and description, control aligned right).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { isMockMode, MOCK_PROVIDER_STATUS } from "@/lib/client/mock-run";
import { MAX_CONCURRENCY } from "@/lib/limits";
import {
  anyProviderReady,
  normalizeProviderStatus,
  type ClaudeCliStatus,
  type KeyProviderStatus,
} from "@/lib/client/providers";
import { useViberon, type AppSettings } from "@/store/viberon";
import { cx, Segmented, SettingRow as Row, Switch } from "@/components/vibe/primitives";
import { GithubMcpSettings } from "@/components/vibe/GithubMcpSettings";

type ProviderStatus = KeyProviderStatus;

const PROVIDER_META: Record<ProviderStatus["provider"], { label: string; blurb: string; url: string; placeholder: string }> = {
  anthropic: {
    label: "Anthropic",
    blurb: "Claude models. Recommended for agent runs.",
    url: "https://console.anthropic.com/settings/keys",
    placeholder: "sk-ant-api03-…",
  },
  deepseek: {
    label: "DeepSeek",
    blurb: "DeepSeek V4 Flash and Pro, with reasoning kept across tool turns.",
    url: "https://platform.deepseek.com/api_keys",
    placeholder: "sk-…",
  },
  groq: {
    label: "Groq",
    blurb: "Open-weights models. Fast and cheap for small subtasks.",
    url: "https://console.groq.com/keys",
    placeholder: "gsk_…",
  },
  gemini: {
    label: "Google Gemini",
    blurb: "Gemini Pro and Flash. The model list comes live from your key.",
    url: "https://aistudio.google.com/apikey",
    placeholder: "AIza…",
  },
  nvidia: {
    label: "NVIDIA",
    blurb: "NVIDIA API Catalog: Qwen3 Coder, GPT-OSS, Kimi K2, DeepSeek and more.",
    url: "https://build.nvidia.com/settings/api-keys",
    placeholder: "nvapi-…",
  },
  openai: {
    label: "OpenAI-compatible",
    blurb: "OpenAI, or any compatible endpoint set with AI_BASE_URL.",
    url: "https://platform.openai.com/api-keys",
    placeholder: "sk-…",
  },
};

const CATEGORIES = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "agents", label: "Agents" },
  { id: "integrations", label: "Integrations" },
  { id: "permissions", label: "Permissions" },
  { id: "retrieval", label: "Retrieval" },
  { id: "editor", label: "Editor" },
] as const;

type CategoryId = (typeof CATEGORIES)[number]["id"];

export function SettingsPage() {
  const settings = useViberon((s) => s.settings);
  const setSettings = useViberon((s) => s.setSettings);
  const resetSettings = useViberon((s) => s.resetSettings);
  const rootPath = useViberon((s) => s.rootPath);
  const [category, setCategory] = useState<CategoryId>("general");
  const [query, setQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [cli, setCli] = useState<ClaudeCliStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      let raw: unknown = MOCK_PROVIDER_STATUS;
      if (!isMockMode()) {
        const response = await fetch("/api/settings/keys");
        if (!response.ok) return;
        raw = await response.json();
      }
      const status = normalizeProviderStatus(raw);
      setProviders(status.keys);
      setCli(status.cli);
      useViberon.getState().setProvidersConfigured(anyProviderReady(status));
    } catch {
      // Server unreachable; rows show as unconfigured.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function jump(id: CategoryId) {
    setCategory(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: "start" });
  }

  const set = <K extends keyof AppSettings>(key: K) => (value: AppSettings[K]) =>
    setSettings({ [key]: value } as Partial<AppSettings>);

  const q = query.trim().toLowerCase();
  const show = (text: string) => !q || text.toLowerCase().includes(q);

  return (
    <div className="@container flex h-full min-h-0" style={{ background: "var(--vb-bg-base)" }}>
      <nav className="hidden w-[180px] shrink-0 border-r py-3 @2xl:block" style={{ borderColor: "var(--vb-line)" }} aria-label="Settings categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => jump(c.id)}
            data-selected={category === c.id}
            className="vb-row w-full text-left"
          >
            {c.label}
          </button>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[40px] shrink-0 items-center gap-2 border-b px-4 @2xl:px-6" style={{ borderColor: "var(--vb-line)" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="vb-input w-72 min-w-0 shrink"
          />
          <div className="flex-1" />
          <button type="button" className="vb-btn vb-btn-ghost" onClick={resetSettings}>
            Restore defaults
          </button>
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="max-w-[760px] px-4 pb-16 @2xl:px-6">
            <Section id="general" title="General">
              {show("theme appearance light dark") && (
                <Row label="Theme" hint="Light, dark, or follow the operating system.">
                  <Segmented
                    size="md"
                    value={settings.theme}
                    options={[
                      { value: "dark", label: "Dark" },
                      { value: "light", label: "Light" },
                      { value: "system", label: "System" },
                    ]}
                    onChange={set("theme")}
                  />
                </Row>
              )}
            </Section>

            <Section id="providers" title="Providers" hint="Keys are stored on this machine and never sent to the browser.">
              {loading ? (
                <p className="flex items-center gap-2 py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
                  <Loader2 className="size-3.5 animate-spin" />
                  Checking keys
                </p>
              ) : providers.length === 0 && !cli ? (
                <p className="py-2 text-[12.5px]" style={{ color: "var(--vb-text-dim)" }}>
                  Could not read provider status.
                </p>
              ) : (
                <>
                  {providers
                    .filter((p) => show(`${PROVIDER_META[p.provider].label} api key`))
                    .map((p) => (
                      <ProviderRow key={p.provider} status={p} onChanged={refresh} />
                    ))}
                  {cli && show("claude subscription cli login") && <ClaudeCliRow status={cli} />}
                </>
              )}
            </Section>

            <Section id="agents" title="Agents">
              {show("default interaction fix agent plan ask") && (
                <Row label="Default interaction" hint="Fix reproduces, patches and proves; Agent edits the workspace; Plan proposes steps for approval first; Ask only answers.">
                  <Segmented
                    size="md"
                    value={settings.interaction}
                    options={[
                      { value: "fix", label: "Fix" },
                      { value: "agent", label: "Agent" },
                      { value: "plan", label: "Plan" },
                      { value: "ask", label: "Ask" },
                    ]}
                    onChange={set("interaction")}
                  />
                </Row>
              )}
              {show("execution mode team solo auto") && (
                <Row label="Execution mode" hint="Solo runs one generalist; Team plans and dispatches specialists; Auto decides per request.">
                  <Segmented
                    size="md"
                    value={settings.agentMode}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "single", label: "Solo" },
                      { value: "orchestrated", label: "Team" },
                    ]}
                    onChange={set("agentMode")}
                  />
                </Row>
              )}
              {show("parallel specialists concurrency") && (
                <Row
                  label="Parallel specialists"
                  hint="Higher finishes sooner but hits rate limits more: at 10, NVIDIA's free tier (40 requests/min) and Groq's token cap will throttle more — runs slow down rather than fail. With a Claude subscription (CLI) model each specialist is a separate process (~150–250 MB RAM each)."
                >
                  <NumberInput value={settings.concurrency} min={1} max={MAX_CONCURRENCY} onChange={set("concurrency")} />
                </Row>
              )}
              {show("show reasoning thinking") && (
                <Row label="Show reasoning" hint="Stream each agent's thinking into the run view.">
                  <Switch checked={settings.showThinking} onChange={set("showThinking")} label="Show reasoning" />
                </Row>
              )}
              {show("checkpoint snapshot undo") && (
                <Row label="Checkpoint before each run" hint="Snapshot the workspace so a whole run can be undone.">
                  <Switch checked={settings.autoCheckpoint} onChange={set("autoCheckpoint")} label="Checkpoint before each run" />
                </Row>
              )}
            </Section>

            <Section id="integrations" title="Integrations" hint="MCP servers available to every workspace. Tokens stay on this machine.">
              <GithubMcpSettings show={show} />
            </Section>

            <Section
              id="permissions"
              title="Permissions"
              hint={rootPath ? `Commands run in ${rootPath}.` : "Open a local folder to enable command execution."}
            >
              {show("shell commands policy") && (
                <Row
                  label="Shell commands"
                  hint="Deleting outside the workspace, piping remote scripts to a shell and privilege escalation are always refused."
                >
                  <Segmented
                    size="md"
                    value={settings.commandPolicy}
                    options={[
                      { value: "ask", label: "Ask" },
                      { value: "auto", label: "Auto" },
                      { value: "never", label: "Off" },
                    ]}
                    onChange={set("commandPolicy")}
                  />
                </Row>
              )}
              {show("file edits approval") && (
                <Row label="File edits" hint="Ask shows each edit as a diff for approval before it is written.">
                  <Segmented
                    size="md"
                    value={settings.editPolicy}
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "ask", label: "Ask" },
                    ]}
                    onChange={set("editPolicy")}
                  />
                </Row>
              )}
              {show("auto open preview dev server") && (
                <Row label="Open preview automatically" hint="Show the app when a dev-server URL is detected.">
                  <Switch checked={settings.autoPreview} onChange={set("autoPreview")} label="Open preview automatically" />
                </Row>
              )}
            </Section>

            <Section id="retrieval" title="Retrieval" hint="How much of the code graph agents pull in per request.">
              {show("expansion depth hops") && (
                <Row label="Expansion depth" hint="Graph hops from the symbols that matched.">
                  <NumberInput value={settings.retrievalDepth} min={1} max={4} onChange={set("retrievalDepth")} />
                </Row>
              )}
              {show("max symbols nodes") && (
                <Row label="Max symbols" hint="Upper bound on symbols included per request.">
                  <NumberInput value={settings.maxNodes} min={5} max={60} step={5} onChange={set("maxNodes")} />
                </Row>
              )}
            </Section>

            <Section id="editor" title="Editor">
              {show("font size") && (
                <Row label="Font size">
                  <NumberInput value={settings.editorFontSize} min={10} max={22} onChange={set("editorFontSize")} />
                </Row>
              )}
              {show("word wrap") && (
                <Row label="Word wrap">
                  <Switch checked={settings.editorWordWrap} onChange={set("editorWordWrap")} label="Word wrap" />
                </Row>
              )}
              {show("minimap") && (
                <Row label="Minimap">
                  <Switch checked={settings.editorMinimap} onChange={set("editorMinimap")} label="Minimap" />
                </Row>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Section({ id, title, hint, children }: { id: string; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section id={`settings-${id}`} className="scroll-mt-2 pt-6">
      <h2 className="text-[13px] font-semibold" style={{ color: "var(--vb-text-hi)" }}>
        {title}
      </h2>
      {hint && (
        <p className="mt-0.5 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
          {hint}
        </p>
      )}
      <div className="mt-2 flex flex-col border-t" style={{ borderColor: "var(--vb-line)" }}>
        {children}
      </div>
    </section>
  );
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
      className="vb-input w-20 text-right font-mono"
    />
  );
}

/** Read-only: the harness falls back to the logged-in `claude` CLI; nothing to enter here. */
function ClaudeCliRow({ status }: { status: ClaudeCliStatus }) {
  const code = (text: string) => (
    <code className="rounded-[3px] px-1 font-mono text-[11.5px]" style={{ background: "var(--vb-fill)", color: "var(--vb-text-mid)" }}>
      {text}
    </code>
  );
  return (
    <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <div className="flex flex-col items-start gap-2 @xl:flex-row @xl:items-center @xl:gap-6">
        <div className="min-w-0 @xl:flex-1">
          <p className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            Claude subscription (CLI)
            {status.detail && (
              <span className="font-mono text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
                {status.detail}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            Uses your logged-in {code("claude")} CLI when no API key is set. Run {code("claude")} once to log in.
          </p>
        </div>
        <span
          className="inline-flex h-[20px] shrink-0 items-center gap-1.5 rounded-[3px] border px-1.5 font-mono text-[11px]"
          style={{ borderColor: "var(--vb-line-strong)", color: status.configured ? "var(--vb-text-mid)" : "var(--vb-text-faint)" }}
        >
          <span
            className="size-[6px] rounded-full"
            style={{ background: status.configured ? "var(--vb-mint)" : "var(--vb-text-faint)" }}
          />
          {status.configured ? "logged in" : "not logged in"}
        </span>
      </div>
    </div>
  );
}

function ProviderRow({ status, onChanged }: { status: ProviderStatus; onChanged: () => Promise<void> | void }) {
  const meta = PROVIDER_META[status.provider];
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);

  async function save() {
    const key = value.trim();
    if (!key) return;
    setSaving(true);
    try {
      const response = await fetch("/api/settings/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: status.provider, key }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        toast.error(body?.error ?? "Could not save that key.");
        return;
      }
      toast.success(`${meta.label} key saved.`);
      setValue("");
      setEditing(false);
      await onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await fetch(`/api/settings/keys?provider=${status.provider}`, { method: "DELETE" });
    toast.success(`${meta.label} key removed.`);
    await onChanged();
  }

  return (
    <div className="flex flex-col gap-2 border-b py-2.5" style={{ borderColor: "var(--vb-line)" }}>
      <div className="flex flex-col items-start gap-2 @xl:flex-row @xl:items-center @xl:gap-6">
        <div className="min-w-0 @xl:flex-1">
          <p className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--vb-text)" }}>
            {meta.label}
            <span className="font-mono text-[11.5px]" style={{ color: status.configured ? "var(--vb-text-dim)" : "var(--vb-text-faint)" }}>
              {status.configured ? status.masked : "not set"}
            </span>
            {status.fromEnv && (
              <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={`From ${status.envVar}`}>
                ${status.envVar}
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            {meta.blurb}{" "}
            <a href={meta.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Get a key
            </a>
          </p>
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-1">
            {status.configured && !status.fromEnv && (
              <button type="button" className="vb-btn vb-btn-ghost" onClick={() => void remove()}>
                Remove
              </button>
            )}
            <button type="button" className={cx("vb-btn", !status.configured && "vb-btn-primary")} onClick={() => setEditing(true)}>
              {status.configured ? "Replace" : "Add key"}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <input
              autoFocus
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder={meta.placeholder}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${meta.label} API key`}
              className="vb-input w-full pr-8 font-mono"
            />
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              title={reveal ? "Hide" : "Show"}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
              style={{ color: "var(--vb-text-dim)" }}
            >
              {reveal ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <button type="button" className="vb-btn vb-btn-primary" disabled={saving || !value.trim()} onClick={() => void save()}>
            {saving ? "Verifying…" : "Save"}
          </button>
          <button type="button" className="vb-btn vb-btn-ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

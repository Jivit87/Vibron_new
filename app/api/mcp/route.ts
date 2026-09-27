/**
 * MCP server management.
 *
 *   GET  /api/mcp?repoKey=…[&connect=1]      → servers, status, tools
 *   GET  /api/mcp?repoKey=…&logs=<name>      → captured stderr + lifecycle log
 *   POST /api/mcp { action, repoKey, name, … }
 *
 * Actions: add, update, remove, enable, disable, trust, untrust, restart, test.
 * `update` replaces a server's config ({ name, config }); env/header values
 * sent back still redacted keep their stored secret.
 *
 * Secrets in `env` / `headers` are redacted before anything is returned —
 * the same rule as provider keys: the browser only sees fingerprints.
 */

import { qualifiedToolName } from "@/lib/mcp/bridge";
import {
  configFingerprint,
  keepRedactedSecrets,
  parseServerEntry,
  redactRecord,
  type McpServerConfig,
  type RawServerEntry,
} from "@/lib/mcp/config";
import {
  connectionSnapshot,
  disconnectServer,
  ensureConnected,
  restartServer,
  serverLogs,
} from "@/lib/mcp/manager";
import {
  getGlobalEntries,
  resolveServers,
  setGlobalEntry,
  setOverride,
  setWorkspaceEntry,
} from "@/lib/mcp/settings";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

const SOURCE_LABEL: Record<McpServerConfig["source"], string> = {
  viberon: ".viberon/mcp.json",
  claude: ".mcp.json",
  cursor: ".cursor/mcp.json",
  global: "User settings",
};

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,47}$/;

async function workspace(repoKey: string): Promise<{ scope: string; rootPath: string | null }> {
  if (!repoKey) return { scope: "", rootPath: null };
  const handle = await openWorkspace(repoKey).catch(() => null);
  return { scope: repoKey, rootPath: handle?.rootPath ?? null };
}

function describe(scope: string, config: McpServerConfig) {
  const snap = connectionSnapshot(scope, config.name);
  const t = config.transport;
  return {
    name: config.name,
    source: config.source,
    sourceLabel: SOURCE_LABEL[config.source],
    enabled: config.enabled,
    trusted: config.trusted,
    transport:
      t.type === "stdio"
        ? { type: t.type, command: t.command, args: t.args, env: redactRecord(t.env) }
        : { type: t.type, url: t.url, headers: redactRecord(t.headers) },
    status: config.enabled ? snap.status : "disabled",
    error: snap.error,
    serverInfo: snap.serverInfo,
    logLines: snap.logLines,
    tools: snap.tools.map((tool) => ({
      name: tool.name,
      qualifiedName: qualifiedToolName(config.name, tool.name),
      description: tool.description ?? tool.title ?? "",
      readOnly: tool.annotations?.readOnlyHint === true,
      destructive: tool.annotations?.destructiveHint === true,
    })),
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoKey = url.searchParams.get("repoKey") ?? "";
  const { scope, rootPath } = await workspace(repoKey);

  const logsFor = url.searchParams.get("logs");
  if (logsFor) return Response.json({ name: logsFor, logs: serverLogs(scope, logsFor) });

  const resolved = await resolveServers(scope, rootPath);
  if (url.searchParams.get("connect") === "1") {
    await Promise.all(
      resolved.servers.filter((s) => s.enabled).map((s) => ensureConnected(scope, s, rootPath)),
    );
  }
  return Response.json({
    servers: resolved.servers.map((s) => describe(scope, s)),
    files: resolved.files,
    errors: resolved.globalErrors,
    hasFolder: Boolean(rootPath),
  });
}

interface PostBody {
  action?: unknown;
  repoKey?: unknown;
  name?: unknown;
  scope?: unknown;
  config?: unknown;
}

const bad = (error: string, status = 400) => Response.json({ error }, { status });

export async function POST(request: Request) {
  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return bad("Body must be valid JSON");
  }
  const action = typeof body.action === "string" ? body.action : "";
  const repoKey = typeof body.repoKey === "string" ? body.repoKey : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const { scope, rootPath } = await workspace(repoKey);

  if (action === "add" || (action === "test" && body.config)) {
    if (!NAME_PATTERN.test(name)) {
      return bad("Name must start with a letter or digit and use letters, digits, spaces, _ . or - (max 48).");
    }
    const parsed = parseServerEntry(name, body.config, "global");
    if (typeof parsed === "string") return bad(parsed);

    if (action === "test") {
      // Probe an unsaved config under a throwaway scope, then tear it down.
      const probeScope = `probe:${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const conn = await ensureConnected(probeScope, { ...parsed, enabled: true }, rootPath);
      const result = {
        ok: conn.status === "connected",
        error: conn.error,
        tools: conn.tools.map((t) => t.name),
        logs: serverLogs(probeScope, name).slice(-40),
      };
      await disconnectServer(probeScope, name, true);
      return Response.json(result);
    }

    const raw = body.config as RawServerEntry;
    const where = body.scope === "workspace" ? "workspace" : "global";
    if (where === "workspace") {
      if (!rootPath) return bad("This workspace has no folder on disk; add the server to user settings instead.");
      const existing = (await resolveServers(scope, rootPath)).servers.find(
        (s) => s.name === name && s.source === "viberon",
      );
      if (existing) return bad(`A server named "${name}" already exists in .viberon/mcp.json.`);
      await setWorkspaceEntry(rootPath, name, raw);
      // The user added it themselves, so it does not need the
      // project-file opt-in.
      await setOverride(scope, name, { enabled: true, fingerprint: configFingerprint(parsed) });
    } else {
      if ((await getGlobalEntries())[name]) return bad(`A server named "${name}" already exists.`);
      await setGlobalEntry(name, raw);
    }
    return Response.json({ ok: true });
  }

  if (!name) return bad("name is required");
  const resolved = await resolveServers(scope, rootPath);
  const config = resolved.servers.find((s) => s.name === name);
  if (!config) return bad(`Unknown server "${name}"`, 404);

  switch (action) {
    case "update": {
      if (config.source !== "global" && config.source !== "viberon") {
        return bad(`"${name}" is defined in ${SOURCE_LABEL[config.source]}; edit it in that file.`);
      }
      if (!body.config || typeof body.config !== "object") return bad("config is required");
      const incoming = body.config as RawServerEntry;
      const raw: RawServerEntry = {
        ...incoming,
        env: keepRedactedSecrets(incoming.env, config.raw.env),
        headers: keepRedactedSecrets(incoming.headers, config.raw.headers),
      };
      if (!raw.env) delete raw.env;
      if (!raw.headers) delete raw.headers;
      const parsed = parseServerEntry(name, raw, config.source);
      if (typeof parsed === "string") return bad(parsed);
      if (config.source === "global") {
        // Keep the switches the settings UI owns.
        await setGlobalEntry(name, { ...raw, disabled: config.raw.disabled, trusted: config.raw.trusted });
      } else if (rootPath) {
        await setWorkspaceEntry(rootPath, name, raw);
        // An edit the user made is as good as the opt-in they gave before.
        await setOverride(scope, name, { enabled: config.enabled, fingerprint: configFingerprint(parsed) });
      }
      await disconnectServer(scope, name, true);
      return Response.json({ ok: true });
    }
    case "remove": {
      if (config.source === "global") {
        await setGlobalEntry(name, null);
      } else if (config.source === "viberon" && rootPath) {
        await setWorkspaceEntry(rootPath, name, null);
        await setOverride(scope, name, null);
      } else {
        return bad(`"${name}" is defined in ${SOURCE_LABEL[config.source]}; remove it from that file.`);
      }
      await disconnectServer(scope, name, true);
      return Response.json({ ok: true });
    }
    case "enable":
    case "disable": {
      const enabled = action === "enable";
      if (config.source === "global") {
        const entries = await getGlobalEntries();
        await setGlobalEntry(name, { ...entries[name], disabled: !enabled });
      } else {
        await setOverride(scope, name, { enabled, fingerprint: configFingerprint(config) });
      }
      if (!enabled) await disconnectServer(scope, name);
      return Response.json({ ok: true });
    }
    case "trust":
    case "untrust": {
      const trusted = action === "trust";
      if (config.source === "global") {
        const entries = await getGlobalEntries();
        await setGlobalEntry(name, { ...entries[name], trusted });
      } else {
        await setOverride(scope, name, { trusted, fingerprint: configFingerprint(config) });
      }
      return Response.json({ ok: true });
    }
    case "restart":
    case "test": {
      if (!config.enabled) return bad(`"${name}" is disabled. Enable it first.`);
      const conn =
        action === "restart"
          ? await restartServer(scope, config, rootPath)
          : await ensureConnected(scope, config, rootPath);
      return Response.json({
        ok: conn.status === "connected",
        error: conn.error,
        server: describe(scope, config),
      });
    }
    default:
      return bad(`Unknown action "${action}"`);
  }
}

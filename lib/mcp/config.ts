/**
 * MCP server configuration: parsing, env expansion, and merging.
 *
 * Viberon reads the same schema Claude Code and Cursor use, so a project that
 * already ships an `.mcp.json` works without edits:
 *
 *   { "mcpServers": { "name": { "command", "args", "env" } | { "url", "headers" } } }
 *
 * Sources, highest precedence first (a name defined twice keeps the first):
 *
 *   1. `.viberon/mcp.json`   — Viberon's own project file
 *   2. `.mcp.json`           — Claude Code project scope
 *   3. `.cursor/mcp.json`    — Cursor project scope
 *   4. the user-global list  — stored server-side in the settings store
 *
 * Everything in this file is pure (no fs, no network) so it can be tested
 * directly; `readWorkspaceMcpFiles` is the only function that touches disk.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

export type McpSource = "viberon" | "claude" | "cursor" | "global";

export const WORKSPACE_CONFIG_FILES: { source: McpSource; file: string }[] = [
  { source: "viberon", file: ".viberon/mcp.json" },
  { source: "claude", file: ".mcp.json" },
  { source: "cursor", file: ".cursor/mcp.json" },
];

export type McpTransportConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      cwd?: string;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers: Record<string, string>;
    };

/** The raw per-server entry as it appears in an mcp.json file. */
export interface RawServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Viberon extensions — ignored by other clients. */
  disabled?: boolean;
  trusted?: boolean;
  timeout?: number;
}

export interface McpServerConfig {
  name: string;
  source: McpSource;
  transport: McpTransportConfig;
  /** Whether the server may be launched at all. */
  enabled: boolean;
  /** Trusted servers skip the per-call approval prompt under "ask". */
  trusted: boolean;
  /** Per-call timeout in ms. */
  timeoutMs: number;
  /** Raw entry, kept so the UI can show exactly what was configured. */
  raw: RawServerEntry;
}

export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

export interface ParseResult {
  servers: McpServerConfig[];
  errors: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function stringRecord(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v)) {
    if (typeof value === "string") out[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
  }
  return out;
}

/** Validate one server entry. Returns an error string on failure. */
export function parseServerEntry(
  name: string,
  entry: unknown,
  source: McpSource,
): McpServerConfig | string {
  if (!isRecord(entry)) return `${name}: entry must be an object`;
  const raw = entry as RawServerEntry;
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : undefined;
  const timeoutMs =
    typeof raw.timeout === "number" && raw.timeout > 0
      ? Math.min(raw.timeout, 10 * 60_000)
      : DEFAULT_CALL_TIMEOUT_MS;

  let transport: McpTransportConfig;
  if (typeof raw.url === "string" && raw.url.trim() && type !== "stdio") {
    transport = {
      type: type === "sse" ? "sse" : "http",
      url: raw.url.trim(),
      headers: stringRecord(raw.headers),
    };
  } else if (typeof raw.command === "string" && raw.command.trim()) {
    transport = {
      type: "stdio",
      command: raw.command.trim(),
      args: Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : [],
      env: stringRecord(raw.env),
      ...(typeof raw.cwd === "string" && raw.cwd ? { cwd: raw.cwd } : {}),
    };
  } else {
    return `${name}: needs either "command" (stdio) or "url" (HTTP)`;
  }

  return {
    name,
    source,
    transport,
    enabled: raw.disabled !== true,
    // A repo file must never grant itself trust: `trusted` is honoured only
    // for the user's own global list. Workspace servers are trusted solely
    // through a per-workspace user decision (see `applyOverrides`).
    trusted: source === "global" && raw.trusted === true,
    timeoutMs,
    raw,
  };
}

/** Parse an mcp.json document (already JSON-decoded or as text). */
export function parseMcpConfig(input: unknown, source: McpSource): ParseResult {
  let doc = input;
  const errors: string[] = [];
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (error) {
      return {
        servers: [],
        errors: [`invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
      };
    }
  }
  if (!isRecord(doc)) return { servers: [], errors: ["config must be a JSON object"] };

  // Accept both `{ mcpServers: {...} }` and VS Code's `{ servers: {...} }`.
  const map = isRecord(doc.mcpServers) ? doc.mcpServers : isRecord(doc.servers) ? doc.servers : null;
  if (!map) return { servers: [], errors: [] };

  const servers: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(map)) {
    if (!name.trim()) continue;
    const parsed = parseServerEntry(name.trim(), entry, source);
    if (typeof parsed === "string") errors.push(parsed);
    else servers.push(parsed);
  }
  return { servers, errors };
}

/**
 * Merge lists in precedence order. The first definition of a name wins, so
 * a project can shadow a user-global server with its own configuration.
 */
export function mergeServerLists(...lists: McpServerConfig[][]): McpServerConfig[] {
  const seen = new Map<string, McpServerConfig>();
  for (const list of lists) {
    for (const server of list) {
      if (!seen.has(server.name)) seen.set(server.name, server);
    }
  }
  return [...seen.values()];
}

/** Per-workspace user decisions layered on top of file-defined servers. */
export interface ServerOverride {
  enabled?: boolean;
  trusted?: boolean;
  /**
   * `configFingerprint` of the workspace server when the user decided. If
   * the file later changes what the server runs (a pull, an agent edit),
   * the decision no longer applies and the server is disabled again.
   */
  fingerprint?: string;
}

/**
 * Project files are code from whoever wrote the repo; launching an
 * arbitrary command because a cloned repo asked for it is how you get owned.
 * So servers from workspace files start disabled until the user enables
 * them once (the decision is remembered per workspace). Global servers were
 * added by the user and start enabled. An explicit `disabled` in a file is
 * always respected.
 */
export function applyOverrides(
  servers: McpServerConfig[],
  overrides: Record<string, ServerOverride>,
): McpServerConfig[] {
  return servers.map((server) => {
    const fromWorkspace = server.source !== "global";
    let o = overrides[server.name] ?? {};
    if (fromWorkspace && o.fingerprint !== configFingerprint(server)) o = {};
    const defaultEnabled = fromWorkspace ? false : server.enabled;
    return {
      ...server,
      enabled: server.raw.disabled === true ? false : (o.enabled ?? defaultEnabled),
      trusted: fromWorkspace ? o.trusted === true : (o.trusted ?? server.trusted),
    };
  });
}

/* ----------------------------- env expansion ------------------------------ */

/**
 * Expand `${VAR}` and `${VAR:-default}` against `env`. Unset variables with
 * no default expand to "" and are reported through `missing`, so the UI can
 * say which variable a server is waiting for instead of failing opaquely.
 */
export function expandEnv(
  value: string,
  env: Record<string, string | undefined>,
  missing?: Set<string>,
): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      missing?.add(name);
      return "";
    },
  );
}

/** Expand every string field of a transport config. */
export function expandTransport(
  transport: McpTransportConfig,
  env: Record<string, string | undefined>,
  missing?: Set<string>,
): McpTransportConfig {
  const x = (s: string) => expandEnv(s, env, missing);
  const mapValues = (r: Record<string, string>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, x(v)]));
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: x(transport.command),
      args: transport.args.map(x),
      env: mapValues(transport.env),
      ...(transport.cwd ? { cwd: x(transport.cwd) } : {}),
    };
  }
  return { type: transport.type, url: x(transport.url), headers: mapValues(transport.headers) };
}

/**
 * A stable fingerprint of the connection-relevant parts of a config. A
 * pooled connection whose fingerprint no longer matches is stale.
 */
export function configFingerprint(config: McpServerConfig): string {
  return JSON.stringify(config.transport);
}

/**
 * Hide secrets before a config crosses to the browser. `${VAR}` references
 * are shown as-is (they are names, not values); literal values are masked.
 */
export function redactRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      /^\$\{[^}]+\}$/.test(value) ? value : value.length <= 4 ? "••••" : `${value.slice(0, 2)}••••`,
    ]),
  );
}

/**
 * An edited config comes back from the browser with the redacted values it
 * was shown. Keep the stored secret for every value still in redacted form.
 */
export function keepRedactedSecrets(
  next: Record<string, string> | undefined,
  previous: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!next) return next;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(next)) {
    out[key] = value.includes("••••") && previous?.[key] !== undefined ? previous[key]! : value;
  }
  return out;
}

/* --------------------------------- disk ----------------------------------- */

export interface WorkspaceConfigRead {
  servers: McpServerConfig[];
  /** Files that exist, with their parse errors (if any). */
  files: { file: string; source: McpSource; errors: string[]; count: number }[];
}

export async function readWorkspaceMcpFiles(rootPath: string): Promise<WorkspaceConfigRead> {
  const lists: McpServerConfig[][] = [];
  const files: WorkspaceConfigRead["files"] = [];
  for (const { source, file } of WORKSPACE_CONFIG_FILES) {
    let text: string;
    try {
      text = await readFile(path.join(rootPath, file), "utf8");
    } catch {
      continue;
    }
    const parsed = parseMcpConfig(text, source);
    lists.push(parsed.servers);
    files.push({ file, source, errors: parsed.errors, count: parsed.servers.length });
  }
  return { servers: mergeServerLists(...lists), files };
}

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, str } from "./util";

/**
 * Everything this plugin needs from the daemon host: where `$PASEO_HOME` is, how to reach the session
 * protocol, and the one listing the cleanup works from. Merged from three modules — the home/config
 * helpers, the websocket client and the agent listing — because the cleanup is their only caller.
 */

declare const require: ((specifier: string) => unknown) | undefined;

const DEFAULT_LISTEN = "127.0.0.1:6767";
const CLIENT_MODULE = "@getpaseo/client/internal/daemon-client";
const CLIENT_ID_PREFIX = "agent-manager-";
/** 0.12 hides background workspaces from public discovery unless asked; archived agents live there. */
const LIST_FILTER = { includeArchived: true, includeBackground: true };
const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".paseo");
}

/** The fields of an agent this plugin acts on. Everything else in the record is ignored. */
export interface AgentRecord {
  id: string;
  provider: string | null;
  workspaceId: string | null;
  archivedAt: string | null;
  cwd: string | null;
}

interface DaemonClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchAgents(options: {
    filter: typeof LIST_FILTER;
    sort: Array<{ key: string; direction: string }>;
    page: { limit: number; cursor?: string };
  }): Promise<{ entries?: unknown; pageInfo?: unknown }>;
}

type DaemonClientConstructor = new (config: Record<string, unknown>) => DaemonClient;

let pendingClient: Promise<DaemonClient> | null = null;

/** Every agent the daemon knows, archived and background included, in one paged listing. */
export async function listAgents(): Promise<AgentRecord[]> {
  const client = await getDaemonClient();
  const agents: AgentRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.fetchAgents({
      filter: LIST_FILTER,
      sort: [{ key: "updated_at", direction: "desc" }],
      page: cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE },
    });
    const batch = Array.isArray(result?.entries) ? result.entries : [];
    for (const entry of batch) {
      const agent = toAgentRecord((entry as { agent?: RawAgent })?.agent);
      if (agent) {
        agents.push(agent);
      }
    }
    const next = nextCursor(result?.pageInfo);
    if (!next || batch.length === 0) {
      break;
    }
    cursor = next;
  }
  return agents;
}

/**
 * One lazily created connection, kept for the lifetime of the plugin and closed when it unloads. The
 * daemon rotates its local credential on every start, so the client re-reads it per connect attempt
 * and can never be locked out by a daemon restart.
 */
export async function getDaemonClient(): Promise<DaemonClient> {
  if (!pendingClient) {
    pendingClient = createDaemonClient();
  }
  try {
    return await pendingClient;
  } catch (error) {
    pendingClient = null;
    throw error;
  }
}

export async function disposeDaemonClient(): Promise<void> {
  const pending = pendingClient;
  pendingClient = null;
  if (!pending) {
    return;
  }
  try {
    await (await pending).close();
  } catch {
    // Already gone: nothing to release.
  }
}

interface RawAgent {
  id?: unknown;
  provider?: unknown;
  workspaceId?: unknown;
  archivedAt?: unknown;
  cwd?: unknown;
}

function toAgentRecord(raw: RawAgent | undefined): AgentRecord | null {
  const id = str(raw?.id);
  if (!raw || !id) {
    return null;
  }
  return {
    id,
    provider: str(raw.provider),
    workspaceId: str(raw.workspaceId),
    archivedAt: str(raw.archivedAt),
    cwd: str(raw.cwd),
  };
}

function nextCursor(pageInfo: unknown): string | undefined {
  if (!pageInfo || typeof pageInfo !== "object") {
    return undefined;
  }
  const cursor = (pageInfo as { nextCursor?: unknown }).nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

async function createDaemonClient(): Promise<DaemonClient> {
  const config = await readDaemonConfig();
  const address = resolveDaemonAddress(config.listen);
  if (!address) {
    throw new Error(
      "The daemon websocket address is unavailable. Set daemon.listen to a host:port value in the Paseo config.",
    );
  }
  const password = process.env.PASEO_PASSWORD?.trim() || null;
  const DaemonClient = loadDaemonClientConstructor();
  const client = new DaemonClient({
    url: `ws://${address.host}:${address.port}/ws`,
    clientId: `${CLIENT_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    clientType: "cli",
    localCredential: readLocalCredential,
    appVersion: config.version ?? undefined,
    ...(password ? { password } : {}),
    connectTimeoutMs: 15_000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 8000 },
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`${describe(error)} (${describeAuthHint(password)})`);
  }
  return client;
}

/**
 * The daemon persists only a bcrypt hash, which cannot be replayed, so the loopback credential file
 * is the usable secret. It is rotated on every daemon start, hence a function rather than a value.
 */
function readLocalCredential(): string | null {
  const override = process.env.PASEO_AGENT_MANAGER_LOCAL_CREDENTIAL?.trim();
  if (override) {
    return override;
  }
  try {
    const token = readFileSync(join(paseoHome(), "local-credential"), "utf8").trim();
    return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function describeAuthHint(password: string | null): string {
  if (password) {
    return "authenticated with PASEO_PASSWORD";
  }
  return readLocalCredential()
    ? "authenticated with the local credential file"
    : "no local credential file found: check that $PASEO_HOME/local-credential exists and matches the running daemon";
}

/** The two `config.json` fields the client needs; a missing or unreadable file is not an error. */
async function readDaemonConfig(): Promise<{ listen: string | null; version: string | null }> {
  try {
    const parsed = JSON.parse(await readFile(join(paseoHome(), "config.json"), "utf8")) as {
      version?: unknown;
      daemon?: { listen?: unknown };
    };
    return { listen: str(parsed.daemon?.listen), version: str(parsed.version) };
  } catch {
    return { listen: null, version: null };
  }
}

/** `daemon.listen`, with the loopback default and `0.0.0.0` mapped to 127.0.0.1. */
function resolveDaemonAddress(configured: string | null): { host: string; port: string } | null {
  const listen = configured ?? DEFAULT_LISTEN;
  if (listen.startsWith("/") || listen.startsWith(".")) {
    return null;
  }
  const [host, port] = listen.replace(/^https?:\/\//, "").replace(/\/+$/, "").split(":");
  if (!host || !port || !/^\d+$/.test(port)) {
    return null;
  }
  const loopback = host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::0";
  return { host: loopback ? "127.0.0.1" : host, port };
}

/**
 * The daemon's own client, resolved from the plugin runtime. The 0.13 module path is tried first
 * through the entry point's require, then through the runtime require.
 */
function loadDaemonClientConstructor(): DaemonClientConstructor {
  const failure: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    try {
      const required = createRequire(entry)(CLIENT_MODULE) as { DaemonClient?: unknown };
      if (typeof required?.DaemonClient === "function") {
        return required.DaemonClient as DaemonClientConstructor;
      }
      failure.push("the module has no DaemonClient export");
    } catch (error) {
      failure.push(describe(error));
    }
  }
  try {
    const required = runtimeRequire(CLIENT_MODULE) as { DaemonClient?: unknown } | undefined;
    if (required && typeof required.DaemonClient === "function") {
      return required.DaemonClient as DaemonClientConstructor;
    }
    failure.push("the runtime copy has no DaemonClient export");
  } catch (error) {
    failure.push(describe(error));
  }
  throw new Error(`Cannot reach the daemon session protocol: ${failure.join("; ")}`);
}

function runtimeRequire(specifier: string): unknown {
  if (typeof require !== "function") {
    throw new Error("The plugin runtime require is unavailable");
  }
  return require(specifier);
}

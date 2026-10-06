import { createRequire } from "node:module";

import { readDaemonConfig, readLocalCredential, resolveDaemonAddress } from "./daemon-mcp";
import { describe } from "./util";

declare const require: ((specifier: string) => unknown) | undefined;

const CLIENT_MODULE = "@getpaseo/client/internal/daemon-client";
const CLIENT_ID_PREFIX = "agent-manager-";

export interface WorkspaceRecoveryState {
  kind: string;
  action?: string;
  reason?: string;
  message?: string;
  workspaceName?: string;
  branch?: string | null;
}

export interface DaemonSessionClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchAgents(options?: {
    filter?: { includeArchived?: boolean };
    page?: { limit?: number; cursor?: string };
  }): Promise<{ entries?: unknown }>;
  restoreWorkspace(workspaceId: string, requestId?: string): Promise<void>;
  setWorkspaceTitle(
    workspaceId: string,
    title: string | null,
    requestId?: string,
  ): Promise<{ title: string | null }>;
  inspectWorkspaceRecovery(workspaceId: string, requestId?: string): Promise<WorkspaceRecoveryState>;
  refreshAgent(agentId: string, requestId?: string): Promise<unknown>;
  closeItems(input: { agentIds: string[]; terminalIds: string[] }): Promise<unknown>;
  getDaemonStatus(options?: unknown): Promise<{ serverId?: unknown }>;
  addProject(cwd: string, requestId?: string): Promise<{ project?: { projectId?: unknown } | null; error?: unknown }>;
  archiveWorkspace(workspaceId: string, requestId?: string): Promise<unknown>;
  getCheckoutStatus(
    cwd: string,
    options?: { requestId?: string },
  ): Promise<{
    git?: { isDirty?: unknown; aheadOfOrigin?: unknown } | null;
    forge?: { pullRequest?: { isMerged?: unknown; url?: unknown } | null } | null;
  } | null>;
  listTerminals(
    cwd?: string,
    requestId?: string,
    options?: { workspaceId?: string },
  ): Promise<{ terminals?: Array<Record<string, unknown>> }>;
  killTerminal(terminalId: string, requestId?: string): Promise<unknown>;
}

/**
 * Registers a project for a directory and returns its id. Used when a workspace request carries no
 * projectId, so the workspace is not filed under a project built from the worktree path.
 */
export async function registerProject(cwd: string): Promise<string | null> {
  try {
    const client = await getDaemonClient();
    const payload = await client.addProject(cwd);
    const projectId = payload?.project?.projectId;
    return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
  } catch {
    return null;
  }
}

let cachedServerId: string | null = null;

export async function resolveServerId(): Promise<string | null> {
  if (cachedServerId) {
    return cachedServerId;
  }
  try {
    const client = await getDaemonClient();
    const status = await client.getDaemonStatus();
    const serverId = typeof status?.serverId === "string" ? status.serverId.trim() : "";
    if (serverId) {
      cachedServerId = serverId;
      return serverId;
    }
  } catch {
    return null;
  }
  return null;
}

interface DaemonClientConstructor {
  new (config: Record<string, unknown>): DaemonSessionClient;
}

// One lazily created connection, kept for the lifetime of the plugin and closed when it unloads.
// It used to be reference-counted and closed after three idle minutes, which stopped meaning
// anything once the sweep started running every minute: the close timer was re-armed before it
// could fire, so the connection was resident anyway. Two files (this one, and the sweep) had to
// keep the count straight for no benefit, so the count is gone.
let pendingClient: Promise<DaemonSessionClient> | null = null;

export async function getDaemonClient(): Promise<DaemonSessionClient> {
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
    const client = await pending;
    await client.close();
  } catch {
    return;
  }
}

async function createDaemonClient(): Promise<DaemonSessionClient> {
  const address = await resolveDaemonAddress();
  if (!address) {
    throw new Error(
      "The daemon websocket address is unavailable. Set daemon.listen to a host:port value in the Paseo config.",
    );
  }
  const DaemonClient = loadDaemonClientConstructor();
  const config = await readDaemonConfig();
  const password = config.password;
  const client = new DaemonClient({
    url: `ws://${address.host}:${address.port}/ws`,
    clientId: `${CLIENT_ID_PREFIX}${randomSuffix()}`,
    clientType: "cli",
    // Preferred: the loopback credential the daemon rotates on every start. It is read
    // again for each connection attempt, so a daemon restart (or a daemon password) can
    // never lock this plugin out of the session protocol. Falls back to PASEO_PASSWORD.
    localCredential: readLocalCredential,
    appVersion: config.version ?? undefined,
    ...(password ? { password } : {}),
    connectTimeoutMs: 15000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 8000 },
  });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(`${describe(error)} (${describeAuthHint(password)})`);
  }
  return client;
}

function describeAuthHint(password: string | null): string {
  if (password) {
    return "authenticated with PASEO_PASSWORD";
  }
  return readLocalCredential()
    ? "authenticated with the local credential file"
    : "no local credential file found: check that $PASEO_HOME/local-credential exists and matches the running daemon";
}

function loadDaemonClientConstructor(): DaemonClientConstructor {
  const failure: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    try {
      const required = createRequire(entry)(CLIENT_MODULE) as { DaemonClient?: unknown };
      const constructor = required?.DaemonClient;
      if (typeof constructor === "function") {
        return constructor as DaemonClientConstructor;
      }
      failure.push("the module has no DaemonClient export");
    } catch (error) {
      failure.push(describe(error));
    }
  }
  try {
    const constructor = runtimeRequire(CLIENT_MODULE) as { DaemonClient?: unknown } | undefined;
    if (constructor && typeof constructor.DaemonClient === "function") {
      return constructor.DaemonClient as DaemonClientConstructor;
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

function randomSuffix(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

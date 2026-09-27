import { createRequire } from "node:module";

import { readDaemonConfig, resolveDaemonAddress } from "./daemon-mcp";
import { describe } from "./util";

declare const require: ((specifier: string) => unknown) | undefined;

const CLIENT_MODULE = "@getpaseo/client/internal/daemon-client";
const CLIENT_ID_PREFIX = "agent-manager-";
const DEFAULT_IDLE_CLOSE_MS = 180000;

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
    page?: { limit?: number };
  }): Promise<{ entries?: unknown }>;
  restoreWorkspace(workspaceId: string, requestId?: string): Promise<void>;
  inspectWorkspaceRecovery(workspaceId: string, requestId?: string): Promise<WorkspaceRecoveryState>;
  refreshAgent(agentId: string, requestId?: string): Promise<unknown>;
  closeItems(input: { agentIds: string[]; terminalIds: string[] }): Promise<unknown>;
}

interface DaemonClientConstructor {
  new (config: Record<string, unknown>): DaemonSessionClient;
}

let pendingClient: Promise<DaemonSessionClient> | null = null;
let activeUses = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export function beginDaemonClientUse(): void {
  activeUses += 1;
  cancelIdleClose();
}

export function endDaemonClientUse(): void {
  activeUses = Math.max(0, activeUses - 1);
  if (activeUses > 0) {
    return;
  }
  cancelIdleClose();
  const timeout = idleCloseMs();
  if (timeout <= 0) {
    return;
  }
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (activeUses === 0) {
      void disposeDaemonClient();
    }
  }, timeout);
}

function cancelIdleClose(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function idleCloseMs(): number {
  const raw = process.env.PASEO_AGENT_MANAGER_CLIENT_IDLE_MS;
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_IDLE_CLOSE_MS;
  }
  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_IDLE_CLOSE_MS;
}

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
  cancelIdleClose();
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
  const password = process.env.PASEO_PASSWORD?.trim() || config.password;
  const client = new DaemonClient({
    url: `ws://${address.host}:${address.port}/ws`,
    clientId: `${CLIENT_ID_PREFIX}${randomSuffix()}`,
    clientType: "cli",
    appVersion: config.version ?? undefined,
    ...(password ? { password } : {}),
    connectTimeoutMs: 15000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 8000 },
  });
  await client.connect();
  return client;
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

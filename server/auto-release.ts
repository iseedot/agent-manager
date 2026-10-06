import { join } from "node:path";

import { readFile, readdir } from "node:fs/promises";

import { listAllAgents, type AgentRecord } from "./agents";
import {
  beginDaemonClientUse,
  endDaemonClientUse,
  getDaemonClient,
  type DaemonSessionClient,
} from "./daemon-client";
import { releaseAgents } from "./actions";
import type { AutoReleaseStatus } from "../shared/contracts";
import { paseoHome } from "./daemon-mcp";
import { fireAndForget } from "./guard";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";
import { deleteWorkspace, listWorkspaceRows } from "./workspaces";
import type { PaseoLike } from "./agents";

interface AutoReleaseSnapshot {
  lastRunAt: string | null;
  lastReleased: Array<{ agentId: string; title: string | null }>;
  lastRemovedWorkspaces: Array<{ workspaceId: string; name: string | null }>;
  lastSkipped: number;
  lastError: string | null;
  nextRunAt: string | null;
}

// The aggressive profile: one minute of idleness instead of ten, and a one-minute safety sweep
// instead of a fifteen-minute one. Both stay fixed at runtime (no UI switch) but can be dialed back
// without a code edit: PASEO_AGENT_MANAGER_IDLE_MINUTES (>= 1), PASEO_AGENT_MANAGER_SWEEP_INTERVAL_MS.
const STATE_PATH = "agent-manager/auto-release.json";
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_IDLE_MINUTES = 1;
const MIN_SWEEP_INTERVAL_MS = 5000;
const DEFAULT_STATE: AutoReleaseSnapshot = {
  lastRunAt: null,
  lastReleased: [],
  lastRemovedWorkspaces: [],
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
};

let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let dueTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
/** Latest sweep result plus the armed due timer — what the pill shows next to the host stats. */
let status: AutoReleaseStatus | null = null;

function publishStatus(next: AutoReleaseStatus): void {
  status = next;
}

function envNumber(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

/** The release window in minutes — the number the pill shows. */
export function idleMinutes(): number {
  return envNumber("PASEO_AGENT_MANAGER_IDLE_MINUTES", DEFAULT_IDLE_MINUTES, 1);
}

function sweepIntervalMs(): number {
  return envNumber("PASEO_AGENT_MANAGER_SWEEP_INTERVAL_MS", DEFAULT_SWEEP_INTERVAL_MS, MIN_SWEEP_INTERVAL_MS);
}

/**
 * The auto-release numbers for the pill: last sweep, next scheduled sweep, and the release a due
 * timer is waiting for. Read from memory when the plugin has swept, else from the state file.
 */
export async function readAutoReleaseStatus(): Promise<AutoReleaseStatus> {
  if (status) {
    return { ...status, running };
  }
  const stored = { ...DEFAULT_STATE, ...(await readStoredState()) };
  return {
    lastRunAt: stored.lastRunAt,
    released: stored.lastReleased.length,
    skipped: stored.lastSkipped,
    removedWorkspaces: stored.lastRemovedWorkspaces.length,
    error: stored.lastError,
    nextRunAt: stored.nextRunAt,
    dueAt: null,
    running,
    idleMinutes: idleMinutes(),
  };
}

export function startAutoReleaseScheduler(): () => void {
  if (fallbackTimer) {
    return () => {};
  }
  fallbackTimer = setInterval(() => {
    fireAndForget(scheduledSweep(), "scheduled sweep");
  }, sweepIntervalMs());
  fireAndForget(seedStatusThenSweep(), "initial sweep");
  return () => {
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
    clearDueTimer();
  };
}

async function seedStatusThenSweep(): Promise<void> {
  publishStatus(await readAutoReleaseStatus());
  await scheduledSweep();
}

function clearDueTimer(): void {
  if (dueTimer) {
    clearTimeout(dueTimer);
    dueTimer = null;
  }
}

async function scheduledSweep(): Promise<void> {
  await sweep();
}

function blocksRelease(agent: { attentionReason?: unknown; pendingPermissions?: unknown } | null | undefined): boolean {
  if (str(agent?.attentionReason) === "permission") {
    return true;
  }
  const pending = agent?.pendingPermissions;
  const pendingCount = Array.isArray(pending) ? pending.length : typeof pending === "number" ? pending : 0;
  return pendingCount > 0;
}

async function sweep(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (running) {
    return;
  }
  running = true;
  beginDaemonClientUse();
  const released: Array<{ agentId: string; title: string | null }> = [];
  let skipped = 0;
  let error: string | null = null;
  let nextDueAt: number | null = null;
  try {
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const threshold = idleMinutes() * 60000;
    const now = Date.now();
    for (const agent of agents) {
      if (agent.archivedAt !== null || agent.status === "closed") {
        continue;
      }
      // A runtime that is still starting up is never a release candidate: at a one-minute window a
      // slow provider boot would otherwise be killed half-way through initialization.
      if (agent.status === "running" || agent.status === "initializing" || blocksRelease(agent)) {
        if (agent.status !== "running") {
          skipped += 1;
        }
        continue;
      }
      const lastActivity = await resolveLastActivityAt(agent);
      const dueAt = (lastActivity ?? now) + threshold;
      if (dueAt <= now) {
        const result = await releaseIdleAgent(agent.id, agents);
        if (result === "released") {
          released.push({ agentId: agent.id, title: agent.title });
        } else if (result === "skipped") {
          skipped += 1;
        } else {
          error = result;
        }
        continue;
      }
      nextDueAt = nextDueAt === null ? dueAt : Math.min(nextDueAt, dueAt);
    }
  } catch (sweepError) {
    error = describe(sweepError);
  } finally {
    endDaemonClientUse();
    running = false;
  }

  let removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    removed = await removeEmptyWorkspaces();
  } catch (removalError) {
    error = describe(removalError);
  }

  const finished = await recordRun(state, released, removed, skipped, error).catch(
    (recordError) => {
      console.log(`agent-manager could not record the sweep: ${describe(recordError)}`);
      return null;
    },
  );
  publishStatus({
    lastRunAt: finished?.lastRunAt ?? new Date().toISOString(),
    released: released.length,
    skipped,
    removedWorkspaces: removed.length,
    error,
    nextRunAt: finished?.nextRunAt ?? null,
    dueAt: nextDueAt === null ? null : new Date(nextDueAt).toISOString(),
    running: false,
    idleMinutes: idleMinutes(),
  });
  armNextDue(nextDueAt);
}

function armNextDue(dueAt: number | null): void {
  clearDueTimer();
  if (dueAt === null) {
    return;
  }
  dueTimer = setTimeout(() => {
    dueTimer = null;
    fireAndForget(scheduledSweep(), "due sweep");
  }, Math.max(1000, dueAt - Date.now()));
}

async function releaseIdleAgent(agentId: string, known?: AgentRecord[]): Promise<"released" | "skipped" | string> {
  try {
    const client = await getDaemonClient();
    const current = known?.find((agent) => agent.id === agentId) ?? (await fetchAgent(client, agentId));
    if (!current || current.status === "running" || current.status === "initializing" || current.status === "closed") {
      return "skipped";
    }
    if (blocksRelease(current) || current.archivedAt !== null) {
      return "skipped";
    }
    // The daemon's close action (MCP kill_agent), with a SIGTERM fallback plus a /proc
    // re-check when the MCP route is unavailable (e.g. a password-protected daemon
    // without PASEO_PASSWORD).
    const outcome = await releaseAgents([agentId]);
    if (outcome.released.includes(agentId)) {
      return "released";
    }
    return outcome.failed.find((entry) => entry.agentId === agentId)?.error ?? "skipped";
  } catch (error) {
    return describe(error);
  }
}

async function fetchAgent(client: DaemonSessionClient, agentId: string): Promise<AgentRecord | null> {
  const agents = await listAllAgents((options) => client.fetchAgents(options as never)).catch(() => []);
  return agents.find((agent) => agent.id === agentId) ?? null;
}

async function removeEmptyWorkspaces(): Promise<Array<{ workspaceId: string; name: string | null }>> {
  const removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    const rows = await listWorkspaceRows();
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const busy = new Set(agents.map((agent) => agent.workspaceId).filter((id): id is string => id !== null));
    const paseo: PaseoLike = {
      agents: { list: (options) => client.fetchAgents(options as never) },
    };
    for (const row of rows) {
      if (row.archivedAt === null || busy.has(row.workspaceId)) {
        continue;
      }
      const result = await deleteWorkspace(paseo, row.workspaceId).catch(() => null);
      if (result?.ok) {
        removed.push({ workspaceId: row.workspaceId, name: row.name });
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

async function recordRun(
  state: AutoReleaseSnapshot,
  released: Array<{ agentId: string; title: string | null }>,
  removedWorkspaces: Array<{ workspaceId: string; name: string | null }>,
  skipped: number,
  error: string | null,
): Promise<AutoReleaseSnapshot> {
  const finishedAt = new Date().toISOString();
  const finished = withDerived({
    ...state,
    lastRunAt: finishedAt,
    lastReleased: released,
    lastRemovedWorkspaces: removedWorkspaces,
    lastSkipped: skipped,
    lastError: error,
  });
  await writeState(finished);
  return finished;
}

function withDerived(state: AutoReleaseSnapshot): AutoReleaseSnapshot {
  const parsed = Date.parse(state.lastRunAt ?? "");
  const anchor = Number.isFinite(parsed) ? parsed : Date.now();
  return { ...state, nextRunAt: new Date(anchor + sweepIntervalMs()).toISOString() };
}

async function resolveLastActivityAt(agent: AgentRecord): Promise<number | null> {
  const recordPath = await findRecordPath(agent.cwd, agent.id);
  return readLastActivity(recordPath, agent.updatedAt);
}

async function readLastActivity(recordPath: string | null, fallback: string | null): Promise<number | null> {
  if (recordPath) {
    try {
      const parsed = JSON.parse(await readFile(recordPath, "utf8")) as { lastActivityAt?: unknown };
      const parsedMs = Date.parse(str(parsed.lastActivityAt) ?? "");
      if (Number.isFinite(parsedMs)) {
        return parsedMs;
      }
    } catch {
      // Not evidence of idleness: fall through to the daemon's stamp, which a one-minute window
      // would otherwise act on at once.
    }
  }
  const updatedMs = Date.parse(fallback ?? "");
  return Number.isFinite(updatedMs) ? updatedMs : null;
}

async function findRecordPath(cwd: string | null, agentId: string): Promise<string | null> {
  if (cwd) {
    const slug = cwd.replace(/^\/+/, "").replace(/\/+/g, "-");
    const candidate = join(paseoHome(), "agents", slug, `${agentId}.json`);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  const root = join(paseoHome(), "agents");
  try {
    for (const entry of await readdir(root)) {
      const candidate = join(root, entry, `${agentId}.json`);
      if (await exists(candidate)) {
        return candidate;
      }
    }
  } catch {
    return null;
  }
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function readStoredState(): Promise<Partial<AutoReleaseSnapshot>> {
  try {
    const raw = await readFile(join(paseoHome(), STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as Partial<AutoReleaseSnapshot>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state: AutoReleaseSnapshot): Promise<void> {
  const payload = Object.fromEntries(
    Object.entries(state).filter(([key]) => key in DEFAULT_STATE),
  ) as AutoReleaseSnapshot;
  return serializeWrite(() => writeJsonAtomic(join(paseoHome(), STATE_PATH), payload));
}


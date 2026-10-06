import { join } from "node:path";

import { readFile } from "node:fs/promises";

import { archiveMergedWorktrees } from "./auto-archive";
import { listAllAgents, type AgentRecord } from "./agents";
import { getDaemonClient, type DaemonSessionClient } from "./daemon-client";
import { releaseAgents } from "./actions";
import type { AutoReleaseStatus } from "../shared/contracts";
import { paseoHome } from "./daemon-mcp";
import { fireAndForget } from "./guard";
import { autoReleaseConfig, awaitAutoReleaseSettings, type AutoReleaseConfig } from "./settings";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";
import { deleteWorkspace, listWorkspaceRows, purgeArchivedWorkspaces } from "./workspaces";
import type { PaseoLike } from "./agents";

type CleanupMode = "empty" | "purge";

interface AutoReleaseSnapshot {
  lastRunAt: string | null;
  lastReleased: Array<{ agentId: string; title: string | null }>;
  lastRemovedWorkspaces: Array<{ workspaceId: string; name: string | null }>;
  lastSkipped: number;
  lastError: string | null;
  nextRunAt: string | null;
  lastCleanupAt: string | null;
  lastCleanupMode: CleanupMode | null;
  lastCleanupSessions: boolean | null;
  lastDeletedSessions: number;
}

// One timer runs the whole plugin, and one tick does three things:
//   1. release every runtime that is neither working nor waiting on the user — there is no idle
//      window, so the tick is the resolution, and the grace setting keeps a turn that ended seconds
//      ago from being released on the tick it lands on;
//   2. every so often (a day by default), drop archived workspaces. Either only the ones with no
//      session records left, or — when the host turns the purge on — every archived workspace, its
//      sessions and, for pi, the provider's own transcript with them;
//   3. apply Paseo's "a merged change request archives the worktree" rule to the project-local
//      worktrees, which are the plugin's own and therefore invisible to Paseo.
// The numbers and switches come from the plugin settings (host scope) with the environment as an
// operator override; see shared/settings.ts and server/settings.ts.
const STATE_PATH = "agent-manager/auto-release.json";
const DEFAULT_STATE: AutoReleaseSnapshot = {
  lastRunAt: null,
  lastReleased: [],
  lastRemovedWorkspaces: [],
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
  lastCleanupAt: null,
  lastCleanupMode: null,
  lastCleanupSessions: null,
  lastDeletedSessions: 0,
};

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** One flag per phase: a slow phase must never let the next tick start the same work twice. */
let running = false;
let cleaning = false;
let archiving = false;
/** The last sweep as the pill reads it. */
let status: AutoReleaseStatus | null = null;

function statusFrom(state: AutoReleaseSnapshot, isRunning: boolean): AutoReleaseStatus {
  return {
    lastRunAt: state.lastRunAt,
    released: state.lastReleased.length,
    skipped: state.lastSkipped,
    removedWorkspaces: state.lastRemovedWorkspaces.length,
    error: state.lastError,
    nextRunAt: state.nextRunAt,
    running: isRunning,
  };
}

/**
 * The sweep numbers for the pill: the last tick and the next one. Read from memory once the plugin
 * has ticked, else from the state file — any device can read them without a CLI or a reload.
 */
export async function readAutoReleaseStatus(): Promise<AutoReleaseStatus> {
  if (status) {
    return { ...status, running };
  }
  return statusFrom({ ...DEFAULT_STATE, ...(await readStoredState()) }, running);
}

export function startAutoReleaseScheduler(): () => void {
  if (sweepTimer) {
    return () => {};
  }
  sweepTimer = setInterval(() => {
    fireAndForget(tick(), "scheduled sweep");
  }, autoReleaseConfig().sweepIntervalMs);
  fireAndForget(seedStatusThenTick(), "initial sweep");
  return () => {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  };
}

async function seedStatusThenTick(): Promise<void> {
  status = await readAutoReleaseStatus();
  await awaitAutoReleaseSettings();
  await tick();
}

/** One tick: release first (the part that frees resources), then the two slow phases, then record. */
async function tick(): Promise<void> {
  if (running) {
    return;
  }
  const config = autoReleaseConfig();
  // The flag goes up before the first await so two ticks can never release in parallel.
  running = true;
  let state: AutoReleaseSnapshot | null = null;
  let outcome: ReleaseOutcome | null = null;
  try {
    state = { ...DEFAULT_STATE, ...(await readStoredState()) };
    outcome = await releaseRuntimes(config);
  } catch (tickError) {
    console.log(`agent-manager sweep failed: ${describe(tickError)}`);
  } finally {
    running = false;
  }
  if (!state || !outcome) {
    return;
  }

  const finished = await recordRun(state, outcome, config).catch((recordError) => {
    console.log(`agent-manager could not record the sweep: ${describe(recordError)}`);
    return null;
  });
  if (!finished) {
    return;
  }
  status = statusFrom(finished, running);

  await cleanupWorkspaces(finished, outcome, config);
  await archiveMergedWorktreesOnce();
}

interface ReleaseOutcome {
  released: Array<{ agentId: string; title: string | null }>;
  skipped: number;
  error: string | null;
  /** The agents this tick saw, or null when the listing failed — the cleanup phase needs to know. */
  agents: AgentRecord[] | null;
}

function blocksRelease(agent: { attentionReason?: unknown; pendingPermissions?: unknown } | null | undefined): boolean {
  if (str(agent?.attentionReason) === "permission") {
    return true;
  }
  const pending = agent?.pendingPermissions;
  const pendingCount = Array.isArray(pending) ? pending.length : typeof pending === "number" ? pending : 0;
  return pendingCount > 0;
}

/**
 * A runtime the daemon touched inside the grace window is left alone. Without it a tick that lands
 * just after a turn ends would release the runtime the user is about to read the answer from,
 * which costs a cold start on the next message.
 */
function withinGrace(agent: AgentRecord, now: number, graceMs: number): boolean {
  if (graceMs <= 0) {
    return false;
  }
  const stamp = Date.parse(agent.updatedAt ?? "");
  return Number.isFinite(stamp) && now - stamp < graceMs;
}

/** The part of a tick that frees resources: every runtime that is not protected, in one listing. */
async function releaseRuntimes(config: AutoReleaseConfig): Promise<ReleaseOutcome> {
  const released: Array<{ agentId: string; title: string | null }> = [];
  let skipped = 0;
  let error: string | null = null;
  let agents: AgentRecord[] | null = null;
  try {
    const client = await getDaemonClient();
    agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const now = Date.now();
    for (const agent of agents) {
      if (agent.archivedAt !== null || agent.status === "closed") {
        continue;
      }
      // A runtime that is starting up is never a release candidate: a slow provider boot would
      // otherwise be killed half-way through initialization.
      if (agent.status === "running" || agent.status === "initializing" || blocksRelease(agent)) {
        if (agent.status !== "running") {
          skipped += 1;
        }
        continue;
      }
      if (withinGrace(agent, now, config.graceMs)) {
        skipped += 1;
        continue;
      }
      const result = await releaseRuntime(agent.id, agents);
      if (result === "released") {
        released.push({ agentId: agent.id, title: agent.title });
      } else if (result === "skipped") {
        skipped += 1;
      } else {
        error = result;
      }
    }
  } catch (sweepError) {
    error = describe(sweepError);
  }
  return { released, skipped, error, agents };
}

async function releaseRuntime(agentId: string, known?: AgentRecord[]): Promise<"released" | "skipped" | string> {
  try {
    const client = await getDaemonClient();
    const current = known?.find((agent) => agent.id === agentId) ?? (await fetchAgent(client, agentId));
    if (!current || current.status === "running" || current.status === "initializing" || current.status === "closed") {
      return "skipped";
    }
    if (blocksRelease(current) || current.archivedAt !== null) {
      return "skipped";
    }
    // The daemon's own close action (MCP kill_agent): the record stays valid and the next message
    // resumes the session.
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

/**
 * The destructive phase. It runs after the tick has been recorded, so a slow or failing cleanup can
 * never change what the sweep reported, and it is skipped entirely when the listing failed: without
 * it "no session records" would be true for every workspace.
 */
async function cleanupWorkspaces(
  state: AutoReleaseSnapshot,
  outcome: ReleaseOutcome,
  config: AutoReleaseConfig,
): Promise<void> {
  const mode: CleanupMode = config.purgeArchivedWorkspaces ? "purge" : "empty";
  if (cleaning || outcome.agents === null || !cleanupDue(state, config, mode)) {
    return;
  }
  cleaning = true;
  try {
    const result = await runCleanup(outcome, config, mode);
    const finished: AutoReleaseSnapshot = {
      ...state,
      lastRemovedWorkspaces: result.removed,
      lastCleanupMode: mode,
      lastCleanupSessions: mode === "purge" && config.deleteProviderSessions,
      lastDeletedSessions: result.deletedSessions,
      lastCleanupAt: new Date().toISOString(),
    };
    await writeState(finished);
    status = statusFrom(finished, running);
    if (mode === "purge") {
      console.log(
        `agent-manager purged ${result.removed.length} archived workspace(s) and ${result.deletedSessions} provider session file(s)`,
      );
    }
  } catch (cleanupError) {
    console.log(`agent-manager could not clean up workspaces: ${describe(cleanupError)}`);
  } finally {
    cleaning = false;
  }
}

interface CleanupResult {
  removed: Array<{ workspaceId: string; name: string | null }>;
  deletedSessions: number;
}

async function runCleanup(
  outcome: ReleaseOutcome,
  config: AutoReleaseConfig,
  mode: CleanupMode,
): Promise<CleanupResult> {
  const client = await getDaemonClient();
  const paseo: PaseoLike = {
    agents: { list: (options) => client.fetchAgents(options as never) },
  };
  if (mode === "purge") {
    const purged = await purgeArchivedWorkspaces(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
    });
    return { removed: purged.removed, deletedSessions: purged.deletedSessions };
  }
  return { removed: await removeEmptyWorkspaces(paseo, outcome.agents ?? []), deletedSessions: 0 };
}

/**
 * Due when the interval has passed — or when the switches changed since the last cleanup, so
 * turning the purge (or the session-file switch) on does not wait out a day before doing anything.
 */
function cleanupDue(state: AutoReleaseSnapshot, config: AutoReleaseConfig, mode: CleanupMode): boolean {
  if (state.lastCleanupMode !== mode) {
    return true;
  }
  if (mode === "purge" && state.lastCleanupSessions !== config.deleteProviderSessions) {
    return true;
  }
  const previous = Date.parse(state.lastCleanupAt ?? "");
  return !Number.isFinite(previous) || Date.now() - previous >= config.cleanupIntervalMs;
}

async function removeEmptyWorkspaces(
  paseo: PaseoLike,
  agents: readonly AgentRecord[],
): Promise<Array<{ workspaceId: string; name: string | null }>> {
  const removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    const rows = await listWorkspaceRows();
    const busy = new Set(agents.map((agent) => agent.workspaceId).filter((id): id is string => id !== null));
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

/** Paseo archives a worktree when its change request merges, but only for the ones it created. */
async function archiveMergedWorktreesOnce(): Promise<void> {
  if (archiving) {
    return;
  }
  archiving = true;
  try {
    await archiveMergedWorktrees();
  } catch (archiveError) {
    console.log(`agent-manager could not archive merged worktrees: ${describe(archiveError)}`);
  } finally {
    archiving = false;
  }
}

async function recordRun(
  state: AutoReleaseSnapshot,
  outcome: ReleaseOutcome,
  config: AutoReleaseConfig,
): Promise<AutoReleaseSnapshot> {
  const finished = withDerived({
    ...state,
    lastRunAt: new Date().toISOString(),
    lastReleased: outcome.released,
    lastSkipped: outcome.skipped,
    lastError: outcome.error,
  }, config);
  await writeState(finished);
  return finished;
}

function withDerived(state: AutoReleaseSnapshot, config: AutoReleaseConfig): AutoReleaseSnapshot {
  const parsed = Date.parse(state.lastRunAt ?? "");
  const anchor = Number.isFinite(parsed) ? parsed : Date.now();
  return { ...state, nextRunAt: new Date(anchor + config.sweepIntervalMs).toISOString() };
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

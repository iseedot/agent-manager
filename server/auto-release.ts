import { join } from "node:path";

import { readFile } from "node:fs/promises";

import { listAllAgents, type AgentRecord, type PaseoLike } from "./agents";
import { getDaemonClient, type DaemonSessionClient } from "./daemon-client";
import { releaseAgents } from "./actions";
import { paseoHome } from "./daemon-mcp";
import { fireAndForget } from "./guard";
import { formatMemory, readMemoryUsage } from "./host-memory";
import { deleteArchivedProjects } from "./projects";
import { deleteOrphanProviderSessions } from "./provider-sessions";
import { autoReleaseConfig, awaitAutoReleaseSettings, type AutoReleaseConfig } from "./settings";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";
import { deleteArchivedAgents, deleteArchivedWorkspaces, type RemovedWorkspace } from "./workspaces";

interface AutoReleaseSnapshot {
  lastRunAt: string | null;
  lastReleased: Array<{ agentId: string; title: string | null }>;
  lastRemovedWorkspaces: Array<{ workspaceId: string; name: string | null }>;
  lastSkipped: number;
  lastError: string | null;
  nextRunAt: string | null;
  lastCleanupAt: string | null;
  /** The destructive switches the last cleanup ran with; a change makes the cleanup due at once. */
  lastCleanupSignature: string | null;
  lastDeletedAgents: number;
  lastDeletedSessions: number;
  lastDeletedProjects: number;
  lastDeletedOrphanSessions: number;
}

// One timer runs the whole plugin. `enabled` is its master switch: off stops the timer entirely,
// and the settings screen's privacy cleanup button is then the only thing that deletes.
//
// A tick does two things:
//   1. release every runtime that is neither working nor waiting on the user — there is no idle
//      window, so the tick is the resolution, and the grace setting keeps a turn that ended seconds
//      ago from being released on the tick it lands on;
//   2. every so often (a day by default), delete what the switches name: archived workspaces (with
//      the agents inside them) and archived agents whose workspace is not archived.
// `deleteProviderSessions` is the only switch that touches the provider's own files (pi today);
// with it off every deletion removes Paseo records only. Archived projects and orphan provider
// sessions are left to the privacy cleanup button.
const STATE_PATH = "agent-manager/auto-release.json";
const DEFAULT_STATE: AutoReleaseSnapshot = {
  lastRunAt: null,
  lastReleased: [],
  lastRemovedWorkspaces: [],
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
  lastCleanupAt: null,
  lastCleanupSignature: null,
  lastDeletedAgents: 0,
  lastDeletedSessions: 0,
  lastDeletedProjects: 0,
  lastDeletedOrphanSessions: 0,
};

let sweepTimer: ReturnType<typeof setInterval> | null = null;
/** One flag per phase: a slow phase must never let the next tick start the same work twice. */
let running = false;
let cleaning = false;
/** Event-driven releases: one pending timer per agent, armed when its turn ends. */
const pendingReleases = new Map<string, ReturnType<typeof setTimeout>>();

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
    for (const timer of pendingReleases.values()) {
      clearTimeout(timer);
    }
    pendingReleases.clear();
  };
}

/**
 * 0.11 lifecycle hook (`agent.turn_ended` in index.server.ts): release one runtime as soon as its
 * turn has ended and the grace window has passed, instead of waiting up to a full tick. The tick
 * stays as the safety net for runtimes that were already idle before the plugin loaded, and its
 * own protections (running, initializing, waiting on a permission, inside the grace window) still
 * apply because the release goes through the same `releaseRuntime`.
 */
export function scheduleReleaseAfterTurn(agentId: string, graceMs: number): void {
  const existing = pendingReleases.get(agentId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    pendingReleases.delete(agentId);
    void releaseRuntime(agentId)
      .then((result) => {
        if (result === "released") {
          console.log(`agent-manager 事件释放 runtime ${agentId}`);
        } else if (result !== "skipped") {
          console.log(`agent-manager event release failed for ${agentId}: ${result}`);
        }
      })
      .catch((error) => {
        console.log(`agent-manager event release failed for ${agentId}: ${describe(error)}`);
      });
  }, Math.max(0, graceMs) + 1000);
  pendingReleases.set(agentId, timer);
}

async function seedStatusThenTick(): Promise<void> {
  await awaitAutoReleaseSettings();
  await tick();
}

/** One tick: release first (the part that frees resources), then the slow phase, then record. */
async function tick(): Promise<void> {
  if (running) {
    return;
  }
  // The master switch: off means the whole timer does nothing until it is turned back on.
  if (!autoReleaseConfig().enabled) {
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

  await cleanupWorkspaces(finished, outcome, config);
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
    if (!config.enabled) {
      // Auto-release is off: still list the sessions, because the cleanup phase reuses this
      // snapshot, but never close a runtime.
      return { released, skipped, error, agents };
    }
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
  if (released.length > 0) {
    const memory = await readMemoryUsage().catch(() => null);
    console.log(
      `释放了 ${released.length} 个进程，当前系统 ${memory ? formatMemory(memory) : "mem ? swap ?"}`,
    );
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

/** The switches that decide what the destructive phase deletes, as one comparable string. */
function cleanupSignature(config: AutoReleaseConfig): string {
  return [
    config.deleteArchivedWorkspaces ? 1 : 0,
    config.deleteArchivedAgents ? 1 : 0,
    config.deleteProviderSessions ? 1 : 0,
  ].join("");
}

/**
 * The destructive phase. It runs after the tick has been recorded, so a slow or failing cleanup can
 * never change what the sweep reported. The workspace and agent passes are skipped when the session
 * listing failed; the project and orphan passes belong to the privacy button only.
 */
async function cleanupWorkspaces(
  state: AutoReleaseSnapshot,
  outcome: ReleaseOutcome,
  config: AutoReleaseConfig,
): Promise<void> {
  if (cleaning || !cleanupDue(state, config)) {
    return;
  }
  cleaning = true;
  try {
    const result = await runCleanup(outcome, config);
    const finished: AutoReleaseSnapshot = {
      ...state,
      lastRemovedWorkspaces: result.removed,
      lastCleanupSignature: cleanupSignature(config),
      lastDeletedAgents: result.deletedAgents,
      lastDeletedSessions: result.deletedSessions,
      lastCleanupAt: new Date().toISOString(),
    };
    await writeState(finished);
    for (const workspace of result.removed) {
      const name = workspace.name ?? workspace.workspaceId;
      console.log(
        `释放 归档workspace ${name} 和里面 ${workspace.agents} 个agent，成功删除对应session ${workspace.deletedSessions} 个`,
      );
    }
    if (result.deletedAgents > 0) {
      console.log(`删除了 ${result.deletedAgents} 个归档agent（所在workspace未归档）`);
    }
  } catch (cleanupError) {
    console.log(`agent-manager could not clean up workspaces: ${describe(cleanupError)}`);
  } finally {
    cleaning = false;
  }
}

export interface CleanupResult {
  removed: RemovedWorkspace[];
  /** Archived agents removed from workspaces that were not archived. */
  deletedAgents: number;
  deletedSessions: number;
  deletedProjects: number;
  deletedOrphanSessions: number;
}

/** The periodic cleanup: only the two archived-item switches, never projects or orphan sessions. */
async function runCleanup(
  outcome: ReleaseOutcome,
  config: AutoReleaseConfig,
): Promise<CleanupResult> {
  const empty: CleanupResult = {
    removed: [],
    deletedAgents: 0,
    deletedSessions: 0,
    deletedProjects: 0,
    deletedOrphanSessions: 0,
  };
  // The passes need the session listing: without it the archive state would be unknown for every
  // workspace. They are independent of each other, so each switch runs on its own.
  if (outcome.agents === null) {
    return empty;
  }
  const client = await getDaemonClient();
  const paseo: PaseoLike = {
    agents: { list: (options) => client.fetchAgents(options as never) },
  };
  let removed: RemovedWorkspace[] = [];
  let deletedAgents = 0;
  let deletedSessions = 0;
  if (config.deleteArchivedWorkspaces) {
    const result = await deleteArchivedWorkspaces(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
    });
    removed = result.removed;
    deletedSessions += result.deletedSessions;
  }
  if (config.deleteArchivedAgents) {
    const result = await deleteArchivedAgents(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
    });
    deletedAgents = result.deletedAgents;
    deletedSessions += result.deletedSessions;
  }
  return { ...empty, removed, deletedAgents, deletedSessions };
}

/**
 * The settings screen's privacy cleanup: run everything on the spot instead of waiting for the next
 * tick. It deletes every archived workspace with its agents, every archived agent even in a
 * workspace that is not archived, and every archived project with its workspaces and agents. When
 * `deleteProviderSessions` is on it also removes each deleted agent's pi transcript and sweeps the
 * orphan pi sessions; with it off it touches Paseo records only.
 *
 * The two delete switches are ignored: the button means "everything archived goes".
 */
export async function runPrivacyCleanup(): Promise<CleanupResult> {
  if (running || cleaning) {
    throw new Error("A sweep or cleanup is already running. Try again in a moment.");
  }
  const config = autoReleaseConfig();
  const client = await getDaemonClient();
  cleaning = true;
  try {
    const paseo: PaseoLike = {
      agents: { list: (options) => client.fetchAgents(options as never) },
    };
    const workspaces = await deleteArchivedWorkspaces(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
    });
    // The button means "everything archived goes", so the agent pass also picks up agents whose
    // archived workspace the workspace pass could not remove.
    const unarchivedWorkspaceAgents = await deleteArchivedAgents(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
      includeArchivedWorkspaces: true,
    });
    const projects = await deleteArchivedProjects(paseo, {
      deleteProviderSessions: config.deleteProviderSessions,
    });

    let deletedOrphanSessions = 0;
    if (config.deleteProviderSessions) {
      const orphans = await deleteOrphanProviderSessions();
      deletedOrphanSessions = orphans.deleted.length;
      if (orphans.failed.length > 0) {
        console.log(
          `agent-manager could not remove ${orphans.failed.length} orphan provider session(s): ${orphans.failed[0]?.error ?? "unknown error"}`,
        );
      }
    }

    if (projects.deletedProjects > 0) {
      console.log(`删除了 ${projects.deletedProjects} 个归档project`);
    }
    if (deletedOrphanSessions > 0) {
      console.log(`删除 ${deletedOrphanSessions} 个 paseo无记录session`);
    }

    return {
      removed: workspaces.removed,
      deletedAgents: unarchivedWorkspaceAgents.deletedAgents,
      deletedSessions:
        workspaces.deletedSessions +
        unarchivedWorkspaceAgents.deletedSessions +
        projects.deletedSessions,
      deletedProjects: projects.deletedProjects,
      deletedOrphanSessions,
    };
  } finally {
    cleaning = false;
  }
}

/**
 * Due when the interval has passed — or when any destructive switch changed since the last cleanup,
 * so turning a delete switch on does not wait out a day.
 */
function cleanupDue(state: AutoReleaseSnapshot, config: AutoReleaseConfig): boolean {
  if (state.lastCleanupSignature !== cleanupSignature(config)) {
    return true;
  }
  const previous = Date.parse(state.lastCleanupAt ?? "");
  return !Number.isFinite(previous) || Date.now() - previous >= config.cleanupIntervalMs;
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

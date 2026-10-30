import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { deleteAgent, deleteProject } from "./cli";
import { listAgents, paseoHome, type AgentRecord } from "./daemon";
import { deleteAgentTranscripts, sweepOrphanSessions } from "./pi-sessions";
import {
  forgetWorkspace,
  readProjects,
  readWorkspaces,
  type ProjectRow,
  type WorkspaceRow,
} from "./registry";
import { autoCleanupConfig, awaitAutoCleanupSettings, type AutoCleanupConfig } from "./settings";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";

/**
 * The whole plugin: one due-timer, one snapshot of what exists, one pass that deletes what the
 * switches name.
 *
 * The timer is not a poll. It wakes exactly when the cleanup is due (`lastCleanupAt` + interval, or
 * immediately when a switch changed), re-derives the delay from the clock every time, and re-arms
 * afterwards. Nothing else in the plugin schedules anything.
 */

export interface CleanupResult {
  removed: Array<{
    workspaceId: string;
    name: string | null;
    agents: number;
    deletedSessions: number;
  }>;
  /** Archived agents removed from workspaces that were not archived. */
  deletedAgents: number;
  deletedSessions: number;
  deletedProjects: number;
  deletedOrphanSessions: number;
}

interface CleanupState {
  lastCleanupAt: string | null;
  /** The switches the last cleanup ran with; a change makes the cleanup due at once. */
  lastCleanupSignature: string | null;
  lastError: string | null;
}

/** What a run may delete. `everything` is the settings screen's privacy button. */
interface Passes {
  workspaces: boolean;
  agents: boolean;
  everything: boolean;
}

interface Snapshot {
  workspaces: WorkspaceRow[];
  projects: ProjectRow[];
  agents: AgentRecord[];
}

interface Plan extends Snapshot {
  /** Workspaces dropped with everything inside them, including ones owned by a removed project. */
  removedWorkspaceIds: Set<string>;
}

const STATE_PATH = "agent-manager/auto-cleanup.json";
/** Read when the new file is missing, so an upgrade keeps its last-cleanup timestamp. */
const LEGACY_STATE_PATH = "agent-manager/auto-release.json";
const DEFAULT_STATE: CleanupState = {
  lastCleanupAt: null,
  lastCleanupSignature: null,
  lastError: null,
};
/** A failed pass retries after this long instead of waiting out the whole interval. */
const RETRY_MS = 60 * 60_000;
const MIN_DELAY_MS = 1000;
/** Beyond this a timeout would fire immediately, so a long interval is armed in slices. */
const MAX_DELAY_MS = 2 ** 31 - 1;

let timer: ReturnType<typeof setTimeout> | null = null;
/** One flag for the timer and the button together: two destructive passes never overlap. */
let running = false;
let stopped = false;
let reschedulePending = false;

export function startAutoCleanup(): () => void {
  stopped = false;
  void awaitAutoCleanupSettings().then(() => {
    if (!stopped) {
      wake();
    }
  });
  return () => {
    stopped = true;
    clearTimer();
  };
}

/** A settings change: a switch flipped or the timer turned off/on, so the delay is stale. */
export function rescheduleAutoCleanup(): void {
  if (stopped) {
    return;
  }
  if (running) {
    reschedulePending = true;
    return;
  }
  clearTimer();
  wake();
}

/**
 * The settings screen's privacy cleanup: every pass at once, on the spot, ignoring the two delete
 * switches — "everything archived goes". Projects and the orphan sweep belong to this button only.
 */
export async function runPrivacyCleanup(): Promise<CleanupResult> {
  if (running) {
    throw new Error("A cleanup is already running. Try again in a moment.");
  }
  running = true;
  try {
    return await execute(autoCleanupConfig(), { workspaces: true, agents: true, everything: true });
  } finally {
    finishRun();
  }
}

function wake(): void {
  void tick().catch((error) => {
    console.log(`agent-manager cleanup tick failed: ${describe(error)}`);
    if (!timer) {
      arm(RETRY_MS);
    }
  });
}

/** One wake-up: arm for the due moment, or run the cleanup when it has come. */
async function tick(): Promise<void> {
  if (running || stopped) {
    return;
  }
  running = true;
  try {
    const config = autoCleanupConfig();
    if (!config.enabled) {
      // No timer while the master switch is off: turning it back on re-arms through the settings.
      return;
    }
    const state = await readState();
    const wait = dueAt(state, config) - Date.now();
    if (wait > 0) {
      arm(wait);
      return;
    }
    try {
      await execute(config, periodicPasses(config));
      await writeState({
        lastCleanupAt: new Date().toISOString(),
        lastCleanupSignature: signature(config),
        lastError: null,
      });
      arm(config.cleanupIntervalMs);
    } catch (error) {
      // `lastCleanupAt` is only written on success, so the failed pass stays due.
      const message = describe(error);
      console.log(`agent-manager cleanup failed: ${message}`);
      await writeState({ ...state, lastError: message }).catch(() => undefined);
      arm(RETRY_MS);
    }
  } finally {
    finishRun();
  }
}

function finishRun(): void {
  running = false;
  if (reschedulePending) {
    reschedulePending = false;
    rescheduleAutoCleanup();
  }
}

function periodicPasses(config: AutoCleanupConfig): Passes {
  return {
    workspaces: config.deleteArchivedWorkspaces,
    agents: config.deleteArchivedAgents,
    everything: false,
  };
}

/** The moment the cleanup comes due: now when a switch changed, else the interval after the last run. */
function dueAt(state: CleanupState, config: AutoCleanupConfig): number {
  if (state.lastCleanupSignature !== signature(config)) {
    return 0;
  }
  const previous = Date.parse(state.lastCleanupAt ?? "");
  return Number.isFinite(previous) ? previous + config.cleanupIntervalMs : 0;
}

function signature(config: AutoCleanupConfig): string {
  return [
    config.deleteArchivedWorkspaces ? 1 : 0,
    config.deleteArchivedAgents ? 1 : 0,
    config.deleteProviderSessions ? 1 : 0,
  ].join("");
}

function arm(delayMs: number): void {
  clearTimer();
  timer = setTimeout(
    () => {
      timer = null;
      wake();
    },
    Math.min(Math.max(Math.round(delayMs), MIN_DELAY_MS), MAX_DELAY_MS),
  );
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * One destructive pass over one snapshot: sessions first (they name the agent that owns them), then
 * the agent records, then the workspace records, then the projects.
 */
async function execute(config: AutoCleanupConfig, passes: Passes): Promise<CleanupResult> {
  const result: CleanupResult = {
    removed: [],
    deletedAgents: 0,
    deletedSessions: 0,
    deletedProjects: 0,
    deletedOrphanSessions: 0,
  };
  if (!passes.workspaces && !passes.agents && !passes.everything) {
    return result;
  }
  const [workspaces, projects, agents] = await Promise.all([
    readWorkspaces(),
    readProjects(),
    listAgents(),
  ]);
  const plan = planCleanup({ workspaces, projects, agents }, passes);

  const transcripts = config.deleteProviderSessions
    ? await deleteAgentTranscripts(plan.agents)
    : { deleted: new Map<string, string>(), failed: [] };
  if (transcripts.failed.length > 0) {
    console.log(
      `agent-manager could not remove ${transcripts.failed.length} pi transcript(s): ${transcripts.failed[0]?.error ?? "unknown error"}`,
    );
  }

  const deletedAgents = new Set<string>();
  const failedWorkspaces = new Set<string>();
  for (const agent of plan.agents) {
    try {
      await deleteAgent(agent.id);
      deletedAgents.add(agent.id);
    } catch (error) {
      if (agent.workspaceId) {
        failedWorkspaces.add(agent.workspaceId);
      }
      console.log(`agent-manager could not delete agent ${agent.id}: ${describe(error)}`);
    }
  }

  const agentsByWorkspace = new Map<string, AgentRecord[]>();
  for (const agent of plan.agents) {
    if (agent.workspaceId === null) continue;
    const list = agentsByWorkspace.get(agent.workspaceId) ?? [];
    list.push(agent);
    agentsByWorkspace.set(agent.workspaceId, list);
  }

  for (const workspaceId of plan.removedWorkspaceIds) {
    if (failedWorkspaces.has(workspaceId)) {
      continue;
    }
    await forgetWorkspace(workspaceId);
  }

  for (const workspace of plan.workspaces) {
    if (failedWorkspaces.has(workspace.workspaceId)) {
      continue;
    }
    const inside = agentsByWorkspace.get(workspace.workspaceId) ?? [];
    const deletedSessions = inside.filter((agent) => transcripts.deleted.has(agent.id)).length;
    result.removed.push({
      workspaceId: workspace.workspaceId,
      name: workspace.name,
      agents: inside.length,
      deletedSessions,
    });
    console.log(
      `删除 归档workspace ${workspace.name ?? workspace.workspaceId} 和里面 ${inside.length} 个agent，成功删除对应session ${deletedSessions} 个`,
    );
  }

  for (const project of plan.projects) {
    try {
      await deleteProject(project.projectId);
      result.deletedProjects += 1;
    } catch (error) {
      console.log(`agent-manager could not delete project ${project.projectId}: ${describe(error)}`);
    }
  }

  if (passes.everything && config.deleteProviderSessions) {
    const orphans = await sweepOrphanSessions();
    result.deletedOrphanSessions = orphans.deleted.length;
    if (orphans.failed.length > 0) {
      console.log(
        `agent-manager could not remove ${orphans.failed.length} orphan provider session(s): ${orphans.failed[0]?.error ?? "unknown error"}`,
      );
    }
    if (result.deletedOrphanSessions > 0) {
      console.log(`删除 ${result.deletedOrphanSessions} 个 paseo无记录session`);
    }
  }

  const standalone = plan.agents.filter(
    (agent) => agent.workspaceId === null || !plan.removedWorkspaceIds.has(agent.workspaceId),
  );
  result.deletedAgents = standalone.filter((agent) => deletedAgents.has(agent.id)).length;
  result.deletedSessions = transcripts.deleted.size;

  if (result.deletedAgents > 0) {
    console.log(`删除了 ${result.deletedAgents} 个归档agent（所在workspace未归档）`);
  }
  if (result.deletedProjects > 0) {
    console.log(`删除了 ${result.deletedProjects} 个归档project`);
  }
  return result;
}

/**
 * Who goes. An agent inside a workspace that is being dropped goes with it, whatever its own state;
 * otherwise only archived agents qualify, and only when the agent switch allows it. The two switches
 * stay disjoint: an archived agent inside an archived workspace belongs to the workspace switch.
 */
function planCleanup(snapshot: Snapshot, passes: Passes): Plan {
  const archivedWorkspaceIds = new Set(
    snapshot.workspaces.filter((row) => row.archivedAt !== null).map((row) => row.workspaceId),
  );
  const workspaces = passes.workspaces
    ? snapshot.workspaces.filter((row) => row.archivedAt !== null)
    : [];
  const projects = passes.everything
    ? snapshot.projects.filter((row) => row.archivedAt !== null)
    : [];
  const removedWorkspaceIds = new Set(workspaces.map((row) => row.workspaceId));
  const projectIds = new Set(projects.map((row) => row.projectId));
  for (const row of snapshot.workspaces) {
    if (row.projectId !== null && projectIds.has(row.projectId)) {
      removedWorkspaceIds.add(row.workspaceId);
    }
  }
  const agents = snapshot.agents.filter((agent) => {
    if (agent.workspaceId !== null && removedWorkspaceIds.has(agent.workspaceId)) {
      return true;
    }
    if (!(passes.agents || passes.everything) || agent.archivedAt === null) {
      return false;
    }
    return (
      passes.everything ||
      agent.workspaceId === null ||
      !archivedWorkspaceIds.has(agent.workspaceId)
    );
  });
  return { workspaces, projects, agents, removedWorkspaceIds };
}

async function readState(): Promise<CleanupState> {
  for (const relativePath of [STATE_PATH, LEGACY_STATE_PATH]) {
    const parsed = await readJsonObject(join(paseoHome(), relativePath));
    if (parsed) {
      return {
        lastCleanupAt: str(parsed.lastCleanupAt),
        lastCleanupSignature: str(parsed.lastCleanupSignature),
        lastError: str(parsed.lastError),
      };
    }
  }
  return { ...DEFAULT_STATE };
}

function writeState(state: CleanupState): Promise<void> {
  return serializeWrite(() => writeJsonAtomic(join(paseoHome(), STATE_PATH), state));
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

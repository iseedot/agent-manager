import { join } from "node:path";

import { readFile, readdir } from "node:fs/promises";

import { listAllAgents, type AgentRecord } from "./agents";
import {
  beginDaemonClientUse,
  endDaemonClientUse,
  getDaemonClient,
  holdDaemonClient,
  type DaemonSessionClient,
  type OwnedAgentSubscription,
} from "./daemon-client";
import { killAgentViaDaemonMcp, paseoHome } from "./daemon-mcp";
import type { AutoReleasePatch, AutoReleaseSnapshot } from "../shared/contracts";
import { closeIdleTerminals, terminalApiFromClient } from "./terminals";
import { fireAndForget } from "./guard";
import { scanAgentProcesses, scanAgentProcessesFresh } from "./processes";
import { describe, serializeWrite, str, writeJsonAtomic } from "./util";
import { deleteWorkspace, listWorkspaceRows } from "./workspaces";
import type { PaseoLike } from "./overview";

const STATE_PATH = "agent-manager/auto-release.json";
const TICK_MS = 60000;
const MAX_TIMERS = 200;
const DEFAULT_STATE: AutoReleaseSnapshot = {
  enabled: true,
  idleMinutes: 10,
  intervalMinutes: 30,
  onLoad: "threshold",
  removeEmptyWorkspaces: true,
  closeIdleTerminals: false,
  terminalIdleMinutes: 30,
  lastRunAt: null,
  lastReleased: [],
  lastRemovedWorkspaces: [],
  lastClosedTerminals: 0,
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
};

const timers = new Map<string, ReturnType<typeof setTimeout>>();
const lastStatus = new Map<string, string>();
const loadedAt = new Map<string, number>();

function noteLoaded(agentId: string): void {
  loadedAt.set(agentId, Date.now());
}

function forgetLoaded(agentId: string): void {
  loadedAt.delete(agentId);
}

function idleBase(agentId: string, lastActivity: number | null): number {
  const loaded = loadedAt.get(agentId) ?? 0;
  return Math.max(lastActivity ?? 0, loaded);
}

function blocksRelease(agent: { attentionReason?: unknown; pendingPermissions?: unknown } | null | undefined): boolean {
  if (str(agent?.attentionReason) === "permission") {
    return true;
  }
  const pending = agent?.pendingPermissions;
  const pendingCount = Array.isArray(pending) ? pending.length : typeof pending === "number" ? pending : 0;
  return pendingCount > 0;
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let subscription: OwnedAgentSubscription | null = null;
let subscriptionCleanup: (() => void) | null = null;
let running = false;
let loaded = false;

export function startAutoReleaseScheduler(): () => void {
  if (schedulerTimer) {
    return () => {};
  }
  schedulerTimer = setInterval(() => {
    fireAndForget(tick(), "scheduler tick");
  }, TICK_MS);
  fireAndForget(activate(), "initial sweep");
  return () => {
    if (schedulerTimer) {
      clearInterval(schedulerTimer);
      schedulerTimer = null;
    }
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    subscriptionCleanup?.();
    subscriptionCleanup = null;
    void subscription?.release().catch(() => undefined);
    subscription = null;
    holdDaemonClient(false);
  };
}

export async function readAutoReleaseState(): Promise<AutoReleaseSnapshot> {
  const stored = await readStoredState();
  return withDerived({ ...DEFAULT_STATE, ...stored });
}

export async function updateAutoReleaseState(patch: AutoReleasePatch): Promise<AutoReleaseSnapshot> {
  const current = { ...DEFAULT_STATE, ...(await readStoredState()) };
  const next: AutoReleaseSnapshot = {
    ...current,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.idleMinutes === undefined ? {} : { idleMinutes: clamp(patch.idleMinutes, 1, 24 * 60) }),
    ...(patch.intervalMinutes === undefined ? {} : { intervalMinutes: clamp(patch.intervalMinutes, 1, 24 * 60) }),
    ...(patch.onLoad === undefined ? {} : { onLoad: patch.onLoad }),
    ...(patch.removeEmptyWorkspaces === undefined ? {} : { removeEmptyWorkspaces: patch.removeEmptyWorkspaces }),
    ...(patch.closeIdleTerminals === undefined ? {} : { closeIdleTerminals: patch.closeIdleTerminals }),
    ...(patch.terminalIdleMinutes === undefined
      ? {}
      : { terminalIdleMinutes: clamp(patch.terminalIdleMinutes, 5, 24 * 60) }),
  };
  await writeState(next);
  if (patch.enabled === false) {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
    subscriptionCleanup?.();
    subscriptionCleanup = null;
    void subscription?.release().catch(() => undefined);
    subscription = null;
    holdDaemonClient(false);
  }
  if (patch.enabled === true || patch.runNow === true) {
    await activate();
    await sweep(patch.runNow === true ? "allIdle" : next.onLoad);
  }
  return readAutoReleaseState();
}

async function tick(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled) {
    return;
  }
  if (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < state.intervalMinutes * 60000) {
    return;
  }
  await activate();
  await sweep("threshold");
}

async function activate(): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled) {
    return;
  }
  holdDaemonClient(true);
  if (subscription) {
    return;
  }
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    const owned = await client.observeAgents({ filter: { includeArchived: true } });
    subscription = owned;
    subscriptionCleanup = owned.subscribe({
      snapshot: () => undefined,
      update: (message) => {
        onAgentUpdate(message);
      },
    });
    const snapshot = await owned.ready.catch(() => null);
    if (snapshot) {
      for (const entry of snapshot.entries ?? []) {
        onAgentUpdate({ type: "agent_update", payload: { kind: "upsert", agent: entry.agent } });
      }
    }
    if (!loaded) {
      loaded = true;
      fireAndForget(sweep(state.onLoad), "load sweep");
    }
  } catch (error) {
    holdDaemonClient(false);
    subscription = null;
    await writeState({ ...state, lastError: describe(error) });
  } finally {
    endDaemonClientUse();
  }
}

function onAgentUpdate(message: unknown): void {
  const payload = (message as { payload?: { kind?: unknown; agent?: unknown; id?: unknown } })?.payload;
  if (!payload) {
    return;
  }
  const agent = payload.agent as RawLiveAgent | undefined;
  const agentId = str(agent?.id) ?? str(payload.id);
  if (!agentId) {
    return;
  }
  if (payload.kind === "remove" || str(agent?.archivedAt) !== null) {
    cancelTimer(agentId);
    lastStatus.delete(agentId);
    forgetLoaded(agentId);
    return;
  }
  const status = str(agent?.status) ?? "unknown";
  const previous = lastStatus.get(agentId);
  lastStatus.set(agentId, status);
  if (status === "closed" || status === "error") {
    cancelTimer(agentId);
    forgetLoaded(agentId);
    return;
  }
  if (status === "idle" && (previous === undefined || previous === "closed" || previous === "error")) {
    noteLoaded(agentId);
  }
  if (status !== "idle" || blocksRelease(agent)) {
    cancelTimer(agentId);
    return;
  }
  if (previous === "idle" && timers.has(agentId)) {
    return;
  }
  armFrom(agentId, agent);
}

function armFrom(agentId: string, agent: RawLiveAgent | undefined): void {
  fireAndForget((async () => {
    const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
    if (!state.enabled) {
      return;
    }
    const recordPath = await findRecordPath(str(agent?.cwd), agentId);
    const lastActivity = await readLastActivity(recordPath, str(agent?.updatedAt));
    const base = idleBase(agentId, lastActivity);
    const dueAt = (base || Date.now()) + state.idleMinutes * 60000;
    armTimer(agentId, Math.max(1000, dueAt - Date.now()));
  })(), `arm ${agentId.slice(0, 7)}`);
}

function armTimer(agentId: string, delayMs: number): void {
  if (timers.size >= MAX_TIMERS && !timers.has(agentId)) {
    return;
  }
  cancelTimer(agentId);
  const timer = setTimeout(() => {
    timers.delete(agentId);
    fireAndForget(releaseArmedAgent(agentId), `release ${agentId.slice(0, 7)}`);
  }, delayMs);
  timers.set(agentId, timer);
}

function cancelTimer(agentId: string): void {
  const timer = timers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(agentId);
  }
}

async function sweep(mode: AutoReleaseSnapshot["onLoad"]): Promise<void> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled || running || mode === "off") {
    await recordRun(state, [], [], 0, 0, null);
    return;
  }
  running = true;
  beginDaemonClientUse();
  const released: Array<{ agentId: string; title: string | null }> = [];
  let skipped = 0;
  let error: string | null = null;
  try {
    const client = await getDaemonClient();
    const agents = await listAllAgents((options) => client.fetchAgents(options as never));
    const threshold = state.idleMinutes * 60000;
    const now = Date.now();
    for (const agent of agents) {
      if (agent.archivedAt !== null || agent.status === "closed") {
        cancelTimer(agent.id);
        continue;
      }
      if (agent.status === "running" || blocksRelease(agent)) {
        cancelTimer(agent.id);
        if (agent.status !== "running") {
          skipped += 1;
        }
        continue;
      }
      const lastActivity = await resolveLastActivityAt(agent);
      const base = idleBase(agent.id, lastActivity);
      const dueAt = (base || now) + threshold;
      if (mode === "allIdle" || dueAt <= now) {
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
      armTimer(agent.id, dueAt - now);
    }
  } catch (sweepError) {
    error = describe(sweepError);
  } finally {
    endDaemonClientUse();
    running = false;
  }

  let removed: Array<{ workspaceId: string; name: string | null }> = [];
  try {
    removed = state.removeEmptyWorkspaces ? await removeEmptyWorkspaces() : [];
  } catch (removalError) {
    error = describe(removalError);
  }

  let closedTerminals = 0;
  if (state.closeIdleTerminals) {
    try {
      const client = await getDaemonClient();
      const result = await closeIdleTerminals(terminalApiFromClient(client), state.terminalIdleMinutes);
      closedTerminals = result.closed.length;
      skipped += result.skipped;
      if (result.failed.length > 0) {
        error = error ?? result.failed[0]?.error ?? null;
      }
    } catch (terminalError) {
      error = error ?? describe(terminalError);
    }
  }

  await recordRun(state, released, removed, closedTerminals, skipped, error).catch((recordError) => {
    console.log(`agent-manager could not record the sweep: ${describe(recordError)}`);
  });
}

async function releaseArmedAgent(agentId: string): Promise<void> {
  const outcome = await releaseIdleAgent(agentId);
  if (outcome !== "released") {
    return;
  }
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  const released = [{ agentId, title: null }, ...state.lastReleased].slice(0, 5);
  await writeState(withDerived({ ...state, lastReleased: released }));
}

async function releaseIdleAgent(agentId: string, known?: AgentRecord[]): Promise<"released" | "skipped" | string> {
  try {
    const client = await getDaemonClient();
    const current = known?.find((agent) => agent.id === agentId) ?? (await fetchAgent(client, agentId));
    if (!current || current.status === "running" || current.status === "closed") {
      return "skipped";
    }
    if (blocksRelease(current) || current.archivedAt !== null) {
      return "skipped";
    }
    await killAgentViaDaemonMcp(agentId);
    const stillRunning = await hasRuntime(agentId);
    if (!stillRunning) {
      forgetLoaded(agentId);
    }
    return stillRunning ? "skipped" : "released";
  } catch (error) {
    return describe(error);
  }
}

async function fetchAgent(client: DaemonSessionClient, agentId: string): Promise<AgentRecord | null> {
  const agents = await listAllAgents((options) => client.fetchAgents(options as never)).catch(() => []);
  return agents.find((agent) => agent.id === agentId) ?? null;
}

async function hasRuntime(agentId: string): Promise<boolean> {
  const processes = await scanAgentProcessesFresh().catch(() => new Map());
  return processes.has(agentId);
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
  closedTerminals: number,
  skipped: number,
  error: string | null,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  await writeState(
    withDerived({
      ...state,
      lastRunAt: finishedAt,
      lastReleased: released,
      lastRemovedWorkspaces: removedWorkspaces,
      lastClosedTerminals: closedTerminals,
      lastSkipped: skipped,
      lastError: error,
    }),
  );
}

function withDerived(state: AutoReleaseSnapshot): AutoReleaseSnapshot {
  if (!state.enabled) {
    return { ...state, nextRunAt: null };
  }
  if (!state.lastRunAt) {
    return { ...state, nextRunAt: new Date().toISOString() };
  }
  return {
    ...state,
    nextRunAt: new Date(Date.parse(state.lastRunAt) + state.intervalMinutes * 60000).toISOString(),
  };
}

interface RawLiveAgent {
  id?: unknown;
  status?: unknown;
  archivedAt?: unknown;
  requiresAttention?: unknown;
  attentionReason?: unknown;
  pendingPermissions?: unknown;
  updatedAt?: unknown;
  cwd?: unknown;
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
      return null;
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
  return serializeWrite(() => writeJsonAtomic(join(paseoHome(), STATE_PATH), state));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

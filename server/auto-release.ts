import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { beginDaemonClientUse, endDaemonClientUse, getDaemonClient } from "./daemon-client";
import { killAgentViaDaemonMcp, paseoHome } from "./daemon-mcp";
import { scanAgentProcesses } from "./processes";

export interface AutoReleaseState {
  enabled: boolean;
  idleMinutes: number;
  intervalMinutes: number;
  lastRunAt: string | null;
  lastReleased: Array<{ agentId: string; title: string | null }>;
  lastSkipped: number;
  lastError: string | null;
  nextRunAt: string | null;
}

const STATE_PATH = "agent-manager/auto-release.json";
const TICK_MS = 60000;
const DEFAULT_STATE: AutoReleaseState = {
  enabled: true,
  idleMinutes: 10,
  intervalMinutes: 10,
  lastRunAt: null,
  lastReleased: [],
  lastSkipped: 0,
  lastError: null,
  nextRunAt: null,
};

interface RawAgent {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
  requiresAttention?: unknown;
  archivedAt?: unknown;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function readAutoReleaseState(): Promise<AutoReleaseState> {
  const stored = await readStoredState();
  return { ...DEFAULT_STATE, ...stored, nextRunAt: nextRunAt(stored, DEFAULT_STATE) };
}

export async function updateAutoReleaseState(patch: {
  enabled?: boolean;
  idleMinutes?: number;
  intervalMinutes?: number;
  runNow?: boolean;
}): Promise<AutoReleaseState> {
  const current = { ...DEFAULT_STATE, ...(await readStoredState()) };
  const next: AutoReleaseState = {
    ...current,
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.idleMinutes === undefined ? {} : { idleMinutes: clamp(patch.idleMinutes, 1, 24 * 60) }),
    ...(patch.intervalMinutes === undefined ? {} : { intervalMinutes: clamp(patch.intervalMinutes, 1, 24 * 60) }),
  };
  await writeState(next);
  if (patch.runNow === true) {
    await runAutoRelease();
  }
  return readAutoReleaseState();
}

export function startAutoReleaseScheduler(): () => void {
  if (timer) {
    return () => {};
  }
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  void tick();
  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

async function tick(): Promise<void> {
  if (running) {
    return;
  }
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (!state.enabled) {
    return;
  }
  if (state.lastRunAt && Date.now() - Date.parse(state.lastRunAt) < state.intervalMinutes * 60000) {
    return;
  }
  await runAutoRelease();
}

export async function runAutoRelease(): Promise<AutoReleaseState> {
  const state = { ...DEFAULT_STATE, ...(await readStoredState()) };
  if (running) {
    return readAutoReleaseState();
  }
  running = true;
  beginDaemonClientUse();
  const released: Array<{ agentId: string; title: string | null }> = [];
  let skipped = 0;
  let error: string | null = null;
  try {
    const client = await getDaemonClient();
    const page = await client.fetchAgents({ filter: { includeArchived: true }, page: { limit: 200 } });
    const entries = Array.isArray(page?.entries) ? (page.entries as Array<{ agent?: RawAgent }>) : [];
    const processes = await scanAgentProcesses().catch(() => new Map());
    const threshold = state.idleMinutes * 60000;
    const now = Date.now();

    for (const entry of entries) {
      const agent = entry.agent;
      const agentId = str(agent?.id);
      if (!agent || !agentId || !processes.has(agentId)) {
        continue;
      }
      if (str(agent.status) === "running") {
        continue;
      }
      if (agent.requiresAttention === true) {
        skipped += 1;
        continue;
      }
      const idleSince = await resolveLastActivityAt(agent, agentId);
      if (idleSince === null || now - idleSince < threshold) {
        continue;
      }
      try {
        await killAgentViaDaemonMcp(agentId);
        const after = await scanAgentProcesses().catch(() => new Map());
        if (after.has(agentId)) {
          skipped += 1;
          continue;
        }
        released.push({ agentId, title: str(agent.title) });
      } catch (releaseError) {
        error = describe(releaseError);
      }
    }
  } catch (runError) {
    error = describe(runError);
  } finally {
    endDaemonClientUse();
    running = false;
  }

  const finishedAt = new Date().toISOString();
  const next: AutoReleaseState = {
    ...state,
    lastRunAt: finishedAt,
    lastReleased: released,
    lastSkipped: skipped,
    lastError: error,
    nextRunAt: new Date(Date.parse(finishedAt) + state.intervalMinutes * 60000).toISOString(),
  };
  await writeState(next);
  return next;
}

async function resolveLastActivityAt(agent: RawAgent, agentId: string): Promise<number | null> {
  const recordPath = await findRecordPath(str(agent.cwd), agentId);
  if (recordPath) {
    try {
      const parsed = JSON.parse(await readFile(recordPath, "utf8")) as { lastActivityAt?: unknown };
      const parsedMs = Date.parse(str(parsed.lastActivityAt) ?? "");
      if (Number.isFinite(parsedMs)) {
        return parsedMs;
      }
    } catch {
      // fall through to the wire timestamp
    }
  }
  const updatedMs = Date.parse(str(agent.updatedAt) ?? "");
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

async function readStoredState(): Promise<Partial<AutoReleaseState>> {
  try {
    const raw = await readFile(join(paseoHome(), STATE_PATH), "utf8");
    const parsed = JSON.parse(raw) as Partial<AutoReleaseState>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state: AutoReleaseState): Promise<void> {
  const target = join(paseoHome(), STATE_PATH);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function nextRunAt(stored: Partial<AutoReleaseState>, defaults: AutoReleaseState): string | null {
  if (stored.enabled === false) {
    return null;
  }
  if (!stored.lastRunAt) {
    return new Date().toISOString();
  }
  const interval = (stored.intervalMinutes ?? defaults.intervalMinutes) * 60000;
  return new Date(Date.parse(stored.lastRunAt) + interval).toISOString();
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

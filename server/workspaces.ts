import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { listAllAgents, type AgentLister, type AgentRecord, type PaseoLike } from "./agents";
import { deleteAgents } from "./actions";
import { paseoHome } from "./daemon-mcp";
import { deleteAgentSessionFiles } from "./provider-sessions";
import { serializeWrite, str, writeJsonAtomic } from "./util";

/**
 * The daemon's workspace registry (`projects/workspaces.json`) plus the operations the plugin
 * performs on it: dropping one archived workspace, and dropping every archived workspace at once.
 */

export interface WorkspaceRow {
  workspaceId: string;
  projectId: string | null;
  name: string | null;
  cwd: string;
  kind: string;
  archivedAt: string | null;
}

export interface DeleteWorkspaceOutcome {
  ok: boolean;
  message: string;
  deletedAgents: string[];
  failed: Array<{ agentId: string; error: string }>;
}

interface WorkspaceRecord {
  workspaceId?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  kind?: unknown;
  title?: unknown;
  customName?: unknown;
  archivedAt?: unknown;
}

interface DeletedState {
  version: number;
  workspaceIds: string[];
}

const REGISTRY_PATH = "projects/workspaces.json";
const DELETED_PATH = "agent-manager/deleted-workspaces.json";

export async function listWorkspaceRows(): Promise<WorkspaceRow[]> {
  const [records, deleted] = await Promise.all([
    readJsonList<WorkspaceRecord>(REGISTRY_PATH, "workspaces"),
    readDeletedState(),
  ]);

  const rows: WorkspaceRow[] = [];
  const reclaimed: string[] = [];
  for (const record of records) {
    const workspaceId = str(record.workspaceId);
    if (!workspaceId) {
      continue;
    }
    if (deleted.has(workspaceId)) {
      // The daemon still holds the record in memory and writes it back, so a deleted workspace that
      // is active again was resurrected: stop hiding it.
      if (str(record.archivedAt) !== null) {
        continue;
      }
      reclaimed.push(workspaceId);
    }
    rows.push({
      workspaceId,
      projectId: str(record.projectId),
      name: str(record.title) ?? str(record.customName),
      cwd: str(record.cwd) ?? "",
      kind: str(record.kind) ?? "directory",
      archivedAt: str(record.archivedAt),
    });
  }
  if (reclaimed.length > 0) {
    void updateDeletedState((known) => {
      for (const id of reclaimed) known.delete(id);
    });
  }
  return rows;
}

export async function deleteWorkspace(
  paseo: PaseoLike,
  workspaceId: string,
): Promise<DeleteWorkspaceOutcome> {
  const rows = await listWorkspaceRows();
  const target = rows.find((row) => row.workspaceId === workspaceId) ?? null;
  if (!target) {
    if (!(await readDeletedState()).has(workspaceId)) {
      return { ok: false, message: "Unknown workspace.", deletedAgents: [], failed: [] };
    }
    const leftover = await listWorkspaceAgents(paseo, workspaceId).catch(() => []);
    const swept =
      leftover.length > 0
        ? await deleteAgents(leftover.map((agent) => agent.id))
        : { deleted: [] as string[], failed: [] as Array<{ agentId: string; error: string }> };
    await stripWorkspaceRecord(workspaceId);
    return {
      ok: true,
      message: `Workspace already deleted · ${swept.deleted.length} leftover session(s) removed`,
      deletedAgents: swept.deleted,
      failed: swept.failed,
    };
  }
  if (target.archivedAt === null) {
    return {
      ok: false,
      message: "Archive this workspace before deleting it.",
      deletedAgents: [],
      failed: [],
    };
  }

  const agents = await listWorkspaceAgents(paseo, workspaceId).catch(() => []);
  const removed = await deleteAgents(agents.map((agent) => agent.id));
  const remaining = await listWorkspaceAgents(paseo, workspaceId).catch(() => []);
  if (remaining.length > 0 && removed.failed.length > 0) {
    return {
      ok: false,
      message: `Could not delete every session: ${removed.failed[0]?.error ?? "unknown error"}`,
      deletedAgents: removed.deleted,
      failed: removed.failed,
    };
  }

  await forgetWorkspace(workspaceId);
  return {
    ok: true,
    message: `Deleted workspace "${target.name ?? target.cwd}" with ${removed.deleted.length} session(s).`,
    deletedAgents: removed.deleted,
    failed: removed.failed,
  };
}

/**
 * Remembers a workspace as deleted and strips its registry record, so a daemon that still holds it
 * in memory cannot bring it back. Used by the project pass too, so it is exported.
 */
export async function forgetWorkspace(workspaceId: string): Promise<void> {
  await updateDeletedState((known) => known.add(workspaceId));
  await stripWorkspaceRecord(workspaceId);
}

/** One workspace the cleanup actually removed, with what went with it (for the tick's log). */
export interface RemovedWorkspace {
  workspaceId: string;
  name: string | null;
  agents: number;
  deletedSessions: number;
}

export interface DeleteArchivedWorkspacesOutcome {
  removed: RemovedWorkspace[];
  deletedSessions: number;
  sessionFailures: number;
}

/**
 * Deletes every archived workspace, with the agents inside it. When `deleteProviderSessions` is on
 * the pi transcript goes first, because the record naming it is removed immediately after.
 *
 * Destructive and irreversible; off by default and only the settings (or the privacy button) start it.
 */
export async function deleteArchivedWorkspaces(
  paseo: PaseoLike,
  options: { deleteProviderSessions: boolean },
): Promise<DeleteArchivedWorkspacesOutcome> {
  const rows = await listWorkspaceRows();
  const records = await listAllAgents(paseo.agents.list as unknown as AgentLister);
  const byWorkspace = new Map<string, AgentRecord[]>();
  for (const record of records) {
    if (record.workspaceId === null) {
      continue;
    }
    const list = byWorkspace.get(record.workspaceId) ?? [];
    list.push(record);
    byWorkspace.set(record.workspaceId, list);
  }

  const removed: RemovedWorkspace[] = [];
  let deletedSessions = 0;
  let sessionFailures = 0;
  for (const row of rows) {
    if (row.archivedAt === null) {
      continue;
    }
    const agents = byWorkspace.get(row.workspaceId) ?? [];
    let workspaceSessions = 0;
    if (options.deleteProviderSessions && agents.length > 0) {
      const sessions = await deleteAgentSessionFiles(agents).catch(() => null);
      workspaceSessions = sessions?.deleted.length ?? 0;
      deletedSessions += workspaceSessions;
      sessionFailures += sessions?.failed.length ?? 0;
    }
    const result = await deleteWorkspace(paseo, row.workspaceId).catch(() => null);
    if (result?.ok) {
      removed.push({
        workspaceId: row.workspaceId,
        name: row.name,
        agents: agents.length,
        deletedSessions: workspaceSessions,
      });
    }
  }
  return { removed, deletedSessions, sessionFailures };
}

export interface DeleteArchivedAgentsOutcome {
  deletedAgents: number;
  deletedSessions: number;
  sessionFailures: number;
}

/**
 * Deletes every archived agent that lives in a workspace which is **not** archived (or in none at
 * all) — the rule "an archived agent goes even when its workspace stays" — with its own pi session
 * file when `deleteProviderSessions` is on. Agents inside an archived workspace belong to
 * `deleteArchivedWorkspaces`; keeping the two apart makes each switch mean one thing.
 */
export async function deleteArchivedAgents(
  paseo: PaseoLike,
  options: { deleteProviderSessions: boolean; includeArchivedWorkspaces?: boolean },
): Promise<DeleteArchivedAgentsOutcome> {
  const [rows, agents] = await Promise.all([
    listWorkspaceRows(),
    listAllAgents(paseo.agents.list as unknown as AgentLister),
  ]);
  const archivedWorkspaceIds = new Set(
    rows.filter((row) => row.archivedAt !== null).map((row) => row.workspaceId),
  );
  const remaining = agents.filter(
    (record) =>
      record.archivedAt !== null &&
      (options.includeArchivedWorkspaces === true ||
        record.workspaceId === null ||
        !archivedWorkspaceIds.has(record.workspaceId)),
  );
  if (remaining.length === 0) {
    return { deletedAgents: 0, deletedSessions: 0, sessionFailures: 0 };
  }
  let deletedSessions = 0;
  let sessionFailures = 0;
  if (options.deleteProviderSessions) {
    const sessions = await deleteAgentSessionFiles(remaining).catch(() => null);
    deletedSessions = sessions?.deleted.length ?? 0;
    sessionFailures = sessions?.failed.length ?? 0;
  }
  const result = await deleteAgents(remaining.map((record) => record.id));
  return { deletedAgents: result.deleted.length, deletedSessions, sessionFailures };
}

async function listWorkspaceAgents(
  paseo: PaseoLike,
  workspaceId: string,
): Promise<Array<{ id: string }>> {
  const records = await listAllAgents(paseo.agents.list as unknown as AgentLister);
  return records.filter((record) => record.workspaceId === workspaceId).map((record) => ({ id: record.id }));
}

async function readJsonList<T>(relativePath: string, key: string): Promise<T[]> {
  try {
    const raw = await readFile(join(paseoHome(), relativePath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed as T[];
    const nested = (parsed as Record<string, unknown> | null)?.[key];
    return Array.isArray(nested) ? (nested as T[]) : [];
  } catch {
    return [];
  }
}

async function readDeletedState(): Promise<Set<string>> {
  try {
    const raw = await readFile(join(paseoHome(), DELETED_PATH), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeletedState>;
    return new Set((parsed.workspaceIds ?? []).filter((id) => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function updateDeletedState(change: (known: Set<string>) => void): Promise<void> {
  return serializeWrite(async () => {
    const known = await readDeletedState();
    change(known);
    await writeJsonAtomic(join(paseoHome(), DELETED_PATH), {
      version: 1,
      workspaceIds: [...known].sort(),
    } satisfies DeletedState);
  });
}

function stripWorkspaceRecord(workspaceId: string): Promise<void> {
  return serializeWrite(async () => {
    const path = join(paseoHome(), REGISTRY_PATH);
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      const kept = (parsed as WorkspaceRecord[]).filter(
        (record) => str(record?.workspaceId) !== workspaceId,
      );
      if (kept.length === parsed.length) {
        return;
      }
      await writeJsonAtomic(path, kept);
    } catch {
      return;
    }
  });
}

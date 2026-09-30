import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArchiveOutcome,
  CloseGroupOutcome,
  DeleteWorkspaceOutcome,
  JobSnapshot,
  ProjectRow,
  RenameOutcome,
  WorkspaceRow,
} from "../shared/contracts";
import { listAllAgents, type AgentLister } from "./agents";
import { deleteAgents } from "./actions";
import { beginDaemonClientUse, endDaemonClientUse, getDaemonClient, type WorkspaceRecoveryState } from "./daemon-client";
import { paseoHome } from "./daemon-mcp";
import type { PaseoLike } from "./overview";
import {
  describe,
  normalizePath,
  pathBasename,
  serializeWrite,
  str,
  writeJsonAtomic,
} from "./util";

export interface WorkspaceAgent {
  id: string;
  title: string | null;
  status: string;
  archivedAt: string | null;
  parentAgentId: string | null;
}

export interface PaseoWorkspaceControl extends PaseoLike {
  workspaces: {
    archive(
      workspaceId: string,
      requestId?: string,
    ): Promise<{ archivedAt?: string | null; error?: string | null }>;
  };
}

interface WorkspaceRecord {
  workspaceId?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  kind?: unknown;
  title?: unknown;
  customName?: unknown;
  archivedAt?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  branch?: unknown;
  baseBranch?: unknown;
  worktreeRoot?: unknown;
  mainRepoRoot?: unknown;
  isPaseoOwnedWorktree?: unknown;
  pinnedAt?: unknown;
  autoArchivedChangeRequestUrl?: unknown;
}

interface ProjectRecord {
  projectId?: unknown;
  rootPath?: unknown;
  kind?: unknown;
  displayName?: unknown;
  customName?: unknown;
}

const JOBS = new Map<string, JobSnapshot>();
const ACTIVE_JOBS = new Map<string, string>();
const JOB_HISTORY = 8;
const ARCHIVE_BATCH_WINDOW_MS = 60000;
export const REGISTRY_PATH = "projects/workspaces.json";
const PROJECTS_PATH = "projects/projects.json";
const DELETED_PATH = "agent-manager/deleted-workspaces.json";

interface DeletedState {
  version: number;
  workspaceIds: string[];
}

export async function listProjectRows(): Promise<ProjectRow[]> {
  const projects = await readJsonList<ProjectRecord>(PROJECTS_PATH, "projects");
  const rows: ProjectRow[] = [];
  for (const project of projects) {
    const projectId = str(project.projectId);
    if (!projectId) {
      continue;
    }
    rows.push({
      projectId,
      name: str(project.customName) ?? str(project.displayName) ?? str(project.rootPath),
      rootPath: str(project.rootPath),
      kind: str(project.kind),
    });
  }
  return rows;
}

export async function listWorkspaceRows(): Promise<WorkspaceRow[]> {
  const [workspaces, projects, deleted] = await Promise.all([
    readJsonList<WorkspaceRecord>(REGISTRY_PATH, "workspaces"),
    listProjectRows(),
    readDeletedState(),
  ]);
  const projectById = new Map(projects.map((project) => [project.projectId, project]));

  const rows: WorkspaceRow[] = [];
  const reclaimed: string[] = [];
  for (const record of workspaces) {
    const workspaceId = str(record.workspaceId);
    if (!workspaceId) {
      continue;
    }
    if (deleted.has(workspaceId)) {
      if (str(record.archivedAt) !== null) {
        continue;
      }
      reclaimed.push(workspaceId);
    }
    const projectId = str(record.projectId);
    if (!projectId) {
      continue;
    }
    const project = projectById.get(projectId) ?? null;
    rows.push({
      workspaceId,
      projectId,
      name: str(record.title) ?? str(record.customName),
      cwd: str(record.cwd) ?? "",
      kind: str(record.kind) ?? "directory",
      branch: str(record.branch),
      baseBranch: str(record.baseBranch),
      worktreeRoot: str(record.worktreeRoot),
      mainRepoRoot: str(record.mainRepoRoot),
      isPaseoOwnedWorktree: record.isPaseoOwnedWorktree === true,
      pinnedAt: str(record.pinnedAt),
      autoArchivedChangeRequestUrl: str(record.autoArchivedChangeRequestUrl),
      archivedAt: str(record.archivedAt),
      createdAt: str(record.createdAt),
      updatedAt: str(record.updatedAt),
      projectName: project?.name ?? null,
      projectRoot: project?.rootPath ?? null,
    });
  }

  rows.sort((left, right) => {
    if (Boolean(left.archivedAt) !== Boolean(right.archivedAt)) {
      return left.archivedAt ? 1 : -1;
    }
    const byName = (left.name ?? left.cwd).localeCompare(right.name ?? right.cwd);
    if (byName !== 0) {
      return byName;
    }
    return (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "");
  });
  if (reclaimed.length > 0) {
    void forgetDeletedWorkspaces(reclaimed);
  }
  return rows;
}

export async function listWorkspaceAgents(paseo: PaseoLike, workspaceId: string): Promise<WorkspaceAgent[]> {
  const records = await listAllAgents(paseo.agents.list as unknown as AgentLister);
  return records
    .filter((record) => record.workspaceId === workspaceId)
    .map((record) => ({
      id: record.id,
      title: record.title,
      status: record.status,
      archivedAt: record.archivedAt,
      parentAgentId: record.parentAgentId,
    }));
}

export async function renameWorkspace(workspaceId: string, title: string | null): Promise<RenameOutcome> {
  const trimmed = title?.trim() ?? "";
  const next = trimmed.length === 0 ? null : trimmed;
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    const result = await client.setWorkspaceTitle(workspaceId, next);
    return {
      ok: true,
      title: result.title,
      message:
        result.title === null
          ? "Workspace name reset to the directory default."
          : `Workspace renamed to "${result.title}".`,
    };
  } catch (error) {
    return { ok: false, title: null, message: describe(error) };
  } finally {
    endDaemonClientUse();
  }
}

export async function archiveWorkspace(
  paseo: PaseoWorkspaceControl,
  workspaceId: string,
  options: { confirmLastActive?: boolean } = {},
): Promise<ArchiveOutcome> {
  const rows = await listWorkspaceRows();
  const target = rows.find((row) => row.workspaceId === workspaceId) ?? null;
  const pathRows = target ? rows.filter((row) => samePath(row, target)) : [];
  const activeAtPath = pathRows.filter((row) => row.archivedAt === null);
  const isLastActive = activeAtPath.length === 1 && activeAtPath[0]?.workspaceId === workspaceId;
  const reopenCandidate = isLastActive ? oldestArchived(pathRows, workspaceId) : null;

  const reopenLabel = reopenCandidate ? (reopenCandidate.name ?? pathBasename(target?.cwd ?? "")) : null;
  const before = await listWorkspaceAgents(paseo, workspaceId).catch(() => []);
  const empty = before.length === 0;
  if (isLastActive && !empty && options.confirmLastActive !== true) {
    return {
      ok: false,
      refused: true,
      message:
        reopenCandidate === null
          ? `${target?.cwd ?? workspaceId} would be left without an active workspace.`
          : `This is the last active workspace at ${target?.cwd ?? workspaceId}. Paseo resolves directory workspaces by path, so the next open reopens "${reopenLabel}" instead.`,
      archivedAt: null,
      activeAtPath: activeAtPath.length,
      willReopen: reopenCandidate,
      touchedOthers: [],
    };
  }

  const statesBefore = new Map(rows.map((row) => [row.workspaceId, row.archivedAt]));
  const result = await paseo.workspaces.archive(workspaceId);
  const archivedAt = result?.archivedAt ?? null;
  if (!archivedAt) {
    return {
      ok: false,
      refused: false,
      message: result?.error ?? "The daemon did not archive the workspace.",
      archivedAt: null,
      activeAtPath: activeAtPath.length,
      willReopen: reopenCandidate,
      touchedOthers: [],
    };
  }

  const afterwards = await listWorkspaceRows().catch(() => []);
  const touchedOthers = afterwards
    .filter((row) => row.workspaceId !== workspaceId)
    .filter((row) => statesBefore.has(row.workspaceId) && statesBefore.get(row.workspaceId) !== row.archivedAt)
    .map((row) => row.workspaceId);
  const tabs = before.filter((agent) => agent.parentAgentId === null).length;

  if (empty) {
    const removal = await deleteWorkspace(paseo, workspaceId).catch(() => null);
    if (removal?.ok) {
      return {
        ok: true,
        refused: false,
        message: "Empty workspace archived and removed — it has no session records",
        archivedAt,
        activeAtPath: activeAtPath.length,
        willReopen: reopenCandidate,
        touchedOthers,
      };
    }
  }

  return {
    ok: true,
    refused: false,
    message: `Workspace archived · ${tabs} session(s) stopped${touchedOthers.length > 0 ? ` · ${touchedOthers.length} other workspace(s) changed state` : ""}`,
    archivedAt,
    activeAtPath: activeAtPath.length,
    willReopen: reopenCandidate,
    touchedOthers,
  };
}

export async function closeWorkspaceTabs(paseo: PaseoLike, workspaceId: string): Promise<CloseGroupOutcome> {
  const agents = await listWorkspaceAgents(paseo, workspaceId);
  const targets = agents.filter((agent) => agent.archivedAt === null && agent.parentAgentId === null);
  const statesBefore = await workspaceStates();
  if (targets.length === 0) {
    return { ok: true, message: "No open tab in this workspace.", closed: [], touchedOthers: [] };
  }
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    await client.closeItems({ agentIds: targets.map((agent) => agent.id), terminalIds: [] });
  } finally {
    endDaemonClientUse();
  }
  const touchedOthers = await changedOthers(statesBefore, workspaceId);
  return {
    ok: true,
    message: `Closed ${targets.length} tab(s)${touchedOthers.length > 0 ? ` · ${touchedOthers.length} other workspace(s) changed state` : ""}`,
    closed: targets.map((agent) => agent.id),
    touchedOthers,
  };
}

async function workspaceStates(): Promise<Map<string, string | null>> {
  const rows = await listWorkspaceRows().catch(() => []);
  return new Map(rows.map((row) => [row.workspaceId, row.archivedAt]));
}

async function changedOthers(before: Map<string, string | null>, workspaceId: string): Promise<string[]> {
  const after = await workspaceStates();
  return [...after]
    .filter(([id, value]) => id !== workspaceId && before.has(id) && before.get(id) !== value)
    .map(([id]) => id);
}

export async function deleteWorkspace(paseo: PaseoLike, workspaceId: string): Promise<DeleteWorkspaceOutcome> {
  const rows = await listWorkspaceRows();
  const target = rows.find((row) => row.workspaceId === workspaceId) ?? null;
  if (!target) {
    if (!(await readDeletedState()).has(workspaceId)) {
      return {
        ok: false,
        message: "Unknown workspace.",
        deletedAgents: [],
        failed: [],
      };
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

  await rememberDeletedWorkspace(workspaceId);
  await stripWorkspaceRecord(workspaceId);
  return {
    ok: true,
    message: `Deleted workspace "${target.name ?? pathBasename(target.cwd)}" with ${removed.deleted.length} session(s).`,
    deletedAgents: removed.deleted,
    failed: removed.failed,
  };
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

function rememberDeletedWorkspace(workspaceId: string): Promise<void> {
  return updateDeletedState((known) => known.add(workspaceId));
}

function forgetDeletedWorkspaces(workspaceIds: string[]): Promise<void> {
  return updateDeletedState((known) => {
    for (const id of workspaceIds) {
      known.delete(id);
    }
  });
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
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      const kept = (parsed as WorkspaceRecord[]).filter((record) => str(record?.workspaceId) !== workspaceId);
      if (kept.length === parsed.length) {
        return;
      }
      await writeJsonAtomic(path, kept);
    } catch {
      return;
    }
  });
}

function samePath(left: WorkspaceRow, right: WorkspaceRow): boolean {
  return left.projectId === right.projectId && normalizePath(left.cwd) === normalizePath(right.cwd);
}

function oldestArchived(rows: WorkspaceRow[], includingWorkspaceId: string): { workspaceId: string; name: string | null } | null {
  const candidates = rows
    .filter((row) => row.archivedAt !== null || row.workspaceId === includingWorkspaceId)
    .sort((left, right) => {
      const byCreated = (left.createdAt ?? "").localeCompare(right.createdAt ?? "");
      if (byCreated !== 0) {
        return byCreated;
      }
      return left.workspaceId.localeCompare(right.workspaceId);
    });
  const found = candidates[0];
  return found ? { workspaceId: found.workspaceId, name: found.name } : null;
}

interface StartJobInput {
  paseo: PaseoLike;
  workspaceId: string;
  workspaceName: string;
  tabsOnly: boolean;
}

export function startWorkspaceJob(input: StartJobInput): JobSnapshot {
  const inFlight = ACTIVE_JOBS.get(input.workspaceId);
  if (inFlight) {
    const existing = JOBS.get(inFlight);
    if (existing && !existing.finished) {
      return existing;
    }
    ACTIVE_JOBS.delete(input.workspaceId);
  }
  const job: JobSnapshot = {
    jobId: randomUUID(),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    phase: input.tabsOnly ? "tabs" : "workspace",
    total: 0,
    done: 0,
    current: null,
    restoredWorkspace: false,
    failed: [],
    message: input.tabsOnly ? "Collecting closed tabs…" : "Restoring workspace…",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    finished: false,
  };
  remember(job);
  ACTIVE_JOBS.set(input.workspaceId, job.jobId);
  void runWorkspaceJob(job, input);
  return job;
}

export function readJob(jobId: string): JobSnapshot | null {
  return JOBS.get(jobId) ?? null;
}

function remember(job: JobSnapshot): void {
  JOBS.set(job.jobId, job);
  while (JOBS.size > JOB_HISTORY) {
    const oldest = JOBS.keys().next().value;
    if (typeof oldest !== "string") {
      return;
    }
    JOBS.delete(oldest);
  }
}

async function runWorkspaceJob(job: JobSnapshot, input: StartJobInput): Promise<void> {
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    let batchArchivedAt: string | null = null;
    if (!input.tabsOnly) {
      const rows = await listWorkspaceRows().catch(() => []);
      batchArchivedAt = rows.find((row) => row.workspaceId === input.workspaceId)?.archivedAt ?? null;
      await restoreWorkspaceForTabs(client, job, input.workspaceId);
    }

    const agents = await listWorkspaceAgents(input.paseo, input.workspaceId);
    const archivedRoots = agents.filter((agent) => agent.archivedAt !== null && agent.parentAgentId === null);
    const targets = archivedRoots.filter((agent) => inArchiveBatch(agent.archivedAt, batchArchivedAt));
    const keptClosed = archivedRoots.length - targets.length;
    job.total = targets.length;
    job.phase = "tabs";
    if (targets.length === 0) {
      job.message = job.restoredWorkspace
        ? `Workspace restored. No tab was open when it was archived${keptClosed > 0 ? ` (${keptClosed} older closure kept closed)` : ""}.`
        : "No closed tab in this workspace.";
      job.phase = "done";
      return;
    }
    job.message = null;

    for (const target of targets) {
      job.current = target.title ?? target.id.slice(0, 7);
      try {
        await client.refreshAgent(target.id);
      } catch (error) {
        job.failed.push({ agentId: target.id, error: describe(error) });
      }
      job.done += 1;
    }

    job.phase = "done";
    job.message = summarize(job, keptClosed);
  } catch (error) {
    job.phase = "failed";
    job.message = describe(error);
  } finally {
    job.current = null;
    job.finishedAt = new Date().toISOString();
    job.finished = true;
    if (ACTIVE_JOBS.get(input.workspaceId) === job.jobId) {
      ACTIVE_JOBS.delete(input.workspaceId);
    }
    endDaemonClientUse();
  }
}

async function restoreWorkspaceForTabs(
  client: Awaited<ReturnType<typeof getDaemonClient>>,
  job: JobSnapshot,
  workspaceId: string,
): Promise<void> {
  const recovery = await inspectRecovery(client, workspaceId);
  if (recovery && recovery.kind !== "recoverable" && recovery.kind !== "unavailable") {
    throw new Error(`Unexpected recovery state: ${recovery.kind}`);
  }
  if (recovery?.kind === "unavailable" && recovery.reason !== "workspace_not_archived") {
    throw new Error(recovery.message ?? recovery.reason ?? "The workspace cannot be restored.");
  }
  if (recovery?.kind !== "recoverable") {
    return;
  }
  job.message =
    recovery.action === "restore" ? "Recreating the worktree from its branch…" : "Unarchiving the workspace…";
  await client.restoreWorkspace(workspaceId);
  job.restoredWorkspace = true;
}

async function inspectRecovery(
  client: { inspectWorkspaceRecovery(workspaceId: string): Promise<WorkspaceRecoveryState> },
  workspaceId: string,
): Promise<WorkspaceRecoveryState | null> {
  try {
    return await client.inspectWorkspaceRecovery(workspaceId);
  } catch (error) {
    const message = describe(error);
    if (/not[_ ]archived/i.test(message)) {
      return { kind: "unavailable", reason: "workspace_not_archived", message };
    }
    throw error;
  }
}

function summarize(job: JobSnapshot, keptClosed: number): string {
  const head = job.restoredWorkspace ? "Workspace restored" : "Tabs reopened";
  const failed = job.failed.length > 0 ? ` · ${job.failed.length} failed` : "";
  const older = keptClosed > 0 ? ` · ${keptClosed} older tab kept closed` : "";
  return `${head} · ${job.done - job.failed.length}/${job.total} tabs${failed}${older}`;
}

function inArchiveBatch(agentArchivedAt: string | null, workspaceArchivedAt: string | null): boolean {
  if (agentArchivedAt === null) {
    return false;
  }
  if (workspaceArchivedAt === null) {
    return true;
  }
  const agentMs = Date.parse(agentArchivedAt);
  const workspaceMs = Date.parse(workspaceArchivedAt);
  if (!Number.isFinite(agentMs) || !Number.isFinite(workspaceMs)) {
    return true;
  }
  return Math.abs(agentMs - workspaceMs) <= ARCHIVE_BATCH_WINDOW_MS;
}

async function readJsonList<T>(relativePath: string, key: string): Promise<T[]> {
  try {
    const raw = await readFile(join(paseoHome(), relativePath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
    if (parsed && typeof parsed === "object") {
      const nested = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(nested)) {
        return nested as T[];
      }
    }
    return [];
  } catch {
    return [];
  }
}

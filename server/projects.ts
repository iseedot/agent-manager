import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { listAllAgents, type AgentLister, type PaseoLike } from "./agents";
import { deleteAgents } from "./actions";
import { deleteProjectViaCli } from "./cli";
import { paseoHome } from "./daemon-mcp";
import { deleteAgentSessionFiles } from "./provider-sessions";
import { forgetWorkspace, listWorkspaceRows } from "./workspaces";
import { str } from "./util";

/**
 * The daemon's project registry (`projects/projects.json`). The plugin only reads it, and only to
 * find the archived projects the privacy cleanup removes, together with their workspaces and agents.
 */

export interface ProjectRow {
  projectId: string;
  name: string | null;
  rootPath: string;
  archivedAt: string | null;
}

interface ProjectRecord {
  projectId?: unknown;
  displayName?: unknown;
  customName?: unknown;
  rootPath?: unknown;
  archivedAt?: unknown;
}

const PROJECTS_PATH = "projects/projects.json";

export async function listProjectRows(): Promise<ProjectRow[]> {
  const records = await readJsonList<ProjectRecord>(PROJECTS_PATH, "projects");
  const rows: ProjectRow[] = [];
  for (const record of records) {
    const projectId = str(record.projectId);
    if (!projectId) {
      continue;
    }
    rows.push({
      projectId,
      name: str(record.customName) ?? str(record.displayName),
      rootPath: str(record.rootPath) ?? "",
      archivedAt: str(record.archivedAt),
    });
  }
  return rows;
}

export interface DeleteArchivedProjectsOutcome {
  deletedProjects: number;
  deletedSessions: number;
  sessionFailures: number;
}

/**
 * Deletes every archived project with everything under it: each of its workspaces, every agent in
 * those workspaces, and — when `deleteProviderSessions` is on — each agent's pi transcript. The
 * workspace pass in the privacy cleanup already handles archived workspaces, so this is mostly the
 * project record plus any leftover agent; deleting them here keeps the cascade complete even when
 * only the project is archived.
 *
 * The project record itself goes through the daemon's own `paseo project delete`, so its registry
 * and the workspace records it owns stay consistent.
 */
export async function deleteArchivedProjects(
  paseo: PaseoLike,
  options: { deleteProviderSessions: boolean },
): Promise<DeleteArchivedProjectsOutcome> {
  const [projects, workspaceRows, agents] = await Promise.all([
    listProjectRows(),
    listWorkspaceRows(),
    listAllAgents(paseo.agents.list as unknown as AgentLister),
  ]);
  const archived = projects.filter((project) => project.archivedAt !== null);
  if (archived.length === 0) {
    return { deletedProjects: 0, deletedSessions: 0, sessionFailures: 0 };
  }

  const archivedIds = new Set(archived.map((project) => project.projectId));
  const workspaceIds = new Set(
    workspaceRows
      .filter((row) => row.projectId !== null && archivedIds.has(row.projectId))
      .map((row) => row.workspaceId),
  );
  const projectAgents = agents.filter(
    (agent) => agent.workspaceId !== null && workspaceIds.has(agent.workspaceId),
  );

  let deletedSessions = 0;
  let sessionFailures = 0;
  if (options.deleteProviderSessions && projectAgents.length > 0) {
    const sessions = await deleteAgentSessionFiles(projectAgents).catch(() => null);
    deletedSessions = sessions?.deleted.length ?? 0;
    sessionFailures = sessions?.failed.length ?? 0;
  }
  if (projectAgents.length > 0) {
    await deleteAgents(projectAgents.map((agent) => agent.id));
  }
  for (const workspaceId of workspaceIds) {
    await forgetWorkspace(workspaceId);
  }

  let deletedProjects = 0;
  for (const project of archived) {
    const result = await deleteProjectViaCli(project.projectId);
    if (result.ok) {
      deletedProjects += 1;
    }
  }
  return { deletedProjects, deletedSessions, sessionFailures };
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

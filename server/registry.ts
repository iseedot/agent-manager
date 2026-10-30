import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { paseoHome } from "./daemon";
import { serializeWrite, str, writeJsonAtomic } from "./util";

/**
 * The daemon's two registry files — `projects/workspaces.json` and `projects/projects.json` — plus the
 * ledger of workspaces this plugin already removed. They are read once per cleanup; nothing else in
 * the plugin touches them.
 */

export interface WorkspaceRow {
  workspaceId: string;
  projectId: string | null;
  name: string | null;
  archivedAt: string | null;
}

export interface ProjectRow {
  projectId: string;
  name: string | null;
  archivedAt: string | null;
}

interface WorkspaceRecord {
  workspaceId?: unknown;
  projectId?: unknown;
  title?: unknown;
  customName?: unknown;
  archivedAt?: unknown;
}

interface ProjectRecord {
  projectId?: unknown;
  displayName?: unknown;
  customName?: unknown;
  archivedAt?: unknown;
}

const WORKSPACES_PATH = "projects/workspaces.json";
const PROJECTS_PATH = "projects/projects.json";
const DELETED_PATH = "agent-manager/deleted-workspaces.json";

export async function readWorkspaces(): Promise<WorkspaceRow[]> {
  const [records, deleted] = await Promise.all([
    readJsonObjects<WorkspaceRecord>(WORKSPACES_PATH, "workspaces"),
    readDeletedWorkspaces(),
  ]);
  const rows: WorkspaceRow[] = [];
  const reclaimed: string[] = [];
  for (const record of records) {
    const workspaceId = str(record.workspaceId);
    if (!workspaceId) {
      continue;
    }
    if (deleted.has(workspaceId)) {
      // The daemon keeps the record in memory and writes it back, so a removed workspace that is
      // active again was resurrected: stop hiding it.
      if (str(record.archivedAt) !== null) {
        continue;
      }
      reclaimed.push(workspaceId);
    }
    rows.push({
      workspaceId,
      projectId: str(record.projectId),
      name: str(record.title) ?? str(record.customName),
      archivedAt: str(record.archivedAt),
    });
  }
  if (reclaimed.length > 0) {
    void updateDeletedWorkspaces((known) => {
      for (const workspaceId of reclaimed) {
        known.delete(workspaceId);
      }
    });
  }
  return rows;
}

export async function readProjects(): Promise<ProjectRow[]> {
  const records = await readJsonObjects<ProjectRecord>(PROJECTS_PATH, "projects");
  const rows: ProjectRow[] = [];
  for (const record of records) {
    const projectId = str(record.projectId);
    if (!projectId) {
      continue;
    }
    rows.push({
      projectId,
      name: str(record.customName) ?? str(record.displayName),
      archivedAt: str(record.archivedAt),
    });
  }
  return rows;
}

/**
 * Drops a workspace for good: the ledger stops the daemon's in-memory record from bringing it back,
 * and the registry entry is stripped so a later daemon restart does not resurrect it either.
 */
export async function forgetWorkspace(workspaceId: string): Promise<void> {
  await updateDeletedWorkspaces((known) => known.add(workspaceId));
  await serializeWrite(async () => {
    const path = join(paseoHome(), WORKSPACES_PATH);
    let records: WorkspaceRecord[];
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      records = parsed as WorkspaceRecord[];
    } catch {
      return;
    }
    const kept = records.filter((record) => str(record?.workspaceId) !== workspaceId);
    if (kept.length !== records.length) {
      await writeJsonAtomic(path, kept);
    }
  });
}

/** Accepts both `[...]` and `{ <key>: [...] }`, the two shapes the registries have used. */
async function readJsonObjects<T>(relativePath: string, key: string): Promise<T[]> {
  try {
    const parsed = JSON.parse(await readFile(join(paseoHome(), relativePath), "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
    const nested = (parsed as Record<string, unknown> | null)?.[key];
    return Array.isArray(nested) ? (nested as T[]) : [];
  } catch {
    return [];
  }
}

/** The ledger is an object rather than a list, so it bypasses `readJsonObjects`. */
async function readDeletedFile(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(paseoHome(), DELETED_PATH), "utf8")) as {
      workspaceIds?: unknown;
    };
    const ids = Array.isArray(parsed.workspaceIds) ? parsed.workspaceIds : [];
    return ids.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function readDeletedWorkspaces(): Promise<Set<string>> {
  return readDeletedFile().then((ids) => new Set(ids));
}

function updateDeletedWorkspaces(change: (known: Set<string>) => void): Promise<void> {
  return serializeWrite(async () => {
    const known = new Set(await readDeletedFile());
    change(known);
    await writeJsonAtomic(join(paseoHome(), DELETED_PATH), {
      version: 1,
      workspaceIds: [...known].sort(),
    });
  });
}

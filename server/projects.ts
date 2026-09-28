import { spawn } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { paseoHome } from "./daemon-mcp";
import { describe, pathBasename, serializeWrite, str, writeJsonAtomic } from "./util";
import { PROJECTS_PATH, REGISTRY_PATH, readJsonList } from "./workspaces";

export interface ProjectRow {
  projectId: string;
  name: string | null;
  rootPath: string;
  archived: boolean;
  workspaceCount: number;
}

export type MovePhase = "idle" | "pending" | "applied" | "failed";

export interface MoveStatus {
  phase: MovePhase;
  workspaceId: string | null;
  workspaceName: string | null;
  fromProjectId: string | null;
  toProjectId: string | null;
  toProjectName: string | null;
  moveDirectory: boolean;
  message: string;
  at: string | null;
}

interface WorkspaceRecord {
  workspaceId?: unknown;
  projectId?: unknown;
  cwd?: unknown;
  kind?: unknown;
  title?: unknown;
  customName?: unknown;
  displayName?: unknown;
  archivedAt?: unknown;
}

interface ProjectRecord {
  projectId?: unknown;
  rootPath?: unknown;
  kind?: unknown;
  displayName?: unknown;
  customName?: unknown;
  archivedAt?: unknown;
}

const STATUS_PATH = "agent-manager/move-status.json";
const WORKER_PATH = "agent-manager/move-worker.mjs";
const STALE_PENDING_MS = 5 * 60 * 1000;
const BUSY_PENDING_MS = 3 * 60 * 1000;

const IDLE_STATUS: MoveStatus = {
  phase: "idle",
  workspaceId: null,
  workspaceName: null,
  fromProjectId: null,
  toProjectId: null,
  toProjectName: null,
  moveDirectory: false,
  message: "No move has run yet.",
  at: null,
};

function projectName(record: ProjectRecord): string | null {
  return str(record.customName) ?? str(record.displayName) ?? str(record.rootPath);
}

export async function listProjectRows(): Promise<ProjectRow[]> {
  const [projects, workspaces] = await Promise.all([
    readJsonList<ProjectRecord>(PROJECTS_PATH, "projects"),
    readJsonList<WorkspaceRecord>(REGISTRY_PATH, "workspaces"),
  ]);
  const counts = new Map<string, number>();
  for (const record of workspaces) {
    const projectId = str(record.projectId);
    if (!projectId) {
      continue;
    }
    counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
  }
  const rows: ProjectRow[] = [];
  for (const project of projects) {
    const projectId = str(project.projectId);
    if (!projectId) {
      continue;
    }
    rows.push({
      projectId,
      name: projectName(project),
      rootPath: str(project.rootPath) ?? "",
      archived: str(project.archivedAt) !== null,
      workspaceCount: counts.get(projectId) ?? 0,
    });
  }
  rows.sort((left, right) => (left.name ?? left.rootPath).localeCompare(right.name ?? right.rootPath));
  return rows;
}

export async function readMoveStatus(): Promise<MoveStatus> {
  let parsed: Partial<MoveStatus>;
  try {
    parsed = JSON.parse(await readFile(join(paseoHome(), STATUS_PATH), "utf8")) as Partial<MoveStatus>;
  } catch {
    return IDLE_STATUS;
  }
  const status: MoveStatus = {
    phase: isPhase(parsed.phase) ? parsed.phase : "idle",
    workspaceId: str(parsed.workspaceId),
    workspaceName: str(parsed.workspaceName),
    fromProjectId: str(parsed.fromProjectId),
    toProjectId: str(parsed.toProjectId),
    toProjectName: str(parsed.toProjectName),
    moveDirectory: parsed.moveDirectory === true,
    message: typeof parsed.message === "string" ? parsed.message : "",
    at: str(parsed.at),
  };
  if (status.phase !== "pending") {
    return status;
  }
  const started = status.at ? Date.parse(status.at) : Number.NaN;
  if (Number.isFinite(started) && Date.now() - started > STALE_PENDING_MS) {
    return {
      ...status,
      phase: "failed",
      message: "The move never finished. Check the daemon on the host, then try again.",
    };
  }
  return status;
}

function isPhase(value: unknown): value is MovePhase {
  return value === "idle" || value === "pending" || value === "applied" || value === "failed";
}

export interface MoveOutcome {
  ok: boolean;
  message: string;
  move: MoveStatus;
}

export async function moveWorkspace(input: {
  workspaceId: string;
  projectId: string;
  moveDirectory: boolean;
}): Promise<MoveOutcome> {
  const home = paseoHome();
  const previous = await readMoveStatus();
  if (previous.phase === "pending") {
    const started = previous.at ? Date.parse(previous.at) : Number.NaN;
    if (!Number.isFinite(started) || Date.now() - started < BUSY_PENDING_MS) {
      return { ok: false, message: "Another move is still running.", move: previous };
    }
  }

  const [workspaces, projects] = await Promise.all([
    readJsonList<WorkspaceRecord>(REGISTRY_PATH, "workspaces"),
    readJsonList<ProjectRecord>(PROJECTS_PATH, "projects"),
  ]);
  const record = workspaces.find((entry) => str(entry.workspaceId) === input.workspaceId);
  if (!record) {
    return reject("Unknown workspace. Refresh the list and try again.");
  }
  const fromProjectId = str(record.projectId);
  const target = projects.find((entry) => str(entry.projectId) === input.projectId) ?? null;
  if (!target) {
    return reject("That project does not exist in Paseo. Create it first, then move again.");
  }
  const toProjectName = projectName(target);
  if (str(target.archivedAt)) {
    return reject(`"${toProjectName ?? input.projectId}" is archived. Restore it before moving into it.`);
  }
  if (target.projectId === fromProjectId) {
    return reject("The workspace already belongs to that project.");
  }

  const currentCwd = str(record.cwd) ?? "";
  const targetRoot = str(target.rootPath) ?? "";
  let nextCwd: string | null = null;
  if (input.moveDirectory) {
    if (!targetRoot) {
      return reject("That project has no root directory, so the workspace directory cannot follow.");
    }
    const info = await stat(targetRoot).catch(() => null);
    if (!info || !info.isDirectory()) {
      return reject(`Project root is not a directory: ${targetRoot}`);
    }
    nextCwd = targetRoot === currentCwd ? null : targetRoot;
  }

  const workspaceName = str(record.title) ?? str(record.customName) ?? str(record.displayName) ?? currentCwd;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { projectId: input.projectId };
  if (nextCwd) {
    const isGitProject = str(target.kind) === "git";
    patch.cwd = nextCwd;
    patch.displayName = pathBasename(nextCwd);
    patch.kind = isGitProject ? "local_checkout" : "directory";
    patch.branch = null;
    patch.worktreeRoot = isGitProject ? nextCwd : null;
    patch.baseBranch = null;
    patch.isPaseoOwnedWorktree = false;
    patch.mainRepoRoot = null;
  }

  const status: MoveStatus = {
    phase: "pending",
    workspaceId: input.workspaceId,
    workspaceName,
    fromProjectId,
    toProjectId: input.projectId,
    toProjectName,
    moveDirectory: nextCwd !== null,
    message: "Stopping the daemon",
    at: now,
  };

  const statusFile = join(home, STATUS_PATH);
  const workerFile = join(home, WORKER_PATH);
  try {
    await serializeWrite(async () => {
      await writeJsonAtomic(statusFile, status);
      await writeFile(workerFile, WORKER_SOURCE, "utf8");
    });
  } catch (error) {
    return reject(`Could not stage the move: ${describe(error)}`);
  }

  const cli = str(process.env.PASEO_AGENT_MANAGER_CLI) ?? "paseo";
  const plan = {
    home,
    cli,
    daemonPid: await readDaemonPid(home),
    registryPath: join(home, REGISTRY_PATH),
    statusPath: statusFile,
    workspaceId: input.workspaceId,
    patch,
    now,
    status,
  };

  try {
    const child = spawn(process.execPath, [workerFile, JSON.stringify(plan)], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PASEO_HOME: home },
    });
    child.unref();
  } catch (error) {
    await writeJsonAtomic(statusFile, { ...status, phase: "failed", message: `Could not start the move: ${describe(error)}` });
    return reject(`Could not start the move: ${describe(error)}`);
  }

  return {
    ok: true,
    message: `Moving "${workspaceName}" to ${toProjectName ?? input.projectId}${
      nextCwd ? ` with directory ${nextCwd}` : ""
    }. Paseo restarts now; this panel reconnects in a few seconds.`,
    move: status,
  };

  function reject(message: string): MoveOutcome {
    return { ok: false, message, move: { ...IDLE_STATUS, phase: "idle", message, at: null } };
  }
}

async function readDaemonPid(home: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { pid?: unknown };
    const pid = Number(parsed.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

const WORKER_SOURCE = `import { spawn } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';

const plan = JSON.parse(process.argv[2] ?? '{}');
const env = { ...process.env, PASEO_HOME: plan.home };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (patch) => writeFile(plan.statusPath, JSON.stringify({ ...plan.status, ...patch }, null, 2), 'utf8');
const run = (args) => new Promise((resolve) => {
  const child = spawn(plan.cli, args, { env, stdio: 'ignore' });
  child.on('error', () => resolve(false));
  child.on('close', (code) => resolve(code === 0));
});
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitGone = async (pid) => {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (!alive(pid)) {
      return true;
    }
    await sleep(250);
  }
  return !alive(pid);
};
const label = (text) => '"' + String(text ?? '') + '"';

const main = async () => {
  await sleep(1500);
  await write({ phase: 'pending', message: 'Stopping the daemon' });
  await run(['daemon', 'stop', '--home', plan.home]);
  const stopped = plan.daemonPid > 0 ? await waitGone(plan.daemonPid) : true;
  let ok = false;
  let message = 'The daemon did not stop in time, so nothing was changed. Try again.';
  if (stopped) {
    await sleep(800);
    try {
      const raw = await readFile(plan.registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error('the registry is not a list');
      }
      const index = parsed.findIndex((record) => record && record.workspaceId === plan.workspaceId);
      if (index < 0) {
        throw new Error('the workspace record is gone');
      }
      await writeFile(plan.registryPath + '.agent-manager.bak', raw, 'utf8');
      const next = parsed.slice();
      next[index] = { ...parsed[index], ...plan.patch, updatedAt: plan.now };
      const temporary = plan.registryPath + '.agent-manager.tmp';
      await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
      await rename(temporary, plan.registryPath);
      ok = true;
      message =
        'Moved ' +
        label(plan.status.workspaceName) +
        ' to ' +
        label(plan.status.toProjectName) +
        (plan.patch.cwd ? ' and set the working directory to ' + plan.patch.cwd : '') +
        '.';
    } catch (error) {
      message =
        'Could not rewrite the workspace registry: ' +
        (error instanceof Error ? error.message : String(error)) +
        '. Nothing was changed.';
    }
  }
  const at = new Date().toISOString();
  await write({ phase: ok ? 'applied' : 'failed', message, at });
  const started = await run(['daemon', 'start', '--home', plan.home]);
  if (!started) {
    await write({
      phase: 'failed',
      message: message + ' The daemon did not start; run paseo daemon start on the host.',
      at,
    });
  }
};

main().catch(async (error) => {
  await write({
    phase: 'failed',
    message: 'The move failed: ' + (error instanceof Error ? error.message : String(error)),
    at: new Date().toISOString(),
  });
  await run(['daemon', 'start', '--home', plan.home]);
});
`;

import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { noticeName, recordNotice } from "./notices";

/**
 * Project git bootstrap.
 *
 * Paseo worktrees need a repository with at least one commit, but a brand new project directory
 * is empty. This module prepares such a directory right before Paseo provisions a workspace:
 *
 * - directory is not a directory             -> nothing happens
 * - directory is already a repository        -> nothing happens (cloned/added repos are untouched)
 * - repository exists without any commit     -> a notice is recorded (worktrees would fail)
 * - inside another repository (subdirectory) -> nothing happens
 * - directory has entries but no repository  -> nothing happens (never touch existing files)
 * - empty directory without a repository     -> git init + one empty commit
 * - git is not installed                     -> a notice is recorded
 */

const GIT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMITTER_NAME = "Paseo";
const COMMITTER_EMAIL = "paseo@localhost";

/** Directory entries that still count as "empty" — files an OS creates on its own. */
const IGNORED_EMPTY_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]);

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        resolvePromise({ ok: !error, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

let gitAvailability: Promise<boolean> | null = null;

export function gitAvailable(): Promise<boolean> {
  gitAvailability ??= runGit(["--version"], process.cwd()).then((result) => result.ok);
  return gitAvailability;
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function hasRepositoryEntry(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function hasNoEntries(directory: string): Promise<boolean> {
  try {
    const entries = await readdir(directory);
    return entries.every((name) => IGNORED_EMPTY_ENTRIES.has(name));
  } catch {
    return false;
  }
}

export async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path));
  } catch {
    return null;
  }
}

export function firstLine(value: string): string {
  const line = value
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? "";
}

export function describeFailure(result: GitResult): string {
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return detail ? `: ${detail}` : "";
}

const inFlight = new Map<string, Promise<void>>();

/** Idempotent, deduplicated per directory. Callers must not depend on it rejecting. */
export function ensureProjectRepository(directory: string): Promise<void> {
  const key = resolve(directory);
  const running = inFlight.get(key);
  if (running) return running;
  const work = runEnsureProjectRepository(key).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, work);
  return work;
}

async function runEnsureProjectRepository(directory: string): Promise<void> {
  if (!(await isDirectory(directory))) {
    return;
  }
  const canonical = (await canonicalPath(directory)) ?? directory;

  if (!(await gitAvailable())) {
    if ((await hasRepositoryEntry(directory)) || (await hasNoEntries(directory))) {
      recordNotice({
        level: "warning",
        kind: "git-missing",
        directory: canonical,
        title: "git not installed",
        message:
          "git is not installed on this host, so Paseo could not set up this project repository. Install git and create the workspace again for worktree support.",
      });
    }
    return;
  }

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], directory);
  if (toplevel.ok) {
    const repoRoot = await canonicalPath(toplevel.stdout.trim());
    if (repoRoot !== null && repoRoot !== canonical) {
      // The directory lives inside another repository; it has a repository already.
      return;
    }
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], directory);
    if (!head.ok) {
      recordNotice({
        level: "warning",
        kind: "repo-no-commit",
        directory: canonical,
        title: `${noticeName(canonical)} · repo has no commit`,
        message:
          "This repository has no commit yet. Paseo worktrees need one, so commit something (git commit --allow-empty -m init) before creating a worktree workspace.",
      });
    }
    return;
  }

  if (!(await hasNoEntries(directory))) {
    // Existing content without a repository: never turn someone's folder into a repo behind their back.
    return;
  }

  const initialized = (await runGit(["init", "-b", "main"], directory)).ok
    ? { ok: true, stdout: "", stderr: "" }
    : await runGit(["init"], directory);
  if (!initialized.ok) {
    recordNotice({
      level: "error",
      kind: "init-failed",
      directory: canonical,
      title: `${noticeName(canonical)} · git init failed`,
      message: `git init failed${describeFailure(initialized)}`,
    });
    return;
  }

  const commit = await runGit(
    [
      "-c",
      `user.name=${COMMITTER_NAME}`,
      "-c",
      `user.email=${COMMITTER_EMAIL}`,
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit",
    ],
    directory,
  );
  if (!commit.ok) {
    recordNotice({
      level: "error",
      kind: "init-failed",
      directory: canonical,
      title: `${noticeName(canonical)} · initial commit failed`,
      message: `git init worked but the initial commit failed${describeFailure(commit)}`,
    });
    return;
  }

  recordNotice({
    level: "info",
    kind: "initialized",
    directory: canonical,
    title: `${noticeName(canonical)} · git initialized`,
    message:
      "Initialized a git repository with an empty initial commit, so this project can use worktree workspaces.",
  });
}

interface WorkspaceCreateHookRequest {
  source: {
    kind: string;
    path?: unknown;
    cwd?: unknown;
    projectId?: unknown;
  };
}

function projectList(
  paseo: unknown,
): { receiver: unknown; list: (...args: unknown[]) => unknown } | null {
  const projects = (paseo as { projects?: { list?: unknown } } | null | undefined)?.projects;
  const list = projects?.list;
  if (typeof list !== "function") return null;
  return { receiver: projects, list: list as (...args: unknown[]) => unknown };
}

async function projectRootFor(paseo: unknown, projectId: string): Promise<string | null> {
  const access = projectList(paseo);
  if (!access) return null;
  try {
    const result = (await access.list.call(access.receiver)) as { projects?: unknown };
    const rows = Array.isArray(result?.projects) ? result.projects : [];
    for (const row of rows) {
      const candidate = row as { projectId?: unknown; projectRootPath?: unknown };
      if (candidate.projectId === projectId && typeof candidate.projectRootPath === "string") {
        return candidate.projectRootPath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** The project id already registered for a root path, or null. */
export async function projectIdForRoot(paseo: unknown, root: string): Promise<string | null> {
  const access = projectList(paseo);
  if (!access) return null;
  const canonical = (await canonicalPath(root)) ?? resolve(root);
  try {
    const result = (await access.list.call(access.receiver)) as { projects?: unknown };
    const rows = Array.isArray(result?.projects) ? result.projects : [];
    for (const row of rows) {
      const candidate = row as { projectId?: unknown; projectRootPath?: unknown };
      if (typeof candidate.projectId !== "string" || typeof candidate.projectRootPath !== "string") {
        continue;
      }
      const candidateRoot = (await canonicalPath(candidate.projectRootPath)) ?? candidate.projectRootPath;
      if (candidateRoot === canonical) {
        return candidate.projectId;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** The directory a workspace.create request is about, or null when it cannot be resolved. */
export async function resolveProjectDirectory(
  request: WorkspaceCreateHookRequest,
  paseo: unknown,
): Promise<string | null> {
  const source = request.source;
  const candidates: string[] = [];
  if (source.kind === "directory" && typeof source.path === "string") {
    candidates.push(source.path);
  }
  if (source.kind === "worktree" && typeof source.cwd === "string") {
    candidates.push(source.cwd);
  }

  for (const candidate of candidates) {
    if (await isDirectory(candidate)) return candidate;
  }

  if (typeof source.projectId === "string") {
    const root = await projectRootFor(paseo, source.projectId);
    if (root && (await isDirectory(root))) return root;
  }
  return candidates[0] ?? null;
}

/** Prepares the backing project directory, then leaves the request untouched. */
export async function ensureProjectRepositoryForWorkspaceCreate(
  request: WorkspaceCreateHookRequest,
  paseo: unknown,
): Promise<void> {
  const directory = await resolveProjectDirectory(request, paseo);
  if (!directory) return;
  await ensureProjectRepository(directory);
}

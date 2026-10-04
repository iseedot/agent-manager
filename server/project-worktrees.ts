import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { appendFile, mkdir, readFile, rmdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

import { registerProject } from "./daemon-client";
import { noticeName, recordNotice, registerNoticeAction } from "./notices";
import { readWorktreeScripts } from "./paseo-config";
import { runWorktreeScripts, type WorktreeScriptEnv } from "./worktree-scripts";
import {
  canonicalPath,
  describeFailure,
  ensureProjectRepository,
  firstLine,
  gitAvailable,
  isDirectory,
  projectIdForRoot,
  resolveProjectDirectory,
  runGit,
} from "./project-git";

/**
 * Per-project worktrees.
 *
 * Paseo builds its managed worktrees under `$PASEO_HOME/worktrees/<project-hash>/<slug>`, which no
 * configuration can move per project. This module takes the `worktree` isolation request over in the
 * `workspace.create` before hook instead:
 *
 * 1. create the worktree at `<project>/.worktrees/<slug>` with plain git,
 * 2. make sure the project ignores that directory,
 * 3. hand Paseo a directory request for the new path.
 *
 * Paseo still records it as a worktree checkout (branch, main repo root), but it is not Paseo-owned,
 * so archiving the workspace leaves the directory alone and the pill popover asks what to do with it.
 */

const WORKTREE_DIR_NAME = ".worktrees";

type WorkspaceCreateRequest = PluginBeforeRequests["workspace.create"];

export function isManagedWorktreePath(cwd: string): boolean {
  return basename(dirname(cwd)) === WORKTREE_DIR_NAME;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
}

function worktreeSlug(fromSlug: unknown, fromBranch: unknown): string {
  const candidate = text(fromSlug) ?? text(fromBranch);
  const cleaned = candidate ? sanitizeSlug(candidate) : "";
  return cleaned.length > 0 ? cleaned : `worktree-${Date.now().toString(36)}`;
}

/** Adds `/<relative path>/` to the repository's .gitignore unless git already ignores the path. */
async function ensureGitignored(repoRoot: string, target: string): Promise<boolean> {
  const check = await runGit(["check-ignore", "-q", "--no-index", target], repoRoot);
  if (check.ok) {
    return false;
  }
  const pattern = `/${relative(repoRoot, target)}/`;
  const gitignorePath = join(repoRoot, ".gitignore");
  let existing: string | null = null;
  try {
    existing = await readFile(gitignorePath, "utf8");
  } catch {
    existing = null;
  }
  const separator = existing === null || existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await appendFile(gitignorePath, `${separator}# Paseo worktrees\n${pattern}\n`, "utf8");
  return true;
}

/**
 * Turns a worktree isolation request into a directory request for `<project>/.worktrees/<slug>`.
 * Returns undefined whenever this plugin should stay out of the way (not a worktree request, a change
 * request checkout, no repository, an existing directory), so Paseo falls back to its own behavior.
 */
export async function prepareProjectWorktree(
  request: WorkspaceCreateRequest,
  paseo: unknown,
): Promise<WorkspaceCreateRequest | undefined> {
  const source = request.source;
  if (source.kind !== "worktree") {
    return undefined;
  }
  // Change-request checkouts bring their own branch/patch flow — leave those to Paseo.
  if (source.checkoutSource !== undefined || typeof source.githubPrNumber === "number") {
    return undefined;
  }
  if (!(await gitAvailable())) {
    return undefined;
  }

  const projectRoot = await resolveProjectDirectory(request, paseo);
  if (!projectRoot) {
    return undefined;
  }
  await ensureProjectRepository(projectRoot);

  const toplevel = await runGit(["rev-parse", "--show-toplevel"], projectRoot);
  if (!toplevel.ok) {
    return undefined;
  }
  const repoRoot = (await canonicalPath(toplevel.stdout.trim())) ?? projectRoot;

  const slug = worktreeSlug(source.worktreeSlug, source.branchName);
  const worktreePath = join(projectRoot, WORKTREE_DIR_NAME, slug);
  if (await isDirectory(worktreePath)) {
    return undefined;
  }

  const checkout = source.action === "checkout";
  const refName = text(source.refName);
  if (checkout && !refName) {
    return undefined;
  }
  if (!checkout) {
    // A branch-off worktree needs a commit to branch from; the repository check already told the
    // user about an unborn HEAD, so stay quiet here instead of adding a second complaint.
    const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], projectRoot);
    if (!head.ok) {
      return undefined;
    }
  }
  const branch = checkout ? null : (text(source.branchName) ?? `paseo/${slug}`);
  const base = checkout ? null : (text(source.baseBranch) ?? "HEAD");

  const worktreesDir = join(projectRoot, WORKTREE_DIR_NAME);
  await mkdir(worktreesDir, { recursive: true });
  const created = await runGit(
    checkout
      ? ["worktree", "add", worktreePath, refName as string]
      : ["worktree", "add", "-b", branch as string, worktreePath, base as string],
    projectRoot,
  );
  if (!created.ok) {
    // Do not leave an empty .worktrees directory behind when the checkout did not happen.
    await runGit(["clean", "-q", "-d", "--", WORKTREE_DIR_NAME], projectRoot);
    await rmdir(worktreesDir).catch(() => undefined);
    recordNotice({
      level: "warning",
      kind: "worktree-fallback",
      directory: projectRoot,
      title: `${noticeName(projectRoot)} · worktree fallback`,
      message: `Could not create a worktree at ${worktreePath}${describeFailure(created)}. Paseo created its own worktree instead.`,
    });
    return undefined;
  }

  // A directory request is filed under the project it names; without one Paseo would create a
  // project from the worktree path itself.
  const projectId =
    text(source.projectId) ??
    (await projectIdForRoot(paseo, repoRoot)) ??
    (await registerProject(repoRoot));
  if (!projectId) {
    recordNotice({
      level: "warning",
      kind: "worktree-fallback",
      directory: projectRoot,
      title: `${noticeName(projectRoot)} · worktree fallback`,
      message: `Created a worktree at ${worktreePath}, but no Paseo project could be resolved for ${repoRoot}. Remove the workspace and add the project again to use project-local worktrees.`,
    });
    return undefined;
  }

  const ignored = await ensureGitignored(repoRoot, worktreesDir);
  recordNotice({
    level: "info",
    kind: "worktree-created",
    directory: worktreePath,
    title: `${slug} · worktree ready`,
    message: `Created ${worktreePath}${branch ? ` on ${branch}` : ""}.${ignored ? " Added .worktrees/ to .gitignore." : ""}`,
  });
  // The hook has a 30 s budget, so the project's setup scripts run in the background.
  void runSetupScripts(repoRoot, {
    repoRoot,
    worktreePath,
    branch: branch ?? refName ?? slug,
  });

  return {
    ...request,
    source: {
      kind: "directory",
      path: worktreePath,
      projectId,
    },
  };
}

interface ArchivedWorkspace {
  id: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

/** After a workspace is archived, ask (through the pill) whether its worktree should go away. */
export async function registerArchivedProjectWorktree(workspace: ArchivedWorkspace): Promise<void> {
  if (!(await gitAvailable())) {
    return;
  }
  if (!isManagedWorktreePath(workspace.cwd)) {
    return;
  }
  const worktreePath = (await canonicalPath(workspace.cwd)) ?? workspace.cwd;
  if (!(await isDirectory(worktreePath))) {
    return;
  }

  const gitDir = await runGit(["rev-parse", "--path-format=absolute", "--git-dir"], worktreePath);
  const commonDir = await runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    worktreePath,
  );
  if (!gitDir.ok || !commonDir.ok || gitDir.stdout.trim() === commonDir.stdout.trim()) {
    // Not a linked worktree (or no repository): nothing this plugin owns.
    return;
  }

  const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const branchLabel = branch.ok ? branch.stdout.trim() : "";
  const name = workspace.name ?? basename(worktreePath);
  const projectRoot = dirname(dirname(worktreePath));

  // Nothing to lose: the branch keeps the commits and the worktree holds no uncommitted work, so
  // remove it the way Paseo removes its own. Only a worktree with local changes asks a question.
  const status = await runGit(["status", "--porcelain"], worktreePath);
  const clean = status.ok && status.stdout.trim().length === 0;
  if (clean && (await removeWorktree(projectRoot, worktreePath, repoRootOf(worktreePath), branchLabel)).ok) {
    recordNotice({
      level: "info",
      kind: "worktree-removed",
      directory: worktreePath,
      title: `${name} · worktree removed`,
      message: `Archived "${name}" and removed the clean worktree at ${worktreePath}${branchLabel ? ` (branch ${branchLabel})` : ""}.`,
    });
    return;
  }

  recordNotice({
    level: "warning",
    kind: "worktree-archived",
    directory: worktreePath,
    title: `${name} · uncommitted changes — remove?`,
    message: `Workspace "${name}" is archived. Its worktree at ${worktreePath}${branchLabel ? ` (branch ${branchLabel})` : ""} still has uncommitted changes. Removing deletes them; keeping it leaves the checkout in place for a restore.`,
    actions: [
      { id: "remove", label: "Remove worktree", tone: "danger" },
      { id: "keep", label: "Keep it" },
    ],
  });
}

function removalFailed(
  worktreePath: string,
  result: { stdout: string; stderr: string },
): { title: string; message: string; actions: { id: string; label: string; tone?: "primary" | "danger" }[] } {
  const detail = firstLine(result.stderr) || firstLine(result.stdout) || "unknown error";
  const name = noticeName(worktreePath);
  return {
    title: `${name} · removal refused — force?`,
    message: `Could not remove ${worktreePath}: ${detail}. Force removing deletes uncommitted changes in it.`,
    actions: [
      { id: "force", label: "Force remove", tone: "danger" },
      { id: "keep", label: "Keep it" },
    ],
  };
}

/** The repository a project-local worktree belongs to (its `.worktrees` parent). */
function repoRootOf(worktreePath: string): string {
  return dirname(dirname(worktreePath));
}

async function runSetupScripts(repoRoot: string, env: WorktreeScriptEnv): Promise<void> {
  const { setup } = await readWorktreeScripts(repoRoot);
  if (setup.length === 0) return;
  const result = await runWorktreeScripts(setup, env);
  if (!result.ok) {
    recordNotice({
      level: "warning",
      kind: "worktree-setup-failed",
      directory: env.worktreePath,
      title: `${noticeName(env.worktreePath)} · setup failed`,
      message: `paseo.json setup command failed in ${env.worktreePath}: ${result.failedCommand} — ${result.detail}`,
    });
    return;
  }
  console.log(`agent-manager worktree-setup ${env.worktreePath}: ran ${setup.length} command(s)`);
}

/** Runs the project's teardown scripts, then deletes the worktree. */
async function removeWorktree(
  projectRoot: string,
  worktreePath: string,
  repoRoot: string,
  branch: string,
  force = false,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const { teardown } = await readWorktreeScripts(repoRoot);
  if (teardown.length > 0) {
    const result = await runWorktreeScripts(teardown, { repoRoot, worktreePath, branch });
    if (!result.ok) {
      recordNotice({
        level: "warning",
        kind: "worktree-teardown-failed",
        directory: worktreePath,
        title: `${noticeName(worktreePath)} · teardown failed`,
        message: `paseo.json teardown command failed in ${worktreePath}: ${result.failedCommand} — ${result.detail}. Removing anyway.`,
      });
    }
  }
  return runGit(
    force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath],
    projectRoot,
  );
}

export function registerWorktreeCleanupAction(): void {
  registerNoticeAction("worktree-archived", async (notice, actionId) => {
    const worktreePath = notice.directory;
    const projectRoot = dirname(dirname(worktreePath));

    if (actionId === "keep") {
      return { dismissed: true, message: `Kept the worktree at ${worktreePath}.` };
    }
    if (actionId !== "remove" && actionId !== "force") {
      return {};
    }

    if (!(await isDirectory(worktreePath))) {
      await runGit(["worktree", "prune"], projectRoot);
      return { dismissed: true, message: `Pruned the missing worktree record for ${worktreePath}.` };
    }

    const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
    const removed = await removeWorktree(
      projectRoot,
      worktreePath,
      repoRootOf(worktreePath),
      branch.ok ? branch.stdout.trim() : "",
      actionId === "force",
    );
    if (removed.ok) {
      return { dismissed: true, message: `Removed the worktree at ${worktreePath}.` };
    }
    return removalFailed(worktreePath, removed);
  });
}

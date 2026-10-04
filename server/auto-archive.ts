import { beginDaemonClientUse, endDaemonClientUse, getDaemonClient } from "./daemon-client";
import { fireAndForget } from "./guard";
import { noticeName, recordNotice } from "./notices";
import { isManagedWorktreePath } from "./project-worktrees";
import { listWorkspaceRows } from "./workspaces";

/**
 * Paseo archives a workspace when its change request is merged, but only for the worktrees it created
 * itself (it checks the worktree root). Project-local worktrees are ours, so the same rule is applied
 * here, on the auto-release cadence: merged pull request, nothing uncommitted, nothing unpushed.
 */
const INTERVAL_MS = 15 * 60 * 1000;

interface CheckoutStatusLike {
  git?: { isDirty?: unknown; aheadOfOrigin?: unknown } | null;
  forge?: { pullRequest?: { isMerged?: unknown; url?: unknown } | null } | null;
}

interface ArchiveClient {
  getCheckoutStatus(cwd: string): Promise<CheckoutStatusLike | null>;
  archiveWorkspace(workspaceId: string): Promise<unknown>;
}

export function startMergedWorktreeArchiver(): () => void {
  const timer = setInterval(() => {
    fireAndForget(archiveMergedWorktrees(), "merged worktree archive");
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}

export async function archiveMergedWorktrees(
  client?: ArchiveClient,
  rows?: readonly { workspaceId: string; cwd: string; archivedAt: string | null }[],
): Promise<string[]> {
  const candidates = rows ?? (await listWorkspaceRows());
  const rowsToCheck = candidates.filter(
    (row) => row.archivedAt === null && isManagedWorktreePath(row.cwd),
  );
  if (rowsToCheck.length === 0) {
    return [];
  }

  const useInjected = client !== undefined;
  if (!useInjected) {
    beginDaemonClientUse();
  }
  try {
    const daemon = client ?? ((await getDaemonClient()) as unknown as ArchiveClient);
    const archived: string[] = [];
    for (const row of rowsToCheck) {
      const status = await daemon.getCheckoutStatus(row.cwd).catch(() => null);
      if (!status || status.forge?.pullRequest?.isMerged !== true) {
        continue;
      }
      if (status.git?.isDirty === true) {
        continue;
      }
      const ahead = status.git?.aheadOfOrigin;
      if (typeof ahead === "number" && ahead > 0) {
        continue;
      }
      try {
        await daemon.archiveWorkspace(row.workspaceId);
        archived.push(row.workspaceId);
        recordNotice({
          level: "info",
          kind: "worktree-merged",
          directory: row.cwd,
          title: `${noticeName(row.cwd)} · merged — archived`,
          message: `Archived ${row.workspaceId} because its change request is merged, the worktree is clean and nothing is unpushed.`,
        });
      } catch (error) {
        recordNotice({
          level: "warning",
          kind: "worktree-archive-failed",
          directory: row.cwd,
          title: `${noticeName(row.cwd)} · archive failed`,
          message: `Could not archive ${row.workspaceId} after its change request merged: ${describe(error)}`,
        });
      }
    }
    return archived;
  } finally {
    if (!useInjected) {
      endDaemonClientUse();
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

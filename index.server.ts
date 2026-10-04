import type { PluginServerContext } from "@getpaseo/plugin/server";

import { factsRpc, gitNoticesRpc, workspacesRpc } from "./shared/contracts";
import { startMergedWorktreeArchiver } from "./server/auto-archive";
import { startAutoReleaseScheduler } from "./server/auto-release";
import type { PaseoLike } from "./server/agents";
import { disposeDaemonClient, resolveServerId } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { dismissNotices, listNotices, runNoticeAction } from "./server/notices";
import { ensureProjectRepositoryForWorkspaceCreate } from "./server/project-git";
import {
  prepareProjectWorktree,
  registerArchivedProjectWorktree,
  registerWorktreeCleanupAction,
} from "./server/project-worktrees";
import { buildFacts } from "./server/snapshot";
import { describe } from "./server/util";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  registerWorktreeCleanupAction();

  server.handle(factsRpc, async (_input, { paseo }) => buildFacts(paseo as unknown as PaseoLike));

  server.handle(workspacesRpc, async () => ({ serverId: await resolveServerId() }));

  server.handle(gitNoticesRpc, async ({ dismissIds, action }) => {
    if (action) {
      await runNoticeAction(action.id, action.actionId);
    }
    if (dismissIds && dismissIds.length > 0) {
      dismissNotices(dismissIds);
    }
    return { notices: listNotices() };
  });

  // Workspace creation, in order:
  // 1. a worktree request becomes a directory request for <project>/.worktrees/<slug>, created here
  //    so the checkout lives inside the project instead of Paseo's own worktrees root;
  // 2. otherwise the project directory gets its repository prepared (empty directory: git init plus
  //    one empty commit; existing repositories and non-empty directories are never touched).
  server.before("workspace.create", async ({ request }, { paseo }) => {
    const rewritten = await prepareProjectWorktree(request, paseo).catch((error) => {
      console.warn(`agent-manager worktree hook failed: ${describe(error)}`);
      return undefined;
    });
    if (rewritten) {
      return rewritten;
    }
    await ensureProjectRepositoryForWorkspaceCreate(request, paseo).catch((error) => {
      console.warn(`agent-manager project-git hook failed: ${describe(error)}`);
    });
    return undefined;
  });

  // Archiving a workspace never deletes these worktrees; the pill popover asks instead.
  server.on("workspace.archived", (event) => {
    void registerArchivedProjectWorktree(event.workspace).catch((error) => {
      console.warn(`agent-manager worktree archive hook failed: ${describe(error)}`);
    });
  });

  const stopAutoRelease = startAutoReleaseScheduler();
  const stopMergedWorktreeArchiver = startMergedWorktreeArchiver();

  return () => {
    stopMergedWorktreeArchiver();
    stopAutoRelease();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

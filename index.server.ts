import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  agentDeleteRpc,
  agentRestoreRpc,
  autoReleaseSetRpc,
  jobStatusRpc,
  overviewRpc,
  releaseManyRpc,
  snapshotRpc,
  terminalCloseRpc,
  terminalsCloseRpc,
  workspaceActivateRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  workspaceRenameRpc,
  workspacesRpc,
} from "./shared/contracts";
import { releaseAgents, deleteAgents } from "./server/actions";
import { restoreAgent } from "./server/agent-ops";
import { startAutoReleaseScheduler, updateAutoReleaseState } from "./server/auto-release";
import { disposeDaemonClient, resolveServerId } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { paseoHome } from "./server/daemon-mcp";
import { buildOverview, type PaseoLike } from "./server/overview";
import { buildSnapshot } from "./server/snapshot";
import { closeTerminals, listAllTerminals, type TerminalKiller, type TerminalLister } from "./server/terminals";
import {
  archiveWorkspace,
  closeWorkspaceTabs,
  deleteWorkspace,
  listProjectRows,
  listWorkspaceRows,
  readJob,
  renameWorkspace,
  startWorkspaceJob,
  type PaseoWorkspaceControl,
} from "./server/workspaces";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();

  server.handle(overviewRpc, async (_input, { paseo }) => buildOverview(paseo as unknown as never));

  server.handle(snapshotRpc, async (_input, { paseo }) => buildSnapshot(paseo as unknown as PaseoLike));

  server.handle(releaseManyRpc, async ({ agentIds, allowSignalFallback }) =>
    releaseAgents(agentIds, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(agentDeleteRpc, async ({ agentIds }) => {
    const outcome = await deleteAgents(agentIds);
    return {
      ...outcome,
      message:
        outcome.failed.length === 0
          ? `Deleted ${outcome.deleted.length} session(s) permanently.`
          : `Deleted ${outcome.deleted.length} · ${outcome.failed.length} failed`,
    };
  });

  server.handle(agentRestoreRpc, async ({ agentId }) => restoreAgent(agentId));

  server.handle(terminalCloseRpc, async ({ terminalIds }, { paseo }) => {
    const api = paseo as unknown as TerminalLister & TerminalKiller;
    const result = await closeTerminals(api, terminalIds);
    return { closed: result.closed, failed: result.failed };
  });

  server.handle(terminalsCloseRpc, async ({ workspaceId }, { paseo }) => {
    const api = paseo as unknown as TerminalLister & TerminalKiller;
    const terminals = await listAllTerminals(api);
    const result = await closeTerminals(
      api,
      terminals.filter((terminal) => terminal.workspaceId === workspaceId).map((terminal) => terminal.id),
    );
    return { closed: result.closed, failed: result.failed };
  });

  server.handle(workspacesRpc, async () => ({
    workspaces: await listWorkspaceRows(),
    projects: await listProjectRows(),
    home: paseoHome(),
    serverId: await resolveServerId(),
  }));

  server.handle(workspaceRenameRpc, async ({ workspaceId, title }) => renameWorkspace(workspaceId, title));

  server.handle(workspaceArchiveRpc, async ({ workspaceId, confirmLastActive }, { paseo }) =>
    archiveWorkspace(paseo as unknown as PaseoWorkspaceControl, workspaceId, {
      confirmLastActive: confirmLastActive === true,
    }),
  );

  server.handle(workspaceDeleteRpc, async ({ workspaceId }, { paseo }) =>
    deleteWorkspace(paseo as unknown as PaseoLike, workspaceId),
  );

  server.handle(workspaceCloseTabsRpc, async ({ workspaceId }, { paseo }) =>
    closeWorkspaceTabs(paseo as unknown as PaseoLike, workspaceId),
  );

  server.handle(workspaceActivateRpc, async ({ workspaceId, workspaceName, tabsOnly }, { paseo }) => {
    const name =
      workspaceName ??
      (await listWorkspaceRows()).find((row) => row.workspaceId === workspaceId)?.name ??
      workspaceId.slice(0, 7);
    const job = startWorkspaceJob({
      paseo: paseo as unknown as PaseoLike,
      workspaceId,
      workspaceName: name,
      tabsOnly: tabsOnly === true,
    });
    return { jobId: job.jobId };
  });

  server.handle(jobStatusRpc, async ({ jobId }) => {
    const job = readJob(jobId);
    if (!job) {
      throw new Error("Unknown or expired job");
    }
    return job;
  });

  server.handle(autoReleaseSetRpc, async (patch) => updateAutoReleaseState(patch));

  const stopAutoRelease = startAutoReleaseScheduler();

  return () => {
    stopAutoRelease();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

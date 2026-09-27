import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  autoReleaseSetRpc,
  autoReleaseStateRpc,
  jobStatusRpc,
  overviewRpc,
  releaseManyRpc,
  releaseRpc,
  workspaceActivateRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  workspacesRpc,
} from "./shared/contracts";
import { deleteAgents, releaseAgent, releaseAgents } from "./server/actions";
import { readAutoReleaseState, startAutoReleaseScheduler, updateAutoReleaseState } from "./server/auto-release";
import { disposeDaemonClient } from "./server/daemon-client";
import { paseoHome } from "./server/daemon-mcp";
import { buildOverview, type PaseoLike } from "./server/overview";
import {
  archiveWorkspace,
  closeWorkspaceTabs,
  deleteWorkspace,
  listWorkspaceRows,
  readJob,
  startWorkspaceJob,
  type PaseoWorkspaceControl,
} from "./server/workspaces";

export default function contribute(server: PluginServerContext) {
  server.handle(overviewRpc, async (_input, { paseo }) => buildOverview(paseo as unknown as never));

  server.handle(releaseRpc, async ({ agentId, allowSignalFallback }) =>
    releaseAgent(agentId, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(releaseManyRpc, async ({ agentIds, allowSignalFallback }) =>
    releaseAgents(agentIds, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(workspacesRpc, async () => ({
    workspaces: await listWorkspaceRows(),
    home: paseoHome(),
  }));

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

  server.handle(workspaceActivateRpc, async ({ workspaceId, workspaceName, release, tabsOnly }, { paseo }) => {
    const name =
      workspaceName ??
      (await listWorkspaceRows()).find((row) => row.workspaceId === workspaceId)?.name ??
      workspaceId.slice(0, 7);
    const job = startWorkspaceJob({
      paseo: paseo as unknown as PaseoLike,
      workspaceId,
      workspaceName: name,
      release: release !== false,
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

  server.handle(autoReleaseStateRpc, async () => readAutoReleaseState());

  server.handle(autoReleaseSetRpc, async (patch) => updateAutoReleaseState(patch));

  const stopAutoRelease = startAutoReleaseScheduler();

  return () => {
    stopAutoRelease();
    void disposeDaemonClient();
  };
}

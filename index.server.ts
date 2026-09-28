import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  autoReleaseSetRpc,
  autoReleaseStateRpc,
  jobStatusRpc,
  overviewRpc,
  releaseManyRpc,
  workspaceActivateRpc,
  workspaceArchiveRpc,
  systemRpc,
  terminalsCloseRpc,
  terminalsRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  workspacesRpc,
} from "./shared/contracts";
import { releaseAgents } from "./server/actions";
import { readAutoReleaseState, startAutoReleaseScheduler, updateAutoReleaseState } from "./server/auto-release";
import { disposeDaemonClient } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { paseoHome } from "./server/daemon-mcp";
import { buildOverview, type PaseoLike } from "./server/overview";
import { readSystemStats } from "./server/system";
import { closeTerminals, listAllTerminals, summarizeTerminals, type TerminalKiller, type TerminalLister } from "./server/terminals";
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
  const removeCrashGuards = installCrashGuards();

  server.handle(overviewRpc, async (_input, { paseo }) => buildOverview(paseo as unknown as never));

  server.handle(releaseManyRpc, async ({ agentIds, allowSignalFallback }) =>
    releaseAgents(agentIds, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(systemRpc, async () => readSystemStats());

  server.handle(terminalsRpc, async (_input, { paseo }) => {
    const api = paseo as unknown as TerminalLister;
    const workspaceIds = (await listWorkspaceRows()).map((row) => row.workspaceId);
    const summaries = await summarizeTerminals(() => listAllTerminals(api), workspaceIds);
    return { workspaces: [...summaries.values()] };
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
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

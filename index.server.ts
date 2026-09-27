import type { PluginServerContext } from "@getpaseo/plugin/server";

import { archiveManyRpc, deleteManyRpc, overviewRpc, releaseManyRpc, releaseRpc } from "./shared/contracts";
import { archiveAgents, deleteAgents, releaseAgent, releaseAgents } from "./server/actions";
import { buildOverview, type PaseoAgentControl } from "./server/overview";

export default function contribute(server: PluginServerContext) {
  server.handle(overviewRpc, async (_input, { paseo }) => buildOverview(paseo as unknown as never));

  server.handle(releaseRpc, async ({ agentId, allowSignalFallback }) =>
    releaseAgent(agentId, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(releaseManyRpc, async ({ agentIds, allowSignalFallback }) =>
    releaseAgents(agentIds, { allowSignalFallback: allowSignalFallback !== false }),
  );

  server.handle(archiveManyRpc, async ({ agentIds }, { paseo }) =>
    archiveAgents(paseo as unknown as PaseoAgentControl, agentIds),
  );

  server.handle(deleteManyRpc, async ({ agentIds }) => deleteAgents(agentIds));

  return () => {};
}

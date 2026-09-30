import type { PluginClientContext } from "@getpaseo/plugin/client";

import { overviewRpc, releaseManyRpc } from "../shared/contracts";

const COMMAND_ID = "release-others";

const PANEL_COMMAND_ID = "open-panel";

export function registerReleaseCommands(client: PluginClientContext): () => void {
  const addCommandCenterItem = client.addCommandCenterItem;
  if (typeof addCommandCenterItem !== "function") {
    return () => {};
  }
  try {
    const removePanelCommand = addCommandCenterItem({
      id: PANEL_COMMAND_ID,
      title: "Open Agent Manager",
      icon: "Cpu",
      keywords: ["agent", "manager", "memory", "process", "sessions", "panel"],
      context: "global",
      onSelect: (context) => context.openSurface("agent-manager"),
    });
    const removeReleaseCommand = addCommandCenterItem({
      id: COMMAND_ID,
      title: "Release other sessions",
      icon: "MemoryStick",
      keywords: ["memory", "release", "process", "idle", "others"],
      context: "agent",
      onSelect: async (context) => {
        const currentAgentId = context.agent?.id ?? null;
        const workspaceId = context.workspace?.id ?? null;
        const overview = await context.rpc(overviewRpc, {});
        const agentIds = overview.agents
          .filter((row) => {
            if (row.pid === null || row.id === currentAgentId) {
              return false;
            }
            return workspaceId ? row.workspaceId === workspaceId : true;
          })
          .map((row) => row.id);
        if (agentIds.length === 0) {
          return;
        }
        await context.rpc(releaseManyRpc, { agentIds, allowSignalFallback: true });
      },
    });
    return () => {
      removeReleaseCommand();
      removePanelCommand();
    };
  } catch {
    return () => {};
  }
}

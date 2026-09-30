import type { PluginClientContext } from "@getpaseo/plugin/client";

import { registerReleaseCommands } from "./client/commands";
import { contributeComposerPills } from "./client/new-agent-button";
import { OpenAgentSurface } from "./client/open-agent-surface";
import { AgentManagerPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addSurface("agent-manager", AgentManagerPanel);
  client.addSurface("open-agent", OpenAgentSurface);
  client.addSidebarItem({
    id: "agent-manager",
    title: "Agent Manager",
    icon: "Cpu",
    surface: "agent-manager",
  });
  const unregisterCommands = registerReleaseCommands(client);
  const removeComposerPills = contributeComposerPills(client);
  return () => {
    removeComposerPills();
    unregisterCommands();
  };
}

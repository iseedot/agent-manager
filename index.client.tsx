import type { PluginClientContext } from "@getpaseo/plugin/client";

import { registerReleaseCommands } from "./client/commands";
import { registerHomeFiles } from "./client/home-files";
import { AgentManagerPanel } from "./client/panel";

export default function contribute(client: PluginClientContext) {
  client.addSurface("agent-manager", AgentManagerPanel);
  client.addSidebarItem({
    id: "agent-manager",
    title: "Agent Manager",
    icon: "Cpu",
    surface: "agent-manager",
  });
  const unregisterHomeFiles = registerHomeFiles(client);
  const unregisterCommands = registerReleaseCommands(client);
  return () => {
    unregisterHomeFiles();
    unregisterCommands();
  };
}

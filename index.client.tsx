import type { PluginClientContext } from "@getpaseo/plugin/client";

import { startAgentDirectory } from "./client/agent-directory";
import { AutoReleaseSettingsScreen } from "./client/auto-release-settings";
import { contributeComposerPills } from "./client/new-agent-button";
import { OpenAgentScreen } from "./client/open-agent-screen";

export default function contribute(client: PluginClientContext) {
  const stopAgentDirectory = startAgentDirectory(client);
  // 0.11 `addScreen`: URL-backed params, a real header and back action, a host picker and an error
  // boundary, replacing the deprecated `addSurface`. The tab switch reads the agent id from `params`.
  client.addScreen({
    id: "open-agent",
    title: "Open agent",
    Component: OpenAgentScreen,
  });
  client.addSettingsScreen({
    id: "auto-release",
    title: "Auto-release",
    icon: "SlidersHorizontal",
    Component: AutoReleaseSettingsScreen,
  });
  const removeComposerPills = contributeComposerPills(client);
  return () => {
    removeComposerPills();
    stopAgentDirectory();
  };
}

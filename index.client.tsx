import type { PluginClientContext } from "@getpaseo/plugin/client";

import { startAgentDirectory } from "./client/agent-directory";
import { AutoReleaseSettingsScreen } from "./client/auto-release-settings";
import { contributeComposerPills } from "./client/new-agent-button";
import { OpenAgentSurface } from "./client/open-agent-surface";

export default function contribute(client: PluginClientContext) {
  const stopAgentDirectory = startAgentDirectory(client);
  client.addSurface("open-agent", OpenAgentSurface);
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

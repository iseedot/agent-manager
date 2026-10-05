import type { PluginClientContext } from "@getpaseo/plugin/client";

import { startAgentDirectory } from "./client/agent-directory";
import { startGitNotices } from "./client/git-notices";
import { startHostFacts } from "./client/host-facts";
import { contributeComposerPills } from "./client/new-agent-button";
import { OpenAgentSurface } from "./client/open-agent-surface";

export default function contribute(client: PluginClientContext) {
  const stopAgentDirectory = startAgentDirectory(client);
  const stopGitNotices = startGitNotices(client);
  const stopHostFacts = startHostFacts(client);
  client.addSurface("open-agent", OpenAgentSurface);
  const removeComposerPills = contributeComposerPills(client);
  return () => {
    removeComposerPills();
    stopHostFacts();
    stopGitNotices();
    stopAgentDirectory();
  };
}

import type { PluginServerContext } from "@getpaseo/plugin/server";

import { workspacesRpc } from "./shared/contracts";
import { startAutoReleaseScheduler } from "./server/auto-release";
import { disposeDaemonClient, resolveServerId } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { registerAutoReleaseSettings } from "./server/settings";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  const removeAutoReleaseSettings = registerAutoReleaseSettings(server);

  server.handle(workspacesRpc, async () => ({ serverId: await resolveServerId() }));

  const stopAutoRelease = startAutoReleaseScheduler();

  return () => {
    stopAutoRelease();
    removeAutoReleaseSettings();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

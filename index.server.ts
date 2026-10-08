import type { PluginServerContext } from "@getpaseo/plugin/server";

import { workspacesRpc } from "./shared/contracts";
import { scheduleReleaseAfterTurn, startAutoReleaseScheduler } from "./server/auto-release";
import { disposeDaemonClient, resolveServerId } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { autoReleaseConfig } from "./server/settings";
import { registerAutoReleaseSettings } from "./server/settings";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  const removeAutoReleaseSettings = registerAutoReleaseSettings(server);

  server.handle(workspacesRpc, async () => ({ serverId: await resolveServerId() }));

  const stopAutoRelease = startAutoReleaseScheduler();

  // 0.11 lifecycle hook: release a runtime right after its turn ends plus the grace window, rather
  // than waiting for the next tick. The timer stays as the safety net for already-idle runtimes.
  const removeTurnEnded = server.on("agent.turn_ended", (event) => {
    scheduleReleaseAfterTurn(event.agent.id, autoReleaseConfig().graceMs);
  });

  return () => {
    removeTurnEnded();
    stopAutoRelease();
    removeAutoReleaseSettings();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

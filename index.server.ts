import type { PluginServerContext } from "@getpaseo/plugin/server";

import { runCleanupRpc, runOrphanSweepRpc, workspacesRpc } from "./shared/contracts";
import {
  runCleanupNow,
  runOrphanSweepNow,
  scheduleReleaseAfterTurn,
  startAutoReleaseScheduler,
} from "./server/auto-release";
import { disposeDaemonClient, resolveServerId } from "./server/daemon-client";
import { installCrashGuards } from "./server/guard";
import { autoReleaseConfig } from "./server/settings";
import { registerAutoReleaseSettings } from "./server/settings";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  const removeAutoReleaseSettings = registerAutoReleaseSettings(server);

  server.handle(workspacesRpc, async () => ({ serverId: await resolveServerId() }));
  server.handle(runCleanupRpc, async () => runCleanupNow());
  server.handle(runOrphanSweepRpc, async () => runOrphanSweepNow());

  const stopAutoRelease = startAutoReleaseScheduler();

  // 0.11 lifecycle hook: release a runtime right after its turn ends plus the grace window, rather
  // than waiting for the next tick. The timer stays as the safety net for already-idle runtimes.
  const removeTurnEnded = server.on("agent.turn_ended", (event) => {
    const config = autoReleaseConfig();
    if (!config.enabled) {
      return;
    }
    scheduleReleaseAfterTurn(event.agent.id, config.graceMs);
  });

  return () => {
    removeTurnEnded();
    stopAutoRelease();
    removeAutoReleaseSettings();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

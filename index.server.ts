import type { PluginServerContext } from "@getpaseo/plugin/server";

import { runCleanupRpc } from "./shared/contracts";
import { runPrivacyCleanup, rescheduleAutoCleanup, startAutoCleanup } from "./server/cleanup";
import { disposeDaemonClient } from "./server/daemon";
import { installCrashGuards } from "./server/guard";
import { registerAutoCleanupSettings } from "./server/settings";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  // Settings before the timer: the first run waits for the stored document, and every later change
  // re-arms the timer so a flipped switch takes effect immediately.
  const removeAutoCleanupSettings = registerAutoCleanupSettings(server, rescheduleAutoCleanup);

  server.handle(runCleanupRpc, async () => runPrivacyCleanup());

  const stopAutoCleanup = startAutoCleanup();

  return () => {
    stopAutoCleanup();
    removeAutoCleanupSettings();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

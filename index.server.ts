import type { PluginServerContext } from "@getpaseo/plugin/server";

import { runCleanupRpc } from "./shared/contracts";
import { usageInputSchema } from "./shared/usage-input";
import { runPrivacyCleanup, rescheduleAutoCleanup, startAutoCleanup } from "./server/cleanup";
import { disposeDaemonClient } from "./server/daemon";
import { installCrashGuards } from "./server/guard";
import { registerAutoCleanupSettings } from "./server/settings";
import {
  discoverPiOpenCodeGoAccounts,
  fetchPiOpenCodeGoUsage,
  usageSourceId,
} from "./server/usage-source";

export default function contribute(server: PluginServerContext) {
  const removeCrashGuards = installCrashGuards();
  // Settings before the timer: the first run waits for the stored document, and every later change
  // re-arms the timer so a flipped switch takes effect immediately.
  const removeAutoCleanupSettings = registerAutoCleanupSettings(server, rescheduleAutoCleanup);

  server.handle(runCleanupRpc, async () => runPrivacyCleanup());

  // The OpenCode Go quota pi is logged into. No client half: it plugs into Paseo's Usage view.
  server.registerUsageSource({
    id: usageSourceId,
    label: "OpenCode Go (Pi)",
    input: usageInputSchema,
    discover: (scope) =>
      scope.kind === "global" ? discoverPiOpenCodeGoAccounts() : Promise.resolve([]),
    fetch: fetchPiOpenCodeGoUsage,
  });

  const stopAutoCleanup = startAutoCleanup();

  return () => {
    stopAutoCleanup();
    removeAutoCleanupSettings();
    removeCrashGuards();
    void disposeDaemonClient();
  };
}

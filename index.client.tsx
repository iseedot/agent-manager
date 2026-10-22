import type { PluginClientContext } from "@getpaseo/plugin/client";

import { AutoReleaseSettingsScreen } from "./client/auto-release-settings";

/**
 * The only client contribution: Settings → Plugins → agent-manager. Everything that used to drive
 * the composer pill (the tab list, the redirect screen and the new-agent shortcuts) was removed
 * with the pill; release and cleanup run entirely in the server half.
 */
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-release",
    title: "Auto-release",
    icon: "SlidersHorizontal",
    Component: AutoReleaseSettingsScreen,
  });
}

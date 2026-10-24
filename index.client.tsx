import type { PluginClientContext } from "@getpaseo/plugin/client";

import { AutoReleaseSettingsScreen } from "./client/auto-release-settings";
import { messages } from "./client/messages";

/**
 * The only client contribution: Settings → Plugins → agent-manager. Everything that used to drive
 * the composer pill (the tab list, the redirect screen and the new-agent shortcuts) was removed
 * with the pill; release and cleanup run entirely in the server half. On Paseo 0.13+ the screen
 * follows the app language; older hosts fall back to English.
 */
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-release",
    title: messages.message("title"),
    icon: "SlidersHorizontal",
    Component: AutoReleaseSettingsScreen,
  });
}

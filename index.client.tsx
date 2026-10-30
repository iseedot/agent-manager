import type { PluginClientContext } from "@getpaseo/plugin/client";

import { AutoCleanupSettingsScreen } from "./client/auto-cleanup-settings";
import { messages } from "./client/messages";

/**
 * The only client contribution: Settings → Plugins → agent-manager. The cleanup itself runs entirely
 * in the server half, so the screen is settings plus the one destructive button. On Paseo 0.13+ the
 * screen follows the app language; older hosts fall back to English.
 */
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "auto-release",
    title: messages.message("title"),
    icon: "SlidersHorizontal",
    Component: AutoCleanupSettingsScreen,
  });
}

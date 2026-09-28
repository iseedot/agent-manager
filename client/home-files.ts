import type { PluginClientContext } from "@getpaseo/plugin/client";

import { HomeExplorerPanel } from "./explorer";

const PANEL_ID = "home-explorer";
const TITLE = "Home files";
const ICON = "FolderOpen";

export function registerHomeFiles(client: PluginClientContext): () => void {
  try {
    return client.addWorkspacePanel({
      id: PANEL_ID,
      title: TITLE,
      icon: ICON,
      context: "workspace",
      locations: ["explorer"],
      Component: HomeExplorerPanel,
    });
  } catch {
    return () => {};
  }
}

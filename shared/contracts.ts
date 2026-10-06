import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Only the host id is needed: the composer pill builds draft deep links with it. */
export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({ serverId: z.string().nullable() }),
});

import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Only the host id is needed: the composer pill builds draft deep links with it. */
export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({ serverId: z.string().nullable() }),
});

/**
 * The settings screen's manual purge button: runs the destructive cleanup immediately instead of
 * waiting for the next tick's 24-hour window. Always purges every archived workspace with its pi
 * session file.
 */
export const runCleanupRpc = defineRpc({
  name: "agent-manager.run-cleanup",
  input: z.object({}),
  output: z.object({
    removed: z.array(
      z.object({
        workspaceId: z.string(),
        name: z.string().nullable(),
        agents: z.number(),
        deletedSessions: z.number(),
      }),
    ),
    deletedAgents: z.number(),
    deletedSessions: z.number(),
    deletedOrphanSessions: z.number(),
  }),
});

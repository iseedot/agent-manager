import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Only the host id is needed: the composer pill builds draft deep links with it. */
export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({ serverId: z.string().nullable() }),
});

/**
 * The settings screen's privacy cleanup button: runs every destructive pass immediately instead of
 * waiting for the next tick. Always deletes every archived workspace, every archived agent and
 * every archived project; pi transcripts and the orphan sweep only run while pi session files are
 * on.
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
    deletedProjects: z.number(),
    deletedOrphanSessions: z.number(),
  }),
});

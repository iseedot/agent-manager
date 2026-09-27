import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentRowSchema = z.object({
  id: z.string(),
  shortId: z.string(),
  title: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  archived: z.boolean(),
  workspaceId: z.string().nullable(),
  workspaceName: z.string().nullable(),
  cwd: z.string(),
  updatedAt: z.string().nullable(),
  pid: z.number().int().nullable(),
  rssBytes: z.number().int().nullable(),
  processCommand: z.string().nullable(),
  isDaemonChild: z.boolean().nullable(),
});

export type AgentRow = z.infer<typeof agentRowSchema>;

export const overviewRpc = defineRpc({
  name: "agent-manager.overview",
  input: z.object({}),
  output: z.object({
    agents: z.array(agentRowSchema),
    totals: z.object({
      total: z.number().int(),
      holdingProcess: z.number().int(),
      closed: z.number().int(),
      archived: z.number().int(),
      rssBytes: z.number().int(),
    }),
    endpoint: z.string().nullable(),
    cliAvailable: z.boolean(),
    warning: z.string().nullable(),
  }),
});

export const releaseRpc = defineRpc({
  name: "agent-manager.release",
  input: z.object({
    agentId: z.string(),
    allowSignalFallback: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    freedBytes: z.number().int().nullable(),
  }),
});

export const releaseManyRpc = defineRpc({
  name: "agent-manager.release-many",
  input: z.object({
    agentIds: z.array(z.string()),
    allowSignalFallback: z.boolean().optional(),
  }),
  output: z.object({
    released: z.array(z.string()),
    failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
    freedBytes: z.number().int(),
  }),
});

export const archiveManyRpc = defineRpc({
  name: "agent-manager.archive-many",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.object({
    succeeded: z.array(z.string()),
    failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  }),
});

export const deleteManyRpc = defineRpc({
  name: "agent-manager.delete-many",
  input: z.object({ agentIds: z.array(z.string()) }),
  output: z.object({
    succeeded: z.array(z.string()),
    failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  }),
});

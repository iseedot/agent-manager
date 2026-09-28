import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const agentRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  archived: z.boolean(),
  workspaceId: z.string().nullable(),
  pid: z.number().int().nullable(),
  rssBytes: z.number().int().nullable(),
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
    warning: z.string().nullable(),
  }),
});

const failureSchema = z.object({ agentId: z.string(), error: z.string() });

export const releaseManyRpc = defineRpc({
  name: "agent-manager.release-many",
  input: z.object({
    agentIds: z.array(z.string()),
    allowSignalFallback: z.boolean().optional(),
  }),
  output: z.object({
    released: z.array(z.string()),
    failed: z.array(failureSchema),
    freedBytes: z.number().int(),
  }),
});

export const workspaceRowSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string().nullable(),
  cwd: z.string(),
  kind: z.string(),
  branch: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().nullable(),
  projectName: z.string().nullable(),
});

export type WorkspaceRow = z.infer<typeof workspaceRowSchema>;

export const jobSchema = z.object({
  jobId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  phase: z.enum(["workspace", "tabs", "done", "failed"]),
  total: z.number().int(),
  done: z.number().int(),
  current: z.string().nullable(),
  restoredWorkspace: z.boolean(),
  released: z.number().int(),
  failed: z.array(failureSchema),
  message: z.string().nullable(),
  finished: z.boolean(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});

export type JobSnapshot = z.infer<typeof jobSchema>;

export const autoReleaseStateSchema = z.object({
  enabled: z.boolean(),
  idleMinutes: z.number(),
  intervalMinutes: z.number(),
  onLoad: z.enum(["allIdle", "threshold", "off"]),
  removeEmptyWorkspaces: z.boolean(),
  lastRunAt: z.string().nullable(),
  lastReleased: z.array(z.object({ agentId: z.string(), title: z.string().nullable() })),
  lastRemovedWorkspaces: z.array(z.object({ workspaceId: z.string(), name: z.string().nullable() })),
  lastSkipped: z.number().int(),
  lastError: z.string().nullable(),
  nextRunAt: z.string().nullable(),
});

export type AutoReleaseSnapshot = z.infer<typeof autoReleaseStateSchema>;

export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({
    workspaces: z.array(workspaceRowSchema),
    home: z.string(),
  }),
});

export const workspaceArchiveRpc = defineRpc({
  name: "agent-manager.workspace-archive",
  input: z.object({
    workspaceId: z.string(),
    confirmLastActive: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    refused: z.boolean(),
    message: z.string(),
    archivedAt: z.string().nullable(),
    activeAtPath: z.number().int(),
    willReopen: z.object({ workspaceId: z.string(), name: z.string().nullable() }).nullable(),
    touchedOthers: z.array(z.string()),
  }),
});

export const terminalsSummarySchema = z.object({
  workspaceId: z.string(),
  count: z.number().int(),
  shells: z.number().int(),
  busy: z.number().int(),
  rssBytes: z.number().int(),
});

export const terminalsRpc = defineRpc({
  name: "agent-manager.terminals",
  input: z.object({}),
  output: z.object({ workspaces: z.array(terminalsSummarySchema) }),
});

export const terminalsCloseRpc = defineRpc({
  name: "agent-manager.terminals-close",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    closed: z.array(z.string()),
    failed: z.array(z.object({ terminalId: z.string(), error: z.string() })),
  }),
});

export const workspaceDeleteRpc = defineRpc({
  name: "agent-manager.workspace-delete",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    deletedAgents: z.array(z.string()),
    failed: z.array(failureSchema),
  }),
});

export const workspaceCloseTabsRpc = defineRpc({
  name: "agent-manager.workspace-close-tabs",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({
    ok: z.boolean(),
    message: z.string(),
    closed: z.array(z.string()),
    touchedOthers: z.array(z.string()),
  }),
});

export const workspaceActivateRpc = defineRpc({
  name: "agent-manager.workspace-activate",
  input: z.object({
    workspaceId: z.string(),
    workspaceName: z.string().optional(),
    release: z.boolean().optional(),
    tabsOnly: z.boolean().optional(),
  }),
  output: z.object({ jobId: z.string() }),
});

export const autoReleaseStateRpc = defineRpc({
  name: "agent-manager.auto-release-state",
  input: z.object({}),
  output: autoReleaseStateSchema,
});

export const autoReleaseSetRpc = defineRpc({
  name: "agent-manager.auto-release-set",
  input: z.object({
    enabled: z.boolean().optional(),
    idleMinutes: z.number().optional(),
    intervalMinutes: z.number().optional(),
    onLoad: z.enum(["allIdle", "threshold", "off"]).optional(),
    removeEmptyWorkspaces: z.boolean().optional(),
    runNow: z.boolean().optional(),
  }),
  output: autoReleaseStateSchema,
});

export const jobStatusRpc = defineRpc({
  name: "agent-manager.job",
  input: z.object({ jobId: z.string() }),
  output: jobSchema,
});

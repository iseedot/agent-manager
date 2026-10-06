import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const systemStatsSchema = z.object({
  load1: z.number().nullable(),
  load5: z.number().nullable(),
  load15: z.number().nullable(),
  cpuPercent: z.number().nullable(),
  memTotalBytes: z.number().nullable(),
  memUsedBytes: z.number().nullable(),
  memUsedPercent: z.number().nullable(),
  swapTotalBytes: z.number().nullable(),
  swapUsedBytes: z.number().nullable(),
  swapUsedPercent: z.number().nullable(),
  diskFreePercent: z.number().nullable(),
  uptimeSeconds: z.number().nullable(),
});

export type SystemStats = z.infer<typeof systemStatsSchema>;

export const terminalPresenceSchema = z.object({
  workspaceId: z.string(),
  count: z.number().int(),
  working: z.number().int(),
  waiting: z.number().int(),
});

export type TerminalPresence = z.infer<typeof terminalPresenceSchema>;

export const autoReleaseStatusSchema = z.object({
  lastRunAt: z.string().nullable(),
  released: z.number().int(),
  skipped: z.number().int(),
  removedWorkspaces: z.number().int(),
  error: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  running: z.boolean(),
});

export type AutoReleaseStatus = z.infer<typeof autoReleaseStatusSchema>;

export const factsSchema = z.object({
  system: systemStatsSchema,
  terminals: z.array(terminalPresenceSchema),
  autoRelease: autoReleaseStatusSchema,
});

export type FactsPayload = z.infer<typeof factsSchema>;

export const factsRpc = defineRpc({
  name: "agent-manager.facts",
  input: z.object({}),
  output: factsSchema,
});

/** Only the host id is needed: the composer pill builds draft deep links with it. */
export const workspacesRpc = defineRpc({
  name: "agent-manager.workspaces",
  input: z.object({}),
  output: z.object({ serverId: z.string().nullable() }),
});

export const noticeActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  tone: z.enum(["primary", "danger"]).optional(),
});

export type NoticeAction = z.infer<typeof noticeActionSchema>;

/** What the popover renders: one short line plus optional buttons. */
export const gitNoticeSchema = z.object({
  id: z.number().int(),
  level: z.enum(["info", "warning", "error"]),
  title: z.string(),
  actions: z.array(noticeActionSchema).optional(),
});

export type GitNotice = z.infer<typeof gitNoticeSchema>;

export const gitNoticesRpc = defineRpc({
  name: "agent-manager.git-notices",
  input: z.object({
    dismissIds: z.array(z.number().int()).optional(),
    action: z.object({ id: z.number().int(), actionId: z.string() }).optional(),
  }),
  output: z.object({ notices: z.array(gitNoticeSchema) }),
});

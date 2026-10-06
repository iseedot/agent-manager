import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings, all with defaults, editable in the app's plugin settings screen.
 *
 * The two destructive switches are off by default. The environment variables documented in the
 * README still win over anything stored here, so an operator can override a host without the app.
 */
export const autoReleaseSettings = defineSettings({
  id: "auto-release",
  scope: "host",
  version: 1,
  schema: z.object({
    sweepIntervalMinutes: z.number().int().min(1).default(15),
    graceMinutes: z.number().min(0).default(5),
    cleanupIntervalHours: z.number().min(1).default(24),
    /** Off: the cleanup only removes archived workspaces that have no sessions left. */
    purgeArchivedWorkspaces: z.boolean().default(false),
    /** Off: only meaningful while purging, and pi only. Deletes the provider's own transcript. */
    deleteProviderSessions: z.boolean().default(false),
  }),
});

export type AutoReleaseSettings = z.output<typeof autoReleaseSettings.schema>;

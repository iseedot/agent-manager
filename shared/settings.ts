import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings, all with defaults, editable in the app's plugin settings screen.
 *
 * `enabled` is the master timer: off stops the whole timer, but the settings screen's privacy
 * cleanup still runs. `deleteProviderSessions` is the only switch that touches a provider's own
 * files (pi today); with it off every deletion removes Paseo records only. The environment variables
 * documented in the README still win over anything stored here, so an operator can override a host
 * without the app.
 */
export const autoReleaseSettings = defineSettings({
  id: "auto-release",
  scope: "host",
  version: 2,
  migrate: migrateFromV1,
  schema: z.object({
    /** On: the timer releases runtimes and runs the cleanup. Off: neither runs; the button still does. */
    enabled: z.boolean().default(true),
    sweepIntervalMinutes: z.number().int().min(1).default(15),
    graceMinutes: z.number().min(0).default(5),
    cleanupIntervalHours: z.number().min(1).default(24),
    /** Deep mode: also delete each removed agent's pi transcript. Off: Paseo records only. */
    deleteProviderSessions: z.boolean().default(false),
    /** Delete every archived workspace, with the agents inside it. */
    deleteArchivedWorkspaces: z.boolean().default(false),
    /** Delete every archived agent, even one whose workspace is not archived. */
    deleteArchivedAgents: z.boolean().default(false),
  }),
});

export type AutoReleaseSettings = z.output<typeof autoReleaseSettings.schema>;

/**
 * v1 had one `purgeArchivedWorkspaces` switch that deleted both archived workspaces and archived
 * agents, plus a separate orphan-session switch. The purge becomes both delete switches; the orphan
 * sweep is now part of the privacy button.
 */
function migrateFromV1(values: unknown): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return values;
  }
  const v1 = values as Record<string, unknown>;
  const purge = v1.purgeArchivedWorkspaces === true;
  return {
    enabled: v1.enabled,
    sweepIntervalMinutes: v1.sweepIntervalMinutes,
    graceMinutes: v1.graceMinutes,
    cleanupIntervalHours: v1.cleanupIntervalHours,
    deleteProviderSessions: v1.deleteProviderSessions,
    deleteArchivedWorkspaces: purge,
    deleteArchivedAgents: purge,
  };
}

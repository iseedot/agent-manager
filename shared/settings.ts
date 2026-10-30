import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings, all with defaults, editable in the app's plugin settings screen.
 *
 * `autoCleanup` is the timer's master switch: off stops every automatic deletion, but the settings
 * screen's privacy cleanup still runs. `deleteProviderSessions` is the only switch that touches a
 * provider's own files (pi today); with it off every deletion removes Paseo records only. The
 * environment variables documented in the README still win over anything stored here, so an operator
 * can override a host without the app.
 *
 * The document id stays `auto-release`: it is the path the host stores the document at, so renaming
 * it would orphan every existing host's saved switches.
 */
export const autoCleanupSettings = defineSettings({
  id: "auto-release",
  scope: "host",
  version: 3,
  migrate: migrateToV3,
  schema: z.object({
    /** On: the timer deletes what the switches name. Off: only the privacy button deletes. */
    autoCleanup: z.boolean().default(true),
    /** How often the automatic cleanup may run. The timer itself wakes up once an hour. */
    cleanupIntervalHours: z.number().min(1).default(24),
    /** Deep mode: also delete each removed agent's pi transcript. Off: Paseo records only. */
    deleteProviderSessions: z.boolean().default(false),
    /** Delete every archived workspace, with the agents inside it. */
    deleteArchivedWorkspaces: z.boolean().default(false),
    /** Delete every archived agent, even one whose workspace is not archived. */
    deleteArchivedAgents: z.boolean().default(false),
  }),
});

export type AutoCleanupSettings = z.output<typeof autoCleanupSettings.schema>;

/**
 * v2 carried the release timer's cadence and grace window, which no longer exist; its `enabled`
 * master switch becomes `autoCleanup`. v1 had one `purgeArchivedWorkspaces` switch that deleted both
 * archived workspaces and archived agents, plus a separate orphan-session switch that the privacy
 * button now covers.
 */
function migrateToV3(values: unknown): unknown {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return values;
  }
  const previous = values as Record<string, unknown>;
  const purge = previous.purgeArchivedWorkspaces === true;
  return {
    autoCleanup: previous.autoCleanup ?? previous.enabled,
    cleanupIntervalHours: previous.cleanupIntervalHours,
    deleteProviderSessions: previous.deleteProviderSessions,
    deleteArchivedWorkspaces: previous.deleteArchivedWorkspaces ?? purge,
    deleteArchivedAgents: previous.deleteArchivedAgents ?? purge,
  };
}

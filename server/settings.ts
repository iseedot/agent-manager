import type { PluginServerContext } from "@getpaseo/plugin/server";

import { autoReleaseSettings, type AutoReleaseSettings } from "../shared/settings";

/** What the tick needs, after settings and environment have both had their say. */
export interface AutoReleaseConfig {
  enabled: boolean;
  sweepIntervalMs: number;
  graceMs: number;
  cleanupIntervalMs: number;
  deleteProviderSessions: boolean;
  deleteArchivedWorkspaces: boolean;
  deleteArchivedAgents: boolean;
}

const MIN_SWEEP_INTERVAL_MS = 5000;
const MIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULTS: AutoReleaseSettings = autoReleaseSettings.schema.parse({});

let stored: AutoReleaseSettings = DEFAULTS;
let firstRead: Promise<void> | null = null;

/**
 * Registers the settings and keeps the current values in memory, so a tick always sees the latest
 * document without reading it again. Values that arrive before the first read are the defaults.
 */
export function registerAutoReleaseSettings(server: PluginServerContext): () => void {
  const settings = server.registerSettings(autoReleaseSettings);
  const apply = (state: { status?: unknown; values?: unknown }): void => {
    if (state.status === "ready" && state.values) {
      stored = state.values as AutoReleaseSettings;
    }
  };
  const cleanup = settings.subscribe((state) => apply(state));
  firstRead = settings.read().then(apply).catch(() => undefined);
  return cleanup;
}

/** The initial tick waits for the stored document so it cannot act on defaults it should not use. */
export function awaitAutoReleaseSettings(): Promise<void> {
  return firstRead ?? Promise.resolve();
}

function envNumber(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  return fallback;
}

export function autoReleaseConfig(): AutoReleaseConfig {
  // The v1 names still work as aliases so an operator's environment survives the settings upgrade.
  const legacyPurge = envFlag("PASEO_AGENT_MANAGER_PURGE_ARCHIVED", false);
  return {
    enabled: envFlag("PASEO_AGENT_MANAGER_ENABLED", stored.enabled),
    sweepIntervalMs: envNumber(
      "PASEO_AGENT_MANAGER_SWEEP_INTERVAL_MS",
      stored.sweepIntervalMinutes * 60000,
      MIN_SWEEP_INTERVAL_MS,
    ),
    graceMs: envNumber("PASEO_AGENT_MANAGER_GRACE_MINUTES", stored.graceMinutes, 0) * 60000,
    cleanupIntervalMs: envNumber(
      "PASEO_AGENT_MANAGER_CLEANUP_INTERVAL_MS",
      stored.cleanupIntervalHours * 3600000,
      MIN_CLEANUP_INTERVAL_MS,
    ),
    deleteProviderSessions: envFlag(
      "PASEO_AGENT_MANAGER_DELETE_PROVIDER_SESSIONS",
      stored.deleteProviderSessions,
    ),
    deleteArchivedWorkspaces: envFlag(
      "PASEO_AGENT_MANAGER_DELETE_ARCHIVED_WORKSPACES",
      legacyPurge || stored.deleteArchivedWorkspaces,
    ),
    deleteArchivedAgents: envFlag(
      "PASEO_AGENT_MANAGER_DELETE_ARCHIVED_AGENTS",
      legacyPurge || stored.deleteArchivedAgents,
    ),
  };
}

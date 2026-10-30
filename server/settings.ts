import type { PluginServerContext } from "@getpaseo/plugin/server";

import { autoCleanupSettings, type AutoCleanupSettings } from "../shared/settings";

/** What a cleanup run needs, after settings and environment have both had their say. */
export interface AutoCleanupConfig {
  enabled: boolean;
  cleanupIntervalMs: number;
  deleteProviderSessions: boolean;
  deleteArchivedWorkspaces: boolean;
  deleteArchivedAgents: boolean;
}

const MIN_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULTS: AutoCleanupSettings = autoCleanupSettings.schema.parse({});

let stored: AutoCleanupSettings = DEFAULTS;
let firstRead: Promise<void> | null = null;

/**
 * Registers the settings and keeps the current values in memory, so a cleanup always sees the latest
 * document without reading it again. `onChange` fires when the document changes after the first read
 * — the scheduler uses it to re-arm the timer, so flipping a switch takes effect immediately.
 */
export function registerAutoCleanupSettings(
  server: PluginServerContext,
  onChange?: () => void,
): () => void {
  const settings = server.registerSettings(autoCleanupSettings);
  let ready = false;
  const apply = (state: { status?: unknown; values?: unknown }): void => {
    if (state.status !== "ready" || !state.values) {
      return;
    }
    const next = state.values as AutoCleanupSettings;
    const changed = JSON.stringify(next) !== JSON.stringify(stored);
    stored = next;
    if (!ready) {
      // The first read (or the first snapshot the subscription pushes) is not a change.
      ready = true;
      return;
    }
    if (changed) {
      onChange?.();
    }
  };
  const cleanup = settings.subscribe(apply);
  firstRead = settings.read().then(apply).catch(() => undefined);
  return cleanup;
}

/** The first run waits for the stored document so it cannot act on defaults it should not use. */
export function awaitAutoCleanupSettings(): Promise<void> {
  return firstRead ?? Promise.resolve();
}

export function autoCleanupConfig(): AutoCleanupConfig {
  // The v1 name still works as an alias so an operator's environment survives the settings upgrade.
  const legacyPurge = envFlag("PASEO_AGENT_MANAGER_PURGE_ARCHIVED", false);
  return {
    enabled: envFlag("PASEO_AGENT_MANAGER_ENABLED", stored.autoCleanup),
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

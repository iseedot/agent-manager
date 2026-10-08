import { useCallback, useMemo, useState } from "react";
import { Text } from "react-native";
import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";

import { runCleanupRpc } from "../shared/contracts";
import { autoReleaseSettings } from "../shared/settings";

type Ready = Extract<SettingsState<typeof autoReleaseSettings.schema>, { status: "ready" }>;
type Values = Ready["values"];

const NUMBER_FIELDS: Array<{
  key: "sweepIntervalMinutes" | "graceMinutes" | "cleanupIntervalHours";
  label: string;
  hint: string;
}> = [
  {
    key: "sweepIntervalMinutes",
    label: "Tick every (minutes)",
    hint: "One tick releases runtimes and runs the cleanup.",
  },
  {
    key: "graceMinutes",
    label: "Grace (minutes)",
    hint: "A session touched this recently is left alone until the next tick. 0 releases on the tick.",
  },
  {
    key: "cleanupIntervalHours",
    label: "Cleanup every (hours)",
    hint: "How often the destructive phase below is allowed to run.",
  },
];

function parseNumber(text: string, fallback: number): number {
  const parsed = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The three numbers are one document: edited together and saved against the displayed revision. */
function Numbers({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const [draft, setDraft] = useState<Values>(() => settings.values);
  const change = useCallback((key: keyof Values, text: string) => {
    setDraft((current) => ({ ...current, [key]: parseNumber(text, current[key] as number) }));
  }, []);
  const save = useCallback(() => {
    void settings.save(draft, settings.revision);
  }, [settings, draft]);
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  return (
    <SettingsCard>
      {NUMBER_FIELDS.map((field) => (
        <SettingsInput
          key={field.key}
          label={field.label}
          hint={field.hint}
          initialValue={String(draft[field.key])}
          disabled={settings.saving}
          onChangeText={(text) => change(field.key, text)}
        />
      ))}
      <SettingsAction
        label="Intervals"
        actionLabel="Save intervals"
        disabled={settings.saving}
        onPress={save}
      />
      {settings.saveError ? <Text style={style}>{settings.saveError}</Text> : null}
    </SettingsCard>
  );
}

function PurgeNow({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const runCleanup = useRpc(runCleanupRpc);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const run = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      const result = await runCleanup({});
      const count = result.removed.length;
      if (count === 0) {
        setNote("No archived workspace to delete.");
      } else {
        const sessions =
          result.deletedSessions > 0
            ? ` and ${result.deletedSessions} pi session file${result.deletedSessions === 1 ? "" : "s"}`
            : "";
        setNote(`Deleted ${count} archived workspace${count === 1 ? "" : "s"}${sessions}.`);
      }
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }, [busy, runCleanup]);
  return (
    <>
      <SettingsAction
        label="Delete archived workspaces now"
        hint="Runs the purge immediately: every archived workspace and its pi session file. Irreversible; ignores the cleanup interval."
        actionLabel={busy ? "Deleting…" : "Delete now"}
        disabled={busy}
        error={error}
        onPress={() => void run()}
      />
      {note ? <Text style={style}>{note}</Text> : null}
    </>
  );
}

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const toggle = useCallback(
    (
      key:
        | "enabled"
        | "purgeArchivedWorkspaces"
        | "deleteProviderSessions"
        | "deleteOrphanProviderSessions",
      value: boolean,
    ) => {
      void settings.save({ ...settings.values, [key]: value }, settings.revision);
    },
    [settings],
  );
  const enabled = settings.values.enabled;
  const purge = settings.values.purgeArchivedWorkspaces;
  const sessions = settings.values.deleteProviderSessions;
  const orphans = settings.values.deleteOrphanProviderSessions;
  return (
    <SettingsSection title="Auto-release">
      <SettingsCard>
        <SettingsSwitch
          label="Auto-release"
          hint="Off: idle runtimes are never released, neither on the tick nor when a turn ends. The cleanup switches below still apply."
          value={enabled}
          disabled={settings.saving}
          onValueChange={(value) => toggle("enabled", value)}
        />
        <SettingsSwitch
          label="Purge archived workspaces"
          hint="Deletes every archived workspace, sessions included, even when agents remain."
          value={purge}
          disabled={settings.saving}
          onValueChange={(value) => toggle("purgeArchivedWorkspaces", value)}
        />
        <SettingsSwitch
          label="Delete pi session files"
          hint="Only while purging, and only pi: its transcript path is recorded, so it can be removed exactly."
          value={sessions}
          disabled={settings.saving || !purge}
          onValueChange={(value) => toggle("deleteProviderSessions", value)}
        />
        <SettingsSwitch
          label="Delete sessions Paseo does not know"
          hint="Removes provider transcripts with no Paseo agent record, i.e. sessions created by running the provider directly. Only pi is supported today; irreversible."
          value={orphans}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteOrphanProviderSessions", value)}
        />
      </SettingsCard>
      <SettingsCard>
        <PurgeNow theme={theme} />
      </SettingsCard>
      <Text style={style}>
        {purge
          ? "Archived workspaces will be deleted for good at the next cleanup; they cannot be restored."
          : "Archived workspaces are kept unless they have no sessions left."}
      </Text>
      {orphans ? (
        <Text style={style}>
          Provider sessions with no Paseo record will be deleted at the next cleanup.
        </Text>
      ) : null}
      <Numbers key={settings.revision} settings={settings} theme={theme} />
    </SettingsSection>
  );
}

export function AutoReleaseSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(autoReleaseSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") {
    return (
      <SettingsSection title="Auto-release">
        <Text style={style}>Loading settings…</Text>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Auto-release">
        <SettingsRow label="Settings">
          <Text style={style}>{settings.error}</Text>
        </SettingsRow>
        <SettingsAction label="Read the settings again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore the defaults" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }
  return <Controls settings={settings} theme={theme} />;
}

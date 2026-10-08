import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
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
    hint: "Releases runtimes and runs the cleanup.",
  },
  {
    key: "graceMinutes",
    label: "Grace (minutes)",
    hint: "Skip runtimes touched this recently. 0 releases on the tick.",
  },
  {
    key: "cleanupIntervalHours",
    label: "Cleanup every (hours)",
    hint: "How often the cleanup may run.",
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

function describeResult(result: {
  removed: Array<{ agents: number }>;
  deletedAgents: number;
  deletedSessions: number;
  deletedProjects: number;
  deletedOrphanSessions: number;
}): string {
  const workspaces = result.removed.length;
  const agents = result.deletedAgents + result.removed.reduce((total, item) => total + item.agents, 0);
  const projects = result.deletedProjects;
  const sessions = result.deletedSessions + result.deletedOrphanSessions;
  if (workspaces === 0 && agents === 0 && projects === 0 && sessions === 0) {
    return "Nothing archived to delete.";
  }
  const parts: string[] = [];
  if (workspaces > 0) {
    parts.push(`${workspaces} archived workspace${workspaces === 1 ? "" : "s"}`);
  }
  if (agents > 0) {
    parts.push(`${agents} archived agent${agents === 1 ? "" : "s"}`);
  }
  if (projects > 0) {
    parts.push(`${projects} archived project${projects === 1 ? "" : "s"}`);
  }
  if (sessions > 0) {
    parts.push(`${sessions} pi session file${sessions === 1 ? "" : "s"}`);
  }
  return `Deleted ${parts.join(", ")}.`;
}

/**
 * The one destructive action, in the theme's danger colour so it cannot be mistaken for a toggle:
 * it purges every archived thing at once, without a second confirmation.
 */
function PrivacyCleanup({ theme }: { theme: PluginSurfaceProps["theme"] }) {
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
      setNote(describeResult(await runCleanup({})));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }, [busy, runCleanup]);
  return (
    <View style={{ gap: 6 }}>
      <Pressable
        accessibilityRole="button"
        disabled={busy}
        onPress={() => void run()}
        style={({ pressed }) => ({
          alignItems: "center",
          backgroundColor: theme.colors.statusDanger,
          borderRadius: 10,
          opacity: busy ? 0.6 : pressed ? 0.85 : 1,
          paddingHorizontal: 16,
          paddingVertical: 12,
        })}
      >
        <Text style={{ color: "#fff", fontWeight: "700" }}>
          {busy ? "Cleaning up…" : "Privacy cleanup"}
        </Text>
      </Pressable>
      <Text style={style}>
        Delete every archived workspace, agent and project now, plus orphan pi sessions while pi
        session files are on. Irreversible.
      </Text>
      {note ? <Text style={style}>{note}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const toggle = useCallback(
    (
      key:
        | "enabled"
        | "deleteProviderSessions"
        | "deleteArchivedWorkspaces"
        | "deleteArchivedAgents",
      value: boolean,
    ) => {
      void settings.save({ ...settings.values, [key]: value }, settings.revision);
    },
    [settings],
  );
  const enabled = settings.values.enabled;
  const sessions = settings.values.deleteProviderSessions;
  const workspaces = settings.values.deleteArchivedWorkspaces;
  const agents = settings.values.deleteArchivedAgents;
  return (
    <SettingsSection title="Auto-release">
      <SettingsCard>
        <SettingsSwitch
          label="Auto-release"
          hint="Run the timer. Off stops release and the automatic cleanup; the button below still works."
          value={enabled}
          disabled={settings.saving}
          onValueChange={(value) => toggle("enabled", value)}
        />
        <SettingsSwitch
          label="Delete pi session files"
          hint="Also delete pi transcripts when deleting agents. Off deletes Paseo records only."
          value={sessions}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteProviderSessions", value)}
        />
        <SettingsSwitch
          label="Delete archived workspaces"
          hint="Delete every archived workspace, with the agents inside it."
          value={workspaces}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteArchivedWorkspaces", value)}
        />
        <SettingsSwitch
          label="Delete archived agents"
          hint="Delete every archived agent, even in a workspace that is not archived."
          value={agents}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteArchivedAgents", value)}
        />
      </SettingsCard>
      <SettingsCard>
        <PrivacyCleanup theme={theme} />
      </SettingsCard>
      <Text style={style}>
        {workspaces || agents
          ? "Archived items are deleted at the next cleanup. Cannot be undone."
          : "Nothing archived is deleted automatically."}
      </Text>
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

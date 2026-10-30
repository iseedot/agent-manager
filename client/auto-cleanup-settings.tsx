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
import { autoCleanupSettings } from "../shared/settings";
import { useMessages, type Translate } from "./messages";

type Ready = Extract<SettingsState<typeof autoCleanupSettings.schema>, { status: "ready" }>;
type Values = Ready["values"];

function parseNumber(text: string, fallback: number): number {
  const parsed = Number(text.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The one number the cleanup has: how often the automatic pass may run. */
function Schedule({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const { t } = useMessages();
  const [draft, setDraft] = useState<Values>(() => settings.values);
  const change = useCallback((text: string) => {
    setDraft((current) => ({ ...current, cleanupIntervalHours: parseNumber(text, current.cleanupIntervalHours) }));
  }, []);
  const save = useCallback(() => {
    void settings.save(draft, settings.revision);
  }, [settings, draft]);
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  return (
    <SettingsCard>
      <SettingsInput
        label={t("cleanupLabel")}
        hint={t("cleanupHint")}
        initialValue={String(draft.cleanupIntervalHours)}
        disabled={settings.saving}
        onChangeText={change}
      />
      <SettingsAction
        label={t("schedule")}
        actionLabel={t("saveSchedule")}
        disabled={settings.saving}
        onPress={save}
      />
      {settings.saveError ? <Text style={style}>{settings.saveError}</Text> : null}
    </SettingsCard>
  );
}

function describeResult(
  result: {
    removed: Array<{ agents: number }>;
    deletedAgents: number;
    deletedSessions: number;
    deletedProjects: number;
    deletedOrphanSessions: number;
  },
  t: Translate,
): string {
  const workspaces = result.removed.length;
  const agents = result.deletedAgents + result.removed.reduce((total, item) => total + item.agents, 0);
  const projects = result.deletedProjects;
  const sessions = result.deletedSessions + result.deletedOrphanSessions;
  if (workspaces === 0 && agents === 0 && projects === 0 && sessions === 0) {
    return t("nothingArchived");
  }
  const parts: string[] = [];
  if (workspaces > 0) {
    parts.push(t("workspaces", { count: workspaces }));
  }
  if (agents > 0) {
    parts.push(t("agents", { count: agents }));
  }
  if (projects > 0) {
    parts.push(t("projects", { count: projects }));
  }
  if (sessions > 0) {
    parts.push(t("sessions", { count: sessions }));
  }
  return t("deleted", { items: parts.join(t("separator")) });
}

/**
 * The one destructive action, in the theme's danger colour so it cannot be mistaken for a toggle:
 * it purges every archived thing at once, without a second confirmation.
 */
function PrivacyCleanup({ theme }: { theme: PluginSurfaceProps["theme"] }) {
  const { t } = useMessages();
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
      setNote(describeResult(await runCleanup({}), t));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(false);
    }
  }, [busy, runCleanup, t]);
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
          {busy ? t("privacyCleaningUp") : t("privacyCleanup")}
        </Text>
      </Pressable>
      <Text style={style}>{t("privacyDescription")}</Text>
      {note ? <Text style={style}>{note}</Text> : null}
      {error ? <Text style={{ color: theme.colors.statusDanger }}>{error}</Text> : null}
    </View>
  );
}

function Controls({ settings, theme }: { settings: Ready; theme: PluginSurfaceProps["theme"] }) {
  const { t } = useMessages();
  const style = useMemo(() => ({ color: theme.colors.foregroundMuted }), [theme]);
  const toggle = useCallback(
    (
      key:
        | "autoCleanup"
        | "deleteProviderSessions"
        | "deleteArchivedWorkspaces"
        | "deleteArchivedAgents",
      value: boolean,
    ) => {
      void settings.save({ ...settings.values, [key]: value }, settings.revision);
    },
    [settings],
  );
  const enabled = settings.values.autoCleanup;
  const sessions = settings.values.deleteProviderSessions;
  const workspaces = settings.values.deleteArchivedWorkspaces;
  const agents = settings.values.deleteArchivedAgents;
  return (
    <SettingsSection title={t("title")}>
      <SettingsCard>
        <SettingsSwitch
          label={t("autoCleanup")}
          hint={t("autoCleanupHint")}
          value={enabled}
          disabled={settings.saving}
          onValueChange={(value) => toggle("autoCleanup", value)}
        />
        <SettingsSwitch
          label={t("deletePi")}
          hint={t("deletePiHint")}
          value={sessions}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteProviderSessions", value)}
        />
        <SettingsSwitch
          label={t("deleteWorkspaces")}
          hint={t("deleteWorkspacesHint")}
          value={workspaces}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteArchivedWorkspaces", value)}
        />
        <SettingsSwitch
          label={t("deleteAgentsLabel")}
          hint={t("deleteAgentsHint")}
          value={agents}
          disabled={settings.saving}
          onValueChange={(value) => toggle("deleteArchivedAgents", value)}
        />
      </SettingsCard>
      <SettingsCard>
        <PrivacyCleanup theme={theme} />
      </SettingsCard>
      <Text style={style}>
        {workspaces || agents ? t("archivedWillDelete") : t("archivedKept")}
      </Text>
      <Schedule key={settings.revision} settings={settings} theme={theme} />
    </SettingsSection>
  );
}

export function AutoCleanupSettingsScreen({ theme }: PluginSurfaceProps) {
  const { t } = useMessages();
  const settings = useSettings(autoCleanupSettings);
  const style = useMemo(() => ({ color: theme.colors.foreground }), [theme]);
  if (settings.status === "loading") {
    return (
      <SettingsSection title={t("title")}>
        <Text style={style}>{t("loading")}</Text>
      </SettingsSection>
    );
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title={t("title")}>
        <SettingsRow label={t("settingsLabel")}>
          <Text style={style}>{settings.error}</Text>
        </SettingsRow>
        <SettingsAction
          label={t("readAgain")}
          actionLabel={t("reload")}
          onPress={settings.reload}
        />
        {settings.status === "invalid" ? (
          <SettingsAction
            label={t("restoreDefaults")}
            actionLabel={t("reset")}
            onPress={settings.reset}
          />
        ) : null}
      </SettingsSection>
    );
  }
  return <Controls settings={settings} theme={theme} />;
}

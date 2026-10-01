import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { releaseManyRpc, snapshotRpc, type AgentRow, type SystemStats } from "../shared/contracts";
import { formatBytes, formatMemory, formatTime, message } from "./format";
import { buildStyles, type StyleMap } from "./styles";

type Client = PluginClientContext;

export type WorkspacePillPanelProps = PluginButtonContentProps & {
  client: Client;
  onNewAgent: (workspaceId: string) => void;
  onOpenTab: (agentId: string) => void;
};

export type TabStateTone = "running" | "unread" | "input" | "failed" | "idle";

export interface TabState {
  label: string;
  tone: TabStateTone;
}

export function tabState(row: AgentRow): TabState {
  if (row.attentionReason === "permission") {
    return { label: "needs input", tone: "input" };
  }
  if (row.status === "error" || row.attentionReason === "error") {
    return { label: "failed", tone: "failed" };
  }
  if (row.status === "running") {
    return { label: "running", tone: "running" };
  }
  if (row.attentionReason === "finished") {
    return { label: "unread", tone: "unread" };
  }
  if (row.pid !== null) {
    return { label: "idle", tone: "idle" };
  }
  return { label: "no runtime", tone: "idle" };
}

export function tabTitle(row: AgentRow): string {
  const title = row.title?.trim();
  const text = title && title.length > 0 ? title : row.id.slice(0, 7);
  return text.length > 44 ? `${text.slice(0, 43)}…` : text;
}

export function WorkspacePillPanel(props: WorkspacePillPanelProps) {
  const { client, theme, layout, close, onNewAgent, onOpenTab } = props;
  const workspaceId = props.workspaceId;
  const agentId = props.context === "agent" ? props.agentId : null;
  const { styles, tones } = useMemo(() => buildStyles(theme, layout.compact), [theme, layout.compact]);
  const [agents, setAgents] = useState<AgentRow[] | null>(null);
  const [system, setSystem] = useState<SystemStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const snapshot = await client.rpc(snapshotRpc, {});
      setAgents(snapshot.overview.agents);
      setSystem(snapshot.system);
      setError(null);
    } catch (loadError) {
      setError(message(loadError));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const tabs = useMemo(
    () =>
      (agents ?? [])
        .filter((row) => row.workspaceId === workspaceId && !row.archived && row.parentAgentId === null)
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")),
    [agents, workspaceId],
  );
  const current = useMemo(
    () => (agents ?? []).find((row) => row.id === agentId) ?? null,
    [agents, agentId],
  );
  const holding = useMemo(
    () => (agents ?? []).filter((row) => row.workspaceId === workspaceId && row.pid !== null),
    [agents, workspaceId],
  );
  const heldBytes = holding.reduce((sum, row) => sum + (row.rssBytes ?? 0), 0);
  const idle = holding.filter((row) => row.status !== "running").map((row) => row.id);

  const release = async () => {
    if (busy || idle.length === 0) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const result = await client.rpc(releaseManyRpc, { agentIds: idle, allowSignalFallback: true });
      await load();
      setNote(`Released ${result.released.length} · ${formatBytes(result.freedBytes)}`);
    } catch (releaseError) {
      setNote(message(releaseError));
    } finally {
      setBusy(false);
    }
  };

  const archiveTab = async (agentIdToClose: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await client.paseo.agents.ref(agentIdToClose).archive();
      await load();
      setNote("Tab closed.");
    } catch (archiveError) {
      setNote(message(archiveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.pillPanel}>
      <Text style={styles.pillHost} numberOfLines={2}>
        {system ? systemLine(system) : "reading host…"}
      </Text>

      <View style={styles.pillHead}>
        <Text style={styles.pillLabel}>TABS</Text>
        <Text style={styles.pillCount} numberOfLines={1}>
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          {heldBytes > 0 ? ` · ${formatBytes(heldBytes)} held` : ""}
        </Text>
      </View>

      {agents === null ? (
        <ActivityIndicator color={tones.accent} size="small" />
      ) : tabs.length === 0 ? (
        <Text style={styles.hint}>No open tab in this workspace.</Text>
      ) : (
        <View style={styles.pillTabs}>
          {tabs.map((row) => {
            const state = tabState(row);
            const isCurrent = row.id === agentId;
            const memory =
              row.pid === null ? state.label : `${state.label} · ${formatMemory(row.rssBytes ?? 0)}`;
            return (
              <View
                key={row.id}
                style={[styles.pillTabRow, isCurrent ? styles.pillTabRowCurrent : null]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${tabTitle(row)}`}
                  accessibilityState={{ selected: isCurrent, disabled: isCurrent }}
                  disabled={isCurrent}
                  onPress={() => {
                    close();
                    onOpenTab(row.id);
                  }}
                  style={styles.pillTabOpen}
                >
                  <View style={[styles.pillTabDot, tabDot(state.tone, styles)]} />
                  <Text
                    style={[styles.pillTabTitle, isCurrent ? styles.pillTabTitleCurrent : null]}
                    numberOfLines={1}
                  >
                    {tabTitle(row)}
                  </Text>
                  <Text style={[styles.pillTabMeta, tabMeta(state.tone, styles)]} numberOfLines={1}>
                    {memory}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Close ${tabTitle(row)}`}
                  disabled={busy}
                  hitSlop={8}
                  onPress={() => void archiveTab(row.id)}
                  style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
                    styles.pillTabClose,
                    hovered || pressed ? styles.pillTabCloseActive : null,
                    busy ? styles.disabled : null,
                  ]}
                >
                  <Text style={styles.pillTabCloseText}>×</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      )}

      <View style={styles.actionsGrid}>
        <Pressable
          accessibilityRole="button"
          style={[styles.button, styles.buttonSmall, styles.buttonPrimary, styles.pillButton]}
          onPress={() => {
            close();
            onNewAgent(workspaceId);
          }}
        >
          <Text style={styles.buttonTextOn}>New Agent</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idle.length === 0}
          style={[
            styles.button,
            styles.buttonSmall,
            styles.pillButton,
            busy || idle.length === 0 ? styles.disabled : null,
          ]}
          onPress={() => void release()}
        >
          <Text style={styles.buttonText}>Release idle ({idle.length})</Text>
        </Pressable>
      </View>

      {current ? (
        <View style={styles.pillNote}>
          <Text style={styles.pillLabel}>THIS TAB</Text>
          <Text style={styles.hint} numberOfLines={3}>
            {tabLine(current)}
          </Text>
        </View>
      ) : null}

      {busy ? <ActivityIndicator color={tones.accent} size="small" /> : null}
      {note || error ? <Text style={styles.hint}>{note ?? error}</Text> : null}
    </View>
  );
}

function tabDot(tone: TabStateTone, styles: StyleMap): StyleMap[string] {
  if (tone === "running") return styles.pillTabDotRunning;
  if (tone === "unread") return styles.pillTabDotUnread;
  if (tone === "input") return styles.pillTabDotInput;
  if (tone === "failed") return styles.pillTabDotFailed;
  return styles.pillTabDotMuted;
}

function tabMeta(tone: TabStateTone, styles: StyleMap): StyleMap[string] {
  if (tone === "running") return styles.factAccent;
  if (tone === "unread") return styles.factOk;
  if (tone === "input") return styles.factWarn;
  if (tone === "failed") return styles.factDanger;
  return undefined;
}

function systemLine(system: SystemStats): string {
  const parts: string[] = [];
  if (system.load1 !== null) parts.push(`load ${system.load1.toFixed(2)}`);
  if (system.cpuPercent !== null) parts.push(`cpu ${system.cpuPercent.toFixed(0)}%`);
  if (system.memTotalBytes !== null && system.memUsedBytes !== null) {
    parts.push(`mem ${megabytes(system.memUsedBytes)}/${megabytes(system.memTotalBytes)}`);
  }
  if (system.swapTotalBytes !== null && system.swapUsedBytes !== null && system.swapTotalBytes > 0) {
    parts.push(`swap ${megabytes(system.swapUsedBytes)}/${megabytes(system.swapTotalBytes)}`);
  }
  return parts.join(" · ") || "host metrics unavailable";
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

function tabLine(row: AgentRow): string {
  const state = tabState(row);
  return [
    state.label,
    `Created ${formatTime(row.createdAt)}`,
    `Updated ${formatTime(row.updatedAt)}`,
    row.lastUserMessageAt ? `Last message ${formatTime(row.lastUserMessageAt)}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

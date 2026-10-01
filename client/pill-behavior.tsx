import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { overviewRpc, releaseManyRpc, snapshotRpc, type AgentRow } from "../shared/contracts";
import { formatBytes, formatMegabytes, formatTime, message } from "./format";
import { buildStyles } from "./styles";

type Client = PluginClientContext;

export interface WorkspaceTab {
  id: string;
  title: string;
  current: boolean;
}

interface TabMenuInput {
  client: Client;
  workspaceId: string;
  agentId: string;
  tabs: WorkspaceTab[];
  onNewAgent: () => void;
  onOpenTab: (agentId: string) => void;
}

export function buildTabMenu({ client, workspaceId, agentId, tabs, onNewAgent, onOpenTab }: TabMenuInput) {
  void workspaceId;
  return {
    kind: "menu" as const,
    items: [
      {
        kind: "item" as const,
        id: "new-agent",
        title: "New Agent",
        behavior: { kind: "action" as const, onPress: onNewAgent },
      },
      {
        kind: "item" as const,
        id: "close-tab",
        title: "Close Tab",
        behavior: { kind: "action" as const, onPress: () => archiveAgent(client, agentId) },
      },
      { kind: "separator" as const, id: "tab-separator" },
      ...tabs.map((tab) => ({
        kind: "item" as const,
        id: `tab-${tab.id.slice(0, 8).toLowerCase()}`,
        title: tab.title,
        disabled: tab.current,
        behavior: { kind: "action" as const, onPress: () => onOpenTab(tab.id) },
      })),
    ],
  };
}

export function tabTitle(row: AgentRow): string {
  const title = row.title?.trim();
  const text = title && title.length > 0 ? title : row.id.slice(0, 7);
  return text.length > 44 ? `${text.slice(0, 43)}…` : text;
}

async function archiveAgent(client: Client, agentId: string): Promise<void> {
  try {
    await client.paseo.agents.ref(agentId).archive();
  } catch {
    return;
  }
}

async function releaseAgents(client: Client, agentIds: string[]): Promise<void> {
  try {
    await client.rpc(releaseManyRpc, { agentIds, allowSignalFallback: true });
  } catch {
    return;
  }
}

export function WorkspaceStatusPopover(
  props: PluginButtonContentProps & { client: Client; openSurface: () => void },
) {
  const { client, theme, layout, close, openSurface } = props;
  const agentId = props.context === "agent" ? props.agentId : null;
  const { styles } = useThemeStyles(theme, layout.compact);
  const [system, setSystem] = useState<string | null>(null);
  const [tab, setTab] = useState<string | null>(null);
  const [idle, setIdle] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const snapshot = await client.rpc(snapshotRpc, {});
      setSystem(snapshot.system ? systemLine(snapshot.system) : "host metrics unavailable");
      const rows = snapshot.overview?.agents ?? [];
      const current = rows.find((row) => row.id === agentId) ?? null;
      setTab(current ? tabLine(current) : null);
      setIdle(
        rows
          .filter((row) => row.workspaceId === current?.workspaceId && row.pid !== null && row.status !== "running")
          .map((row) => row.id),
      );
    } catch (error) {
      setNote(message(error));
    }
  }, [client, agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async () => {
    setBusy(true);
    try {
      await releaseAgents(client, idle);
      await load();
      setNote("Released.");
    } catch (error) {
      setNote(message(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.popover} contentContainerStyle={styles.popoverContent}>
      <Text style={styles.hint} numberOfLines={2}>
        {system ?? "reading host…"}
      </Text>
      <Text style={styles.hint} numberOfLines={2}>
        {tab ?? "reading this tab…"}
      </Text>
      <View style={styles.actionsGrid}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idle.length === 0}
          style={[styles.button, styles.buttonPrimary, busy || idle.length === 0 ? styles.disabled : null]}
          onPress={() => void release()}
        >
          <Text style={styles.buttonTextOn}>Release idle ({idle.length})</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.button}
          onPress={() => {
            close();
            openSurface();
          }}
        >
          <Text style={styles.buttonText}>Open panel</Text>
        </Pressable>
      </View>
      {busy ? <ActivityIndicator color={theme.colors.accent} size="small" /> : null}
      {note ? <Text style={styles.hint}>{note}</Text> : null}
    </ScrollView>
  );
}

function useThemeStyles(theme: PluginButtonContentProps["theme"], compact: boolean) {
  const [cache] = useState(() => buildStyles(theme, compact));
  return cache;
}

function systemLine(system: {
  load1: number | null;
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}): string {
  const parts: string[] = [];
  if (system.load1 !== null) parts.push(`load ${system.load1.toFixed(2)}`);
  if (system.cpuPercent !== null) parts.push(`cpu ${system.cpuPercent.toFixed(0)}%`);
  if (system.memTotalBytes !== null && system.memUsedBytes !== null) {
    parts.push(`mem ${formatMegabytes(system.memUsedBytes)}/${formatMegabytes(system.memTotalBytes)}`);
  }
  if (system.swapTotalBytes !== null && system.swapUsedBytes !== null && system.swapTotalBytes > 0) {
    parts.push(`swap ${formatMegabytes(system.swapUsedBytes)}/${formatMegabytes(system.swapTotalBytes)}`);
  }
  return parts.join(" · ") || "host metrics unavailable";
}

function tabLine(row: AgentRow): string {
  const memory = row.pid === null ? "no runtime" : `${formatBytes(row.rssBytes ?? 0)} · pid ${row.pid}`;
  return [
    `Created ${formatTime(row.createdAt)}`,
    `Updated ${formatTime(row.updatedAt)}`,
    row.lastUserMessageAt ? `Last message ${formatTime(row.lastUserMessageAt)}` : null,
    memory,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

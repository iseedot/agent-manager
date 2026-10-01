import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { overviewRpc, releaseManyRpc, type AgentRow } from "../shared/contracts";
import { formatBytes, message } from "./format";
import { buildStyles } from "./styles";

type Client = PluginClientContext;

export interface PillCounts {
  idleHere: number;
  sessionHasProcess: boolean;
}

export function buildPanelMenu(client: Client, workspaceId: string, agentId: string, counts: PillCounts) {
  return {
    kind: "menu" as const,
    items: [
      {
        kind: "item" as const,
        id: "open-panel",
        title: "Open Agent Manager",
        behavior: { kind: "action" as const, onPress: () => client.openSurface("agent-manager") },
      },
      {
        kind: "item" as const,
        id: "release-idle-workspace",
        title: counts.idleHere > 0 ? `Release idle sessions here (${counts.idleHere})` : "Release idle sessions here",
        disabled: counts.idleHere === 0,
        behavior: { kind: "action" as const, onPress: () => releaseIdle(client, workspaceId) },
      },
      { kind: "separator" as const, id: "menu-sep" },
      {
        kind: "item" as const,
        id: "release-session",
        title: "Release this session",
        disabled: !counts.sessionHasProcess,
        behavior: { kind: "action" as const, onPress: () => releaseAgents(client, [agentId]) },
      },
      {
        kind: "item" as const,
        id: "archive-session",
        title: "Archive this session",
        behavior: { kind: "action" as const, onPress: () => archiveAgent(client, agentId) },
      },
    ],
  };
}

async function fetchWorkspaceAgents(client: Client, workspaceId: string): Promise<AgentRow[]> {
  const overview = await client.rpc(overviewRpc, {});
  return overview.agents.filter((agent) => agent.workspaceId === workspaceId);
}

async function releaseIdle(client: Client, workspaceId: string): Promise<void> {
  const rows = await fetchWorkspaceAgents(client, workspaceId);
  const idle = rows.filter((agent) => agent.pid !== null && agent.status !== "running").map((agent) => agent.id);
  if (idle.length > 0) {
    await releaseAgents(client, idle);
  }
}

async function releaseAgents(client: Client, agentIds: string[]): Promise<void> {
  try {
    await client.rpc(releaseManyRpc, { agentIds, allowSignalFallback: true });
  } catch {
    return;
  }
}

async function archiveAgent(client: Client, agentId: string): Promise<void> {
  try {
    await client.paseo.agents.ref(agentId).archive();
  } catch {
    return;
  }
}

export function WorkspaceMemoryPopover({
  client,
  theme,
  layout,
  workspaceId,
  close,
  openSurface,
}: PluginButtonContentProps & {
  client: Client;
  openSurface: () => void;
}) {
  const { styles } = buildStyles(theme, layout.compact);
  const [rows, setRows] = useState<AgentRow[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await fetchWorkspaceAgents(client, workspaceId));
    } catch (error) {
      setNote(message(error));
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
      await load();
      setNote("Done.");
    } catch (error) {
      setNote(message(error));
    } finally {
      setBusy(false);
    }
  };

  const agents = rows ?? [];
  const holding = agents.filter((agent) => agent.pid !== null);
  const idle = holding.filter((agent) => agent.status !== "running");
  const bytes = holding.reduce((sum, agent) => sum + (agent.rssBytes ?? 0), 0);

  return (
    <ScrollView style={styles.popover} contentContainerStyle={styles.popoverContent}>
      <Text style={styles.autoLabel}>This workspace</Text>
      <Text style={styles.autoStatus}>
        {rows === null
          ? "reading sessions…"
          : `${agents.length} session(s) · ${holding.length} holding · ${formatBytes(bytes)}`}
      </Text>

      {holding.length > 0 ? (
        <View style={styles.popoverList}>
          {holding.slice(0, 6).map((agent) => (
            <Text key={agent.id} style={styles.hint} numberOfLines={1}>
              {agent.status} · {formatBytes(agent.rssBytes ?? 0)} · {agent.title?.trim() || agent.id.slice(0, 7)}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.actionsGrid}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idle.length === 0}
          style={[styles.button, styles.buttonPrimary, busy || idle.length === 0 ? styles.disabled : null]}
          onPress={() => void run(() => releaseAgents(client, idle.map((agent) => agent.id)))}
        >
          <Text style={styles.buttonTextOn}>Release idle ({idle.length})</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || holding.length === 0}
          style={[styles.button, busy || holding.length === 0 ? styles.disabled : null]}
          onPress={() => void run(() => releaseAgents(client, holding.map((agent) => agent.id)))}
        >
          <Text style={styles.buttonText}>Release all ({holding.length})</Text>
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

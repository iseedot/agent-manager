import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { useAgentDirectory, type DirectoryAgent } from "./agent-directory";
import { buildStyles, type StyleMap } from "./styles";

type Client = PluginClientContext;

/**
 * A client only picks up plugin code when it refetches the catalog, so a phone can keep running an
 * older bundle. The stamp is derived from the code that is actually executing here, which makes a
 * stale client obvious when compared with a freshly built one.
 */
const UI_STAMP: string = (() => {
  let hash = 0;
  const sources = [WorkspacePillPanel, tabState, tabTitle, buildStyles].map((value) => {
    try {
      return String(value);
    } catch {
      return "";
    }
  });
  for (const source of sources) {
    for (let index = 0; index < source.length; index += 1) {
      hash = (hash * 31 + source.charCodeAt(index)) % 0xffffffff;
    }
  }
  return hash.toString(36).slice(0, 6);
})();

type WorkspacePillPanelProps = PluginButtonContentProps & {
  client: Client;
  onNewAgent: (workspaceId: string) => void;
  onOpenTab: (agentId: string) => void;
};

type TabStateTone = "running" | "unread" | "input" | "failed" | "idle";

interface TabState {
  label: string;
  tone: TabStateTone;
}

function tabState(row: DirectoryAgent): TabState {
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
  if (row.status !== "closed") {
    return { label: "idle", tone: "idle" };
  }
  return { label: "no runtime", tone: "idle" };
}

function tabTitle(row: DirectoryAgent): string {
  const title = row.title?.trim();
  const text = title && title.length > 0 ? title : row.id.slice(0, 7);
  return text.length > 44 ? `${text.slice(0, 43)}…` : text;
}

export function WorkspacePillPanel(props: WorkspacePillPanelProps) {
  const { client, theme, layout, close, onNewAgent, onOpenTab } = props;
  const workspaceId = props.workspaceId;
  const agentId = props.context === "agent" ? props.agentId : null;
  const { styles, tones } = useMemo(() => buildStyles(theme, layout.compact), [theme, layout.compact]);
  const agents = useAgentDirectory();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const workspaceAgents = useMemo(
    () => agents.filter((row) => row.workspaceId === workspaceId && row.archivedAt === null),
    [agents, workspaceId],
  );
  const tabs = useMemo(
    () =>
      workspaceAgents
        .filter((row) => row.parentAgentId === null)
        .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")),
    [workspaceAgents],
  );

  const archiveTab = async (agentIdToClose: string) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      await client.paseo.agents.ref(agentIdToClose).archive();
      setNote("Tab closed.");
    } catch (archiveError) {
      setNote(archiveError instanceof Error ? archiveError.message : String(archiveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.pillPanel}>
      <View style={styles.pillHead}>
        <Text style={styles.pillLabel}>TABS</Text>
        <Text style={styles.pillCount} numberOfLines={1}>
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </Text>
      </View>

      {tabs.length === 0 ? (
        <Text style={styles.hint}>No open tab in this workspace.</Text>
      ) : (
        <View style={styles.pillTabs}>
          {tabs.map((row) => {
            const state = tabState(row);
            const isCurrent = row.id === agentId;
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
                    {state.label}
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
      </View>

      {busy ? <ActivityIndicator color={tones.accent} size="small" /> : null}
      {note ? <Text style={styles.hint}>{note}</Text> : null}
      <Text style={styles.buildStamp}>ui {UI_STAMP}</Text>
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

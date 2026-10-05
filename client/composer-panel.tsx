import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import { factsRpc, type FactsPayload, type SystemStats } from "../shared/contracts";
import { useAgentDirectory, type DirectoryAgent } from "./agent-directory";
import { formatTime, message } from "./format";
import { dismissGitNotice, runGitNoticeAction, sortNotices, useGitNotices } from "./git-notices";
import { buildStyles, type StyleMap } from "./styles";

type Client = PluginClientContext;

const MAX_VISIBLE_NOTICES = 2;

/**
 * A client only picks up plugin code when it refetches the catalog, so a phone can keep running an
 * older bundle. The stamp is derived from the code that is actually executing here, which makes a
 * stale client obvious when compared with a freshly built one.
 */
const UI_STAMP: string = (() => {
  let hash = 0;
  const sources = [WorkspacePillPanel, tabState, tabTitle, buildStyles, formatTime].map((value) => {
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
  const notices = useGitNotices();
  const [facts, setFacts] = useState<FactsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyNotice, setBusyNotice] = useState<number | null>(null);

  const loadFacts = useCallback(async () => {
    try {
      setFacts(await client.rpc(factsRpc, {}));
      setError(null);
    } catch (loadError) {
      setError(message(loadError));
    }
  }, [client]);

  useEffect(() => {
    void loadFacts();
  }, [loadFacts]);

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
  const current = useMemo(() => agents.find((row) => row.id === agentId) ?? null, [agents, agentId]);
  const terminal = useMemo(
    () => facts?.terminals.find((row) => row.workspaceId === workspaceId) ?? null,
    [facts, workspaceId],
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
      setNote(message(archiveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.pillPanel}>
      <Text style={styles.pillHost} numberOfLines={2}>
        {facts ? systemLine(facts.system) : "reading host…"}
      </Text>
      <Text style={styles.hint} numberOfLines={1}>
        {terminal
          ? `${terminal.count} terminal${terminal.count === 1 ? "" : "s"}${terminal.working > 0 ? ` · ${terminal.working} working` : ""}${terminal.waiting > 0 ? ` · ${terminal.waiting} waiting` : ""}`
          : "No terminals"}
      </Text>
      <Text style={styles.hint} numberOfLines={1}>
        {facts ? autoReleaseLine(facts.autoRelease) : "reading auto-release…"}
      </Text>

      {notices.length > 0 ? (
        <View style={styles.pillNote}>
          <Text style={styles.pillLabel}>NOTICES</Text>
          {sortNotices(notices)
            .slice(0, MAX_VISIBLE_NOTICES)
            .map((notice) => (
              <View key={notice.id} style={styles.noticeBlock}>
                <View style={styles.pillTabRow}>
                  <Text style={styles.hint} numberOfLines={1}>
                    {notice.title}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss notice"
                    hitSlop={8}
                    onPress={() => dismissGitNotice(notice.id)}
                    style={styles.pillTabClose}
                  >
                    <Text style={styles.pillTabCloseText}>×</Text>
                  </Pressable>
                </View>
                {notice.actions && notice.actions.length > 0 ? (
                  <View style={styles.actionsGrid}>
                    {notice.actions.map((action) => (
                      <Pressable
                        key={action.id}
                        accessibilityRole="button"
                        disabled={busyNotice !== null}
                        onPress={() => {
                          setBusyNotice(notice.id);
                          setNote(null);
                          void runGitNoticeAction(notice.id, action.id)
                            .then((failure) => {
                              if (failure) setNote(failure);
                            })
                            .finally(() => setBusyNotice(null));
                        }}
                        style={({ hovered, pressed }: { hovered?: boolean; pressed?: boolean }) => [
                          styles.button,
                          styles.buttonSmall,
                          action.tone === "danger" ? styles.buttonDanger : null,
                          action.tone === "primary" ? styles.buttonPrimary : null,
                          hovered || pressed ? styles.buttonHover : null,
                          busyNotice !== null ? styles.disabled : null,
                        ]}
                      >
                        <Text
                          style={
                            action.tone === "danger" || action.tone === "primary"
                              ? styles.buttonTextOn
                              : styles.buttonText
                          }
                        >
                          {action.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : null}
              </View>
            ))}

          {notices.length > MAX_VISIBLE_NOTICES ? (
            <Text style={styles.hint}>{notices.length - MAX_VISIBLE_NOTICES} more</Text>
          ) : null}
        </View>
      ) : null}

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

/** Auto-release, on the same line as the host numbers it belongs to. */
function autoReleaseLine(status: FactsPayload["autoRelease"]): string {
  const parts: string[] = [`release ${status.idleMinutes}m idle`];
  if (status.running) {
    parts.push("sweeping now");
  } else if (status.lastRunAt) {
    parts.push(`last ${clock(status.lastRunAt)}${status.released > 0 ? ` (${status.released} released)` : ""}`);
  } else {
    parts.push("never ran");
  }
  if (status.dueAt) {
    parts.push(`due ${clock(status.dueAt)}`);
  } else if (status.nextRunAt) {
    parts.push(`next ${clock(status.nextRunAt)}`);
  }
  if (status.error) {
    parts.push(`error: ${status.error}`);
  }
  return parts.join(" · ");
}

function clock(iso: string | null): string {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) {
    return "?";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
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

function tabLine(row: DirectoryAgent): string {
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

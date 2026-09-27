import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
  archiveManyRpc,
  deleteManyRpc,
  overviewRpc,
  releaseManyRpc,
  releaseRpc,
  type AgentRow,
} from "../shared/contracts";

const EMPTY_HOSTS: readonly { serverId: string; label: string; status: string }[] = [];

interface HostSummary {
  serverId: string;
  label: string;
  status: string;
  total: number | null;
  running: number | null;
  archived: number | null;
  error: string | null;
}

export function AgentManagerPanel({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const fetchOverview = useRpc(overviewRpc);
  const releaseOne = useRpc(releaseRpc);
  const releaseMany = useRpc(releaseManyRpc);
  const archiveMany = useRpc(archiveManyRpc);
  const deleteMany = useRpc(deleteManyRpc);

  const [onlyLive, setOnlyLive] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<readonly string[] | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const hostsSupported = typeof useHosts === "function";
  const hostList = hostsSupported ? useHosts() : EMPTY_HOSTS;
  const hostsAddressable = typeof getPaseoClient === "function";

  const otherHosts = useMemo(
    () =>
      hostList
        .filter((entry) => entry.serverId !== host.id && entry.status === "online")
        .map((entry) => ({ serverId: entry.serverId, label: entry.label })),
    [hostList, host.id],
  );

  const overview = useQuery({
    queryKey: ["agent-manager", "overview", host.id],
    queryFn: () => fetchOverview({}),
  });

  const otherHostsQuery = useQuery({
    queryKey: ["agent-manager", "hosts", otherHosts.map((entry) => entry.serverId).join(",")],
    enabled: otherHosts.length > 0 && hostsAddressable,
    queryFn: async (): Promise<HostSummary[]> => {
      const summaries: HostSummary[] = [];
      for (const entry of otherHosts) {
        try {
          const api = getPaseoClient(entry.serverId);
          const page = (await api.agents.list({
            filter: { includeArchived: true },
            page: { limit: 200 },
          })) as unknown as { entries?: Array<{ agent?: RawListedAgent }> };
          const agents = (page.entries ?? [])
            .map((item) => item.agent)
            .filter((agent): agent is RawListedAgent => Boolean(agent));
          summaries.push({
            ...entry,
            status: "online",
            total: agents.length,
            running: agents.filter((agent) => agent.status === "running").length,
            archived: agents.filter((agent) => Boolean(agent.archivedAt)).length,
            error: null,
          });
        } catch (error) {
          summaries.push({ ...entry, status: "error", total: null, running: null, archived: null, error: message(error) });
        }
      }
      return summaries;
    },
  });

  const invalidate = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent-manager"] });
  }, [queryClient]);

  const release = useMutation({
    mutationFn: (agentId: string) => releaseOne({ agentId, allowSignalFallback: true }),
    onSuccess: async (result) => {
      setFeedback(result.message);
      await invalidate();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const batchRelease = useMutation({
    mutationFn: (agentIds: readonly string[]) =>
      releaseMany({ agentIds: [...agentIds], allowSignalFallback: true }),
    onSuccess: async (result) => {
      setFeedback(summarize(`Released ${result.released.length}`, formatBytes(result.freedBytes), result.failed));
      setSelected([]);
      await invalidate();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const batchArchive = useMutation({
    mutationFn: (agentIds: readonly string[]) => archiveMany({ agentIds: [...agentIds] }),
    onSuccess: async (result) => {
      setFeedback(summarize(`Archived ${result.succeeded.length}`, null, result.failed));
      setSelected([]);
      await invalidate();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const batchDelete = useMutation({
    mutationFn: (agentIds: readonly string[]) => deleteMany({ agentIds: [...agentIds] }),
    onSuccess: async (result) => {
      setFeedback(summarize(`Deleted ${result.succeeded.length}`, null, result.failed));
      setSelected([]);
      setPendingDelete(null);
      await invalidate();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const data = overview.data;
  const agents = useMemo(() => {
    const rows = data?.agents ?? [];
    return onlyLive ? rows.filter((row) => row.pid !== null) : rows;
  }, [data?.agents, onlyLive]);

  const idleWithProcess = useMemo(
    () => (data?.agents ?? []).filter((row) => row.pid !== null && row.status !== "running"),
    [data?.agents],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedRows = useMemo(
    () => (data?.agents ?? []).filter((row) => selectedSet.has(row.id)),
    [data?.agents, selectedSet],
  );

  const busy =
    release.isPending ||
    batchRelease.isPending ||
    batchArchive.isPending ||
    batchDelete.isPending;

  const toggle = useCallback((agentId: string) => {
    setPendingDelete(null);
    setSelected((current) =>
      current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId],
    );
  }, []);

  const selectVisible = useCallback(() => {
    setPendingDelete(null);
    setSelected(agents.map((row) => row.id));
  }, [agents]);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0, padding: layout.compact ? 12 : 20 },
      summary: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      dim: { color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 4 },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 12, marginBottom: 12 },
      chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: theme.colors.surface2 },
      chipActive: { backgroundColor: theme.colors.accent },
      chipDanger: { backgroundColor: theme.colors.statusDanger },
      chipDisabled: { opacity: 0.4 },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipTextActive: { color: theme.colors.accentForeground, fontSize: 13 },
      chipTextDanger: { color: theme.colors.accentForeground, fontSize: 13 },
      confirm: {
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 8,
        padding: 12,
        gap: 8,
        marginBottom: 12,
      },
      confirmText: { color: theme.colors.foreground, fontSize: 13 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginTop: 16 },
      hostRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingVertical: 6,
      },
      row: { borderTopWidth: 1, borderTopColor: theme.colors.border, paddingVertical: 10, gap: 6 },
      rowHeader: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      checkbox: {
        width: 22,
        height: 22,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface2,
      },
      checkboxOn: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
      checkboxText: { color: theme.colors.accentForeground, fontSize: 13 },
      title: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flexShrink: 1 },
      badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: theme.colors.surface2 },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, marginTop: 4, flexWrap: "wrap" as const },
      action: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      actionPrimary: { backgroundColor: theme.colors.accent },
      actionDanger: { backgroundColor: theme.colors.statusDanger },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      actionTextOn: { color: theme.colors.accentForeground, fontSize: 12 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 20 },
      feedback: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        marginTop: 12,
        paddingTop: 8,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
      },
      warning: { color: theme.colors.statusWarning, fontSize: 12, marginTop: 8 },
    }),
    [theme, layout.compact],
  );

  if (overview.isLoading && !data) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (overview.isError && !data) {
    return (
      <View style={styles.screen}>
        <Text style={styles.empty}>Failed to read agents: {message(overview.error)}</Text>
      </View>
    );
  }

  const selectedCount = selected.length;

  return (
    <View style={styles.screen}>
      <Text style={styles.summary}>
        {data?.totals.total ?? 0} sessions · {data?.totals.holdingProcess ?? 0} holding a process ·{" "}
        {formatBytes(data?.totals.rssBytes ?? 0)}
      </Text>
      <Text style={styles.dim}>
        closed {data?.totals.closed ?? 0} · archived {data?.totals.archived ?? 0} · release via{" "}
        {data?.endpoint ?? "unavailable"} · delete via {data?.cliAvailable ? "paseo CLI" : "unavailable"}
      </Text>
      <Text style={styles.dim}>
        Loaded at {formatLoadedAt(overview.dataUpdatedAt)}. This panel reads on open and on Refresh only.
      </Text>

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          style={[styles.chip, onlyLive ? styles.chipActive : null]}
          onPress={() => setOnlyLive((value) => !value)}
        >
          <Text style={onlyLive ? styles.chipTextActive : styles.chipText}>
            Only holding a process ({data?.totals.holdingProcess ?? 0})
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.chip} onPress={() => void invalidate()}>
          <Text style={styles.chipText}>{overview.isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.chip} onPress={selectVisible}>
          <Text style={styles.chipText}>Select visible ({agents.length})</Text>
        </Pressable>
        {selectedCount > 0 ? (
          <Pressable accessibilityRole="button" style={styles.chip} onPress={() => setSelected([])}>
            <Text style={styles.chipText}>Clear selection</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idleWithProcess.length === 0}
          style={[styles.chip, styles.chipActive, busy || idleWithProcess.length === 0 ? styles.chipDisabled : null]}
          onPress={() => {
            setFeedback(null);
            batchRelease.mutate(idleWithProcess.map((row) => row.id));
          }}
        >
          <Text style={styles.chipTextActive}>Release all idle ({idleWithProcess.length})</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || selectedCount === 0}
          style={[styles.chip, styles.chipActive, busy || selectedCount === 0 ? styles.chipDisabled : null]}
          onPress={() => {
            setFeedback(null);
            batchRelease.mutate(selected);
          }}
        >
          <Text style={styles.chipTextActive}>Release selected ({selectedCount})</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || selectedCount === 0}
          style={[styles.chip, busy || selectedCount === 0 ? styles.chipDisabled : null]}
          onPress={() => {
            setFeedback(null);
            batchArchive.mutate(selected);
          }}
        >
          <Text style={styles.chipText}>Archive selected</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || selectedCount === 0}
          style={[styles.chip, styles.chipDanger, busy || selectedCount === 0 ? styles.chipDisabled : null]}
          onPress={() => {
            setFeedback(null);
            setPendingDelete(selected);
          }}
        >
          <Text style={styles.chipTextDanger}>Delete selected</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={!navigation || selectedCount === 0}
          style={[styles.chip, !navigation || selectedCount === 0 ? styles.chipDisabled : null]}
          onPress={() => {
            for (const row of selectedRows) {
              navigation?.openAgent({ agentId: row.id });
            }
          }}
        >
          <Text style={styles.chipText}>Open selected</Text>
        </Pressable>
      </View>

      {pendingDelete ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>
            Permanently delete {pendingDelete.length} session(s)? This cannot be undone.
          </Text>
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.action, styles.actionDanger, busy ? styles.chipDisabled : null]}
              onPress={() => batchDelete.mutate(pendingDelete)}
            >
              <Text style={styles.actionTextOn}>Confirm delete</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={styles.action} onPress={() => setPendingDelete(null)}>
              <Text style={styles.actionText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <ScrollView>
        {agents.length === 0 ? (
          <Text style={styles.empty}>No sessions match.</Text>
        ) : (
          agents.map((row) => (
            <RowView
              key={row.id}
              row={row}
              styles={styles}
              busy={busy}
              selected={selectedSet.has(row.id)}
              onToggle={() => toggle(row.id)}
              onRelease={() => {
                setFeedback(null);
                release.mutate(row.id);
              }}
              onArchive={() => {
                setFeedback(null);
                batchArchive.mutate([row.id]);
              }}
              onDelete={() => {
                setFeedback(null);
                setPendingDelete([row.id]);
              }}
              onOpen={navigation ? () => navigation.openAgent({ agentId: row.id }) : undefined}
            />
          ))
        )}
      </ScrollView>

      {otherHosts.length > 0 ? (
        <View>
          <Text style={styles.sectionTitle}>Other hosts</Text>
          {!hostsAddressable ? (
            <Text style={styles.meta}>This app build cannot read other hosts from a plugin.</Text>
          ) : null}
          {otherHostsQuery.isLoading ? <Text style={styles.meta}>Loading…</Text> : null}
          {(otherHostsQuery.data ?? []).map((entry) => (
            <View key={entry.serverId} style={styles.hostRow}>
              <Text style={styles.meta}>
                {entry.label}
                {entry.error
                  ? ` · ${entry.error}`
                  : ` · ${entry.total ?? 0} sessions · ${entry.running ?? 0} running · ${entry.archived ?? 0} archived`}
              </Text>
            </View>
          ))}
          <Text style={styles.meta}>
            Release, archive, and delete run on the host this screen is showing. Use the host picker in the header to
            switch, or install this plugin on that host.
          </Text>
        </View>
      ) : null}

      {data?.warning ? <Text style={styles.warning}>{data.warning}</Text> : null}
      {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
    </View>
  );
}

interface RawListedAgent {
  status?: string;
  archivedAt?: string | null;
}

function RowView({
  row,
  styles,
  busy,
  selected,
  onToggle,
  onRelease,
  onArchive,
  onDelete,
  onOpen,
}: {
  row: AgentRow;
  styles: Record<string, unknown>;
  busy: boolean;
  selected: boolean;
  onToggle: () => void;
  onRelease: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onOpen?: () => void;
}) {
  return (
    <View style={styles.row as never}>
      <View style={styles.rowHeader as never}>
        <Pressable
          accessibilityRole="checkbox"
          accessibilityState={{ checked: selected }}
          style={[styles.checkbox as never, selected ? (styles.checkboxOn as never) : null]}
          onPress={onToggle}
        >
          {selected ? <Text style={styles.checkboxText as never}>✓</Text> : null}
        </Pressable>
        <Text style={styles.title as never} numberOfLines={1}>
          {row.title}
        </Text>
        <View style={styles.badge as never}>
          <Text style={styles.badgeText as never}>{row.status}</Text>
        </View>
        {row.archived ? (
          <View style={styles.badge as never}>
            <Text style={styles.badgeText as never}>archived</Text>
          </View>
        ) : null}
        {row.pid !== null ? (
          <View style={[styles.badge as never, { backgroundColor: statusColorFor(row.status) }]}>
            <Text style={[styles.badgeText as never, { color: "#000000" }]}>
              {row.processCommand || "proc"} #{row.pid} · {formatBytes(row.rssBytes ?? 0)}
            </Text>
          </View>
        ) : (
          <View style={styles.badge as never}>
            <Text style={styles.badgeText as never}>no process</Text>
          </View>
        )}
      </View>
      <Text style={styles.meta as never} numberOfLines={1}>
        {row.provider}
        {row.model ? ` / ${row.model}` : ""} · {row.workspaceName ?? row.workspaceId ?? "—"}
      </Text>
      <Text style={styles.meta as never} numberOfLines={1}>
        {row.shortId} · {row.cwd} · {formatTime(row.updatedAt)}
        {row.pid !== null && row.isDaemonChild === false ? " · pid is not a daemon child" : ""}
      </Text>
      <View style={styles.actions as never}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || row.pid === null}
          style={[
            styles.action as never,
            styles.actionPrimary as never,
            busy || row.pid === null ? (styles.chipDisabled as never) : null,
          ]}
          onPress={onRelease}
        >
          <Text style={styles.actionTextOn as never}>Release</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || row.archived}
          style={[styles.action as never, busy || row.archived ? (styles.chipDisabled as never) : null]}
          onPress={onArchive}
        >
          <Text style={styles.actionText as never}>Archive</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          style={[styles.action as never, styles.actionDanger as never, busy ? (styles.chipDisabled as never) : null]}
          onPress={onDelete}
        >
          <Text style={styles.actionTextOn as never}>Delete</Text>
        </Pressable>
        {onOpen ? (
          <Pressable accessibilityRole="button" style={styles.action as never} onPress={onOpen}>
            <Text style={styles.actionText as never}>Open</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

function summarize(
  label: string,
  freed: string | null,
  failed: Array<{ agentId: string; error: string }>,
): string {
  const head = freed ? `${label} · ${freed} freed` : label;
  if (failed.length === 0) {
    return `${head}.`;
  }
  return `${head}, ${failed.length} failed: ${failed[0]?.error ?? ""}`;
}

function statusColorFor(status: string): string {
  switch (status) {
    case "running":
      return "#7dd3a0";
    case "idle":
      return "#e6c76a";
    case "error":
      return "#e08b8b";
    default:
      return "#9aa0a6";
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 MB";
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${mb.toFixed(1)} MB`;
}

function formatLoadedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "—";
  }
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

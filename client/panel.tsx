import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { getPaseoClient, useHosts, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
  autoReleaseSetRpc,
  autoReleaseStateRpc,
  overviewRpc,
  releaseManyRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
} from "../shared/contracts";
import {
  JobLine,
  activeAtPath,
  isLastActiveAtPath,
  pathGroups,
  reopenCandidate,
  useWorkspaceJobs,
  useWorkspaces,
  workspaceLabel,
  workspaceStats,
} from "./workspaces";

const EMPTY_HOSTS: readonly { serverId: string; label: string; status: string }[] = [];

interface HostSummary {
  serverId: string;
  label: string;
  total: number | null;
  running: number | null;
  archived: number | null;
  error: string | null;
}

export function AgentManagerPanel({ theme, host, layout }: PluginSurfaceProps) {
  const queryClient = useQueryClient();
  const fetchOverview = useRpc(overviewRpc);
  const releaseMany = useRpc(releaseManyRpc);
  const archiveWorkspace = useRpc(workspaceArchiveRpc);
  const closeWorkspaceTabs = useRpc(workspaceCloseTabsRpc);
  const deleteWorkspace = useRpc(workspaceDeleteRpc);
  const readAutoRelease = useRpc(autoReleaseStateRpc);
  const writeAutoRelease = useRpc(autoReleaseSetRpc);

  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaces = useWorkspaces(host.id);
  const jobs = useWorkspaceJobs(host.id);

  const autoRelease = useQuery({
    queryKey: ["agent-manager", "auto-release", host.id],
    queryFn: () => readAutoRelease({}),
    refetchInterval: 60000,
  });

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
            total: agents.length,
            running: agents.filter((agent) => agent.status === "running").length,
            archived: agents.filter((agent) => Boolean(agent.archivedAt)).length,
            error: null,
          });
        } catch (error) {
          summaries.push({ ...entry, total: null, running: null, archived: null, error: message(error) });
        }
      }
      return summaries;
    },
  });

  const refreshAll = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent-manager"] });
  }, [queryClient]);

  const coolDown = useCallback(() => {
    setCooling(true);
    if (cooldownTimer.current) {
      clearTimeout(cooldownTimer.current);
    }
    cooldownTimer.current = setTimeout(() => setCooling(false), 1200);
  }, []);

  useEffect(
    () => () => {
      if (cooldownTimer.current) {
        clearTimeout(cooldownTimer.current);
      }
    },
    [],
  );

  const jobId = jobs.job?.jobId ?? null;
  const jobFinished = jobs.job?.finished === true;

  useEffect(() => {
    if (jobFinished) {
      coolDown();
    }
  }, [jobId, jobFinished, coolDown]);

  const agentsOf = useCallback(
    (workspaceId: string) => (overview.data?.agents ?? []).filter((row) => row.workspaceId === workspaceId),
    [overview.data?.agents],
  );

  const releaseWorkspace = useMutation({
    mutationFn: async (workspaceId: string) => {
      const agentIds = agentsOf(workspaceId)
        .filter((row) => row.pid !== null)
        .map((row) => row.id);
      return releaseMany({ agentIds, allowSignalFallback: true });
    },
    onSuccess: async (result) => {
      setFeedback(summarize(`Released ${result.released.length}`, formatBytes(result.freedBytes), result.failed));
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const releaseIdle = useMutation({
    mutationFn: () => {
      const agentIds = idleAgents.map((row) => row.id);
      return releaseMany({ agentIds, allowSignalFallback: true });
    },
    onSuccess: async (result) => {
      setFeedback(summarize(`Released ${result.released.length}`, formatBytes(result.freedBytes), result.failed));
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const toggleAutoRelease = useMutation({
    mutationFn: (input: { enabled?: boolean; runNow?: boolean }) => writeAutoRelease(input),
    onSuccess: async (state) => {
      setFeedback(
        state.enabled
          ? `Auto-release is on · every ${state.intervalMinutes} min · idle over ${state.idleMinutes} min`
          : "Auto-release is off",
      );
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const archiveWorkspaceMutation = useMutation({
    mutationFn: (input: { workspaceId: string; confirmLastActive: boolean }) => archiveWorkspace(input),
    onSuccess: async (result) => {
      setPendingArchive(null);
      setFeedback(result.refused ? `Blocked: ${result.message}` : result.ok ? result.message : `Failed: ${result.message}`);
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const closeTabsMutation = useMutation({
    mutationFn: (workspaceId: string) => closeWorkspaceTabs({ workspaceId }),
    onSuccess: async (result) => {
      setFeedback(result.message);
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const deleteWorkspaceMutation = useMutation({
    mutationFn: (workspaceId: string) => deleteWorkspace({ workspaceId }),
    onSuccess: async (result) => {
      setPendingWorkspaceDelete(null);
      setFeedback(result.ok ? result.message : `Failed: ${result.message}`);
      coolDown();
      await refreshAll();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const busy =
    releaseWorkspace.isPending ||
    releaseIdle.isPending ||
    toggleAutoRelease.isPending ||
    archiveWorkspaceMutation.isPending ||
    closeTabsMutation.isPending ||
    deleteWorkspaceMutation.isPending ||
    jobs.busy ||
    cooling;

  const workspaceRows = workspaces.data?.workspaces ?? [];
  const activeWorkspaces = useMemo(() => workspaceRows.filter((row) => !row.archivedAt), [workspaceRows]);
  const archivedWorkspaces = useMemo(() => workspaceRows.filter((row) => row.archivedAt), [workspaceRows]);
  const idleAgents = useMemo(
    () => (overview.data?.agents ?? []).filter((row) => row.pid !== null && row.status !== "running"),
    [overview.data?.agents],
  );
  const sharedPaths = useMemo(() => pathGroups(workspaceRows), [workspaceRows]);
  const autoState = autoRelease.data;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0, padding: layout.compact ? 12 : 20 },
      summary: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
      dim: { color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 4 },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 12, marginBottom: 12 },
      sectionTitle: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const, marginTop: 16 },
      wsRow: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: 10,
        gap: 6,
      },
      wsHeaderRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      wsTitle: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const, flexShrink: 1 },
      badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: theme.colors.surface2 },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 11 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, gap: 8, marginTop: 4, flexWrap: "wrap" as const },
      action: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.surface2 },
      actionPrimary: { backgroundColor: theme.colors.accent },
      actionDanger: { backgroundColor: theme.colors.statusDanger },
      actionText: { color: theme.colors.foreground, fontSize: 12 },
      actionTextOn: { color: theme.colors.accentForeground, fontSize: 12 },
      disabled: { opacity: 0.4 },
      wsConfirm: {
        borderWidth: 1,
        borderColor: theme.colors.statusDanger,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        marginTop: 4,
      },
      confirmText: { color: theme.colors.foreground, fontSize: 13 },
      empty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 20 },
      hostRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, paddingVertical: 6 },
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

  if (workspaces.isLoading && !workspaces.data) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (workspaces.isError && !workspaces.data) {
    return (
      <View style={styles.screen}>
        <Text style={styles.empty}>Failed to read workspaces: {message(workspaces.error)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.summary}>
        {workspaceRows.length} workspaces · {activeWorkspaces.length} active · {archivedWorkspaces.length} archived
      </Text>
      <Text style={styles.dim}>
        {overview.data?.totals.total ?? 0} sessions · {overview.data?.totals.holdingProcess ?? 0} holding a process ·{" "}
        {formatBytes(overview.data?.totals.rssBytes ?? 0)}
      </Text>

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idleAgents.length === 0}
          style={[styles.action, styles.actionPrimary, busy || idleAgents.length === 0 ? styles.disabled : null]}
          onPress={() => {
            setFeedback(null);
            releaseIdle.mutate();
          }}
        >
          <Text style={styles.actionTextOn}>Release idle everywhere ({idleAgents.length})</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.action} onPress={() => void refreshAll()}>
          <Text style={styles.actionText}>{workspaces.isFetching || overview.isFetching ? "Refreshing…" : "Refresh"}</Text>
        </Pressable>
      </View>

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !autoState}
          style={[
            styles.action,
            autoState?.enabled ? styles.actionPrimary : null,
            busy || !autoState ? styles.disabled : null,
          ]}
          onPress={() => toggleAutoRelease.mutate({ enabled: !autoState?.enabled })}
        >
          <Text style={autoState?.enabled ? styles.actionTextOn : styles.actionText}>
            Auto-release idle tabs: {autoState?.enabled ? "On" : "Off"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy || !autoState}
          style={[styles.action, busy || !autoState ? styles.disabled : null]}
          onPress={() => {
            setFeedback(null);
            toggleAutoRelease.mutate({ runNow: true });
          }}
        >
          <Text style={styles.actionText}>Check now</Text>
        </Pressable>
      </View>

      <Text style={styles.meta}>
        Auto-release checks every {autoState?.intervalMinutes ?? 10} min and releases idle tabs over{" "}
        {autoState?.idleMinutes ?? 10} min
        {autoState?.lastRunAt ? ` · last ${formatTime(autoState.lastRunAt)}` : " · not run yet"}
        {autoState && autoState.lastReleased.length > 0 ? ` · released ${autoState.lastReleased.length}` : ""}
        {autoState?.lastSkipped ? ` · ${autoState.lastSkipped} skipped` : ""}
        {autoState?.lastError ? ` · ${autoState.lastError}` : ""}
      </Text>

      {sharedPaths.map((group) => (
        <Text key={group.key} style={styles.warning}>
          {group.rows.length} active workspaces share {group.cwd} — new sessions can land in either.
        </Text>
      ))}

      <ScrollView>
        {workspaceRows.map((row) => {
          const stats = workspaceStats(overview.data?.agents, row.workspaceId);
          const archived = Boolean(row.archivedAt);
          const label = workspaceLabel(row);
          const lastActive = !archived && isLastActiveAtPath(workspaceRows, row);
          const candidate = lastActive ? reopenCandidate(workspaceRows, row) : null;
          const alsoActive = archived
            ? []
            : activeAtPath(workspaceRows, row).filter((entry) => entry.workspaceId !== row.workspaceId);
          return (
            <View key={row.workspaceId} style={styles.wsRow}>
              <View style={styles.wsHeaderRow}>
                <Text style={styles.wsTitle} numberOfLines={1}>
                  {label}
                </Text>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{archived ? "archived" : "active"}</Text>
                </View>
                {stats.holding > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>
                      {stats.holding} holding · {formatBytes(stats.rssBytes)}
                    </Text>
                  </View>
                ) : null}
                {!archived && alsoActive.length > 0 ? (
                  <View style={styles.badge}>
                    <Text style={styles.badgeText}>+{alsoActive.length} active here</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.meta} numberOfLines={1}>
                {row.cwd} · {stats.total} sessions · {stats.running} running
                {row.kind === "directory" ? "" : ` · ${row.kind}`}
                {row.projectName ? ` · ${row.projectName}` : ""}
                {row.archivedAt ? ` · archived ${formatTime(row.archivedAt)}` : ""}
              </Text>

              {archived ? (
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    style={[styles.action, styles.actionPrimary, busy ? styles.disabled : null]}
                    onPress={() => {
                      setFeedback(null);
                      jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, release: true });
                    }}
                  >
                    <Text style={styles.actionTextOn}>Activate</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    style={[styles.action, styles.actionDanger, busy ? styles.disabled : null]}
                    onPress={() => {
                      setPendingArchive(null);
                      setPendingWorkspaceDelete(row.workspaceId);
                    }}
                  >
                    <Text style={styles.actionTextOn}>Delete</Text>
                  </Pressable>
                </View>
              ) : (
                <View style={styles.actions}>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || stats.archived === 0}
                    style={[styles.action, busy || stats.archived === 0 ? styles.disabled : null]}
                    onPress={() => {
                      setFeedback(null);
                      jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, release: true, tabsOnly: true });
                    }}
                  >
                    <Text style={styles.actionText}>Reopen tabs ({stats.archived})</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || stats.holding === 0}
                    style={[styles.action, styles.actionPrimary, busy || stats.holding === 0 ? styles.disabled : null]}
                    onPress={() => {
                      setFeedback(null);
                      releaseWorkspace.mutate(row.workspaceId);
                    }}
                  >
                    <Text style={styles.actionTextOn}>Release workspace ({stats.holding})</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy || stats.open === 0}
                    style={[styles.action, busy || stats.open === 0 ? styles.disabled : null]}
                    onPress={() => {
                      setFeedback(null);
                      closeTabsMutation.mutate(row.workspaceId);
                    }}
                  >
                    <Text style={styles.actionText}>Close tabs ({stats.open})</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    style={[styles.action, busy ? styles.disabled : null]}
                    onPress={() => {
                      setPendingWorkspaceDelete(null);
                      setPendingArchive(row.workspaceId);
                    }}
                  >
                    <Text style={styles.actionText}>Archive</Text>
                  </Pressable>
                </View>
              )}

              {pendingArchive === row.workspaceId ? (
                <View style={styles.wsConfirm}>
                  <Text style={styles.confirmText}>
                    Archive "{label}"? {stats.total} session(s) stop now
                    {stats.running > 0 ? ` (${stats.running} running)` : ""}.
                  </Text>
                  {lastActive ? (
                    <Text style={styles.confirmText}>
                      Only active workspace at this path — Paseo reopens "
                      {candidate ? workspaceLabel(candidate) : "an archived one"}" here next time.
                    </Text>
                  ) : null}
                  <Text style={styles.meta}>Close tabs frees the same memory without archiving.</Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      style={[styles.action, styles.actionDanger, busy ? styles.disabled : null]}
                      onPress={() =>
                        archiveWorkspaceMutation.mutate({ workspaceId: row.workspaceId, confirmLastActive: true })
                      }
                    >
                      <Text style={styles.actionTextOn}>Confirm archive</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" style={styles.action} onPress={() => setPendingArchive(null)}>
                      <Text style={styles.actionText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}

              {pendingWorkspaceDelete === row.workspaceId ? (
                <View style={styles.wsConfirm}>
                  <Text style={styles.confirmText}>
                    Delete "{label}" permanently? {stats.total} session(s) and their history are removed.
                  </Text>
                  <View style={styles.actions}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={busy}
                      style={[styles.action, styles.actionDanger, busy ? styles.disabled : null]}
                      onPress={() => deleteWorkspaceMutation.mutate(row.workspaceId)}
                    >
                      <Text style={styles.actionTextOn}>Confirm delete</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      style={styles.action}
                      onPress={() => setPendingWorkspaceDelete(null)}
                    >
                      <Text style={styles.actionText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
        {workspaceRows.length === 0 ? <Text style={styles.empty}>No workspace on this host.</Text> : null}
      </ScrollView>

      <JobLine job={jobs.job} error={jobs.error} busy={jobs.busy} theme={theme} />

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
        </View>
      ) : null}

      {overview.data?.warning ? <Text style={styles.warning}>{overview.data.warning}</Text> : null}
      {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
    </View>
  );
}

interface RawListedAgent {
  status?: string;
  archivedAt?: string | null;
}

function summarize(label: string, freed: string | null, failed: Array<{ agentId: string; error: string }>): string {
  const head = freed ? `${label} · ${freed} freed` : label;
  if (failed.length === 0) {
    return head;
  }
  return `${head} · ${failed.length} failed: ${failed[0]?.error ?? ""}`;
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

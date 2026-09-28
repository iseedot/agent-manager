import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
  autoReleaseSetRpc,
  autoReleaseStateRpc,
  overviewRpc,
  releaseManyRpc,
  systemRpc,
  terminalsCloseRpc,
  terminalsRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  type SystemStats,
  type WorkspaceRow,
} from "../shared/contracts";
import { formatBytes, formatMegabytes, formatTime, message } from "./format";
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

const READ_ONCE = { staleTime: 30000, refetchOnWindowFocus: false } as const;

export function AgentManagerPanel({ theme, host, layout }: PluginSurfaceProps) {
  const compact = layout.compact;
  const queryClient = useQueryClient();
  const fetchOverview = useRpc(overviewRpc);
  const releaseMany = useRpc(releaseManyRpc);
  const archiveWorkspace = useRpc(workspaceArchiveRpc);
  const closeWorkspaceTabs = useRpc(workspaceCloseTabsRpc);
  const deleteWorkspace = useRpc(workspaceDeleteRpc);
  const fetchSystem = useRpc(systemRpc);
  const fetchTerminals = useRpc(terminalsRpc);
  const closeWorkspaceTerminals = useRpc(terminalsCloseRpc);
  const readAutoRelease = useRpc(autoReleaseStateRpc);
  const writeAutoRelease = useRpc(autoReleaseSetRpc);

  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<string | null>(null);
  const [pendingTerminals, setPendingTerminals] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const workspaces = useWorkspaces(host.id);
  const jobs = useWorkspaceJobs(host.id);

  const overview = useQuery({
    queryKey: ["agent-manager", "overview", host.id],
    queryFn: () => fetchOverview({}),
    ...READ_ONCE,
  });

  const terminals = useQuery({
    queryKey: ["agent-manager", "terminals", host.id],
    queryFn: () => fetchTerminals({}),
    ...READ_ONCE,
  });

  const system = useQuery({
    queryKey: ["agent-manager", "system", host.id],
    queryFn: () => fetchSystem({}),
    ...READ_ONCE,
  });

  const autoRelease = useQuery({
    queryKey: ["agent-manager", "auto-release", host.id],
    queryFn: () => readAutoRelease({}),
    ...READ_ONCE,
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

  const idleAgents = useMemo(
    () => (overview.data?.agents ?? []).filter((row) => row.pid !== null && row.status !== "running"),
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
    mutationFn: () => releaseMany({ agentIds: idleAgents.map((row) => row.id), allowSignalFallback: true }),
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
          ? `Auto-release on · every ${state.intervalMinutes} min · idle over ${state.idleMinutes} min`
          : "Auto-release off",
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

  const closeTerminalsMutation = useMutation({
    mutationFn: (workspaceId: string) => closeWorkspaceTerminals({ workspaceId }),
    onSuccess: async (result) => {
      setPendingTerminals(null);
      setFeedback(
        result.failed.length > 0
          ? `Closed ${result.closed.length} terminal(s) · ${result.failed.length} failed`
          : `Closed ${result.closed.length} terminal(s)`,
      );
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
    closeTerminalsMutation.isPending ||
    deleteWorkspaceMutation.isPending ||
    jobs.busy ||
    cooling;

  const workspaceRows = workspaces.data?.workspaces ?? [];
  const activeWorkspaces = useMemo(() => workspaceRows.filter((row) => !row.archivedAt), [workspaceRows]);
  const archivedWorkspaces = useMemo(() => workspaceRows.filter((row) => row.archivedAt), [workspaceRows]);
  const sharedPaths = useMemo(() => pathGroups(workspaceRows), [workspaceRows]);
  const terminalsByWorkspace = useMemo(() => {
    const map = new Map<string, { count: number; busy: number; rssBytes: number }>();
    for (const row of terminals.data?.workspaces ?? []) {
      map.set(row.workspaceId, { count: row.count, busy: row.busy, rssBytes: row.rssBytes });
    }
    return map;
  }, [terminals.data?.workspaces]);
  const terminalTotals = useMemo(() => {
    let count = 0;
    let rssBytes = 0;
    for (const row of terminals.data?.workspaces ?? []) {
      count += row.count;
      rssBytes += row.rssBytes;
    }
    return { count, rssBytes };
  }, [terminals.data?.workspaces]);
  const autoState = autoRelease.data;

  const styles = useMemo(() => {
    const palette = theme.colors;
    return {
      screen: { flex: 1, backgroundColor: palette.surface0, padding: layout.compact ? 12 : 20 },
      headline: { color: palette.foreground, fontSize: 16, fontWeight: "600" as const },
      subline: { color: palette.foregroundMuted, fontSize: 12, marginTop: 3 },
      block: {
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 10,
        padding: 12,
        gap: 8,
        marginTop: 14,
        backgroundColor: palette.surface1,
      },
      blockHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      blockTitle: { color: palette.foreground, fontSize: 13, fontWeight: "600" as const, flexGrow: 1 },
      blockMeta: { color: palette.foregroundMuted, fontSize: 12, lineHeight: 17 },
      sectionTitle: {
        color: palette.foregroundMuted,
        fontSize: 12,
        fontWeight: "600" as const,
        marginTop: 18,
        marginBottom: 2,
      },
      wsRow: {
        borderTopWidth: 1,
        borderTopColor: palette.border,
        paddingVertical: 12,
        gap: 4,
      },
      wsHead: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        flexWrap: "wrap" as const,
        gap: 6,
      },
      wsName: { color: palette.foreground, fontSize: 14, fontWeight: "600" as const, flexShrink: 1, flexGrow: 1 },
      chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: palette.surface2 },
      chipText: { color: palette.foregroundMuted, fontSize: 11 },
      wsMeta: { color: palette.foregroundMuted, fontSize: 12 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, marginTop: 8 },
      button: {
        paddingHorizontal: 11,
        paddingVertical: 7,
        borderRadius: 7,
        backgroundColor: palette.surface2,
        borderWidth: 1,
        borderColor: palette.border,
      },
      buttonPrimary: { backgroundColor: palette.accent, borderColor: palette.accent },
      buttonDanger: { backgroundColor: palette.statusDanger, borderColor: palette.statusDanger },
      buttonLink: { backgroundColor: "transparent", borderColor: "transparent", paddingHorizontal: 6 },
      buttonFull: { flexBasis: "100%" as const, alignItems: "center" as const },
      buttonHalf: { flexBasis: "47%" as const, alignItems: "center" as const },
      buttonText: { color: palette.foreground, fontSize: 12 },
      buttonTextOn: { color: palette.accentForeground, fontSize: 12 },
      toggle: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface2,
      },
      toggleOn: { backgroundColor: palette.accent, borderColor: palette.accent },
      toggleText: { color: palette.foreground, fontSize: 12 },
      toggleTextOn: { color: palette.accentForeground, fontSize: 12 },
      disabled: { opacity: 0.45 },
      confirm: {
        borderWidth: 1,
        borderColor: palette.statusDanger,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        marginTop: 8,
      },
      confirmText: { color: palette.foreground, fontSize: 12, lineHeight: 17 },
      warning: { color: palette.statusWarning, fontSize: 12, marginTop: 10 },
      empty: { color: palette.foregroundMuted, fontSize: 13, paddingVertical: 20 },
      footer: {
        color: palette.foregroundMuted,
        fontSize: 12,
        marginTop: 14,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: palette.border,
      },
    };
  }, [theme, layout.compact]);

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

  const renderWorkspace = (row: WorkspaceRow, archived: boolean) => {
    const stats = workspaceStats(overview.data?.agents, row.workspaceId);
    const label = workspaceLabel(row);
    const lastActive = !archived && isLastActiveAtPath(workspaceRows, row);
    const candidate = lastActive ? reopenCandidate(workspaceRows, row) : null;
    const alsoActive = archived
      ? []
      : activeAtPath(workspaceRows, row).filter((entry) => entry.workspaceId !== row.workspaceId);
    const detail = [
      row.cwd,
      `${stats.total} sessions`,
      stats.running > 0 ? `${stats.running} running` : null,
      row.kind === "directory" ? null : row.kind,
      row.projectName,
      archived && row.archivedAt ? `archived ${formatTime(row.archivedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <View key={row.workspaceId} style={styles.wsRow}>
        <View style={styles.wsHead}>
          <Text style={styles.wsName} numberOfLines={1}>
            {label}
          </Text>
          {stats.holding > 0 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>
                {stats.holding} holding · {formatBytes(stats.rssBytes)}
              </Text>
            </View>
          ) : null}
          {alsoActive.length > 0 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>+{alsoActive.length} active here</Text>
            </View>
          ) : null}
          {(terminalsByWorkspace.get(row.workspaceId)?.count ?? 0) > 0 ? (
            <View style={styles.chip}>
              <Text style={styles.chipText}>
                {terminalsByWorkspace.get(row.workspaceId)?.count} terminal
                {(terminalsByWorkspace.get(row.workspaceId)?.count ?? 0) === 1 ? "" : "s"} ·{" "}
                {formatBytes(terminalsByWorkspace.get(row.workspaceId)?.rssBytes ?? 0)}
                {(terminalsByWorkspace.get(row.workspaceId)?.busy ?? 0) > 0
                  ? ` · ${terminalsByWorkspace.get(row.workspaceId)?.busy} busy`
                  : ""}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.wsMeta} numberOfLines={1}>
          {detail}
        </Text>

        {archived ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, styles.buttonPrimary, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, release: true });
              }}
            >
              <Text style={styles.buttonTextOn}>Activate</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, styles.buttonDanger, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
              onPress={() => {
                setPendingArchive(null);
                setPendingWorkspaceDelete(row.workspaceId);
              }}
            >
              <Text style={styles.buttonTextOn}>Delete</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy || stats.holding === 0}
              style={[styles.button, styles.buttonPrimary, busy || stats.holding === 0 ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                releaseWorkspace.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonTextOn}>Release workspace ({stats.holding})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || stats.archived === 0}
              style={[styles.button, compact ? styles.buttonFull : null, busy || stats.archived === 0 ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, release: true, tabsOnly: true });
              }}
            >
              <Text style={styles.buttonText}>Reopen tabs ({stats.archived})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || stats.open === 0}
              style={[styles.button, compact ? styles.buttonFull : null, busy || stats.open === 0 ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                closeTabsMutation.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>Close tabs ({stats.open})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || (terminalsByWorkspace.get(row.workspaceId)?.count ?? 0) === 0}
              style={[
                styles.button,
                compact ? styles.buttonFull : null,
                busy || (terminalsByWorkspace.get(row.workspaceId)?.count ?? 0) === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                const info = terminalsByWorkspace.get(row.workspaceId);
                if ((info?.busy ?? 0) > 0) {
                  setPendingTerminals(row.workspaceId);
                  return;
                }
                setFeedback(null);
                closeTerminalsMutation.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>
                Close terminals ({terminalsByWorkspace.get(row.workspaceId)?.count ?? 0})
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
              onPress={() => {
                setPendingWorkspaceDelete(null);
                setPendingArchive(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>Archive</Text>
            </Pressable>
          </View>
        )}

        {pendingArchive === row.workspaceId ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              {stats.total === 0
                ? lastActive
                  ? `Archive "${label}"? No sessions, and it is the only active workspace at this path, so it stays.`
                  : `Delete "${label}"? It has no sessions.`
                : `Archive "${label}"? ${stats.total} session(s) stop now${
                    stats.running > 0 ? ` (${stats.running} running)` : ""
                  }.`}
            </Text>
            {lastActive ? (
              <Text style={styles.confirmText}>
                Only active workspace at this path — Paseo reopens "
                {candidate ? workspaceLabel(candidate) : "an archived one"}" here next time.
              </Text>
            ) : null}
            {stats.total > 0 ? (
              <Text style={styles.wsMeta}>Close tabs frees the same memory without archiving.</Text>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={[styles.button, styles.buttonDanger, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
                onPress={() =>
                  archiveWorkspaceMutation.mutate({ workspaceId: row.workspaceId, confirmLastActive: true })
                }
              >
                <Text style={styles.buttonTextOn}>Confirm archive</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonFull : null]}
                onPress={() => setPendingArchive(null)}
              >
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {pendingTerminals === row.workspaceId ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              Close {terminalsByWorkspace.get(row.workspaceId)?.count ?? 0} terminal(s) in "{label}"?{" "}
              {terminalsByWorkspace.get(row.workspaceId)?.busy ?? 0} are running a command — it stops.
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={[styles.button, styles.buttonDanger, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
                onPress={() => closeTerminalsMutation.mutate(row.workspaceId)}
              >
                <Text style={styles.buttonTextOn}>Confirm close</Text>
              </Pressable>
              <Pressable accessibilityRole="button" style={styles.button} onPress={() => setPendingTerminals(null)}>
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}

        {pendingWorkspaceDelete === row.workspaceId ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              Delete "{label}" permanently? {stats.total} session(s) and their history are removed.
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={[styles.button, styles.buttonDanger, compact ? styles.buttonFull : null, busy ? styles.disabled : null]}
                onPress={() => deleteWorkspaceMutation.mutate(row.workspaceId)}
              >
                <Text style={styles.buttonTextOn}>Confirm delete</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonFull : null]}
                onPress={() => setPendingWorkspaceDelete(null)}
              >
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.headline} numberOfLines={compact ? 2 : 1}>
        {workspaceRows.length} workspaces · {activeWorkspaces.length} active · {archivedWorkspaces.length} archived
      </Text>
      <Text style={styles.subline} numberOfLines={compact ? 2 : 1}>
        {host.label} · {overview.data?.totals.total ?? 0} sessions · {overview.data?.totals.holdingProcess ?? 0} holding a
        process · {formatBytes(overview.data?.totals.rssBytes ?? 0)}
      </Text>
      {renderSystemLine(system.data, styles, theme)}

      <View style={styles.block}>
        <View style={styles.blockHead}>
          <Text style={styles.blockTitle}>Memory</Text>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !autoState}
            style={[
              styles.toggle,
              autoState?.enabled ? styles.toggleOn : null,
              busy || !autoState ? styles.disabled : null,
            ]}
            onPress={() => toggleAutoRelease.mutate({ enabled: !autoState?.enabled })}
          >
            <Text style={autoState?.enabled ? styles.toggleTextOn : styles.toggleText}>
              Auto-release {autoState?.enabled ? "on" : "off"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !autoState}
            style={[
              styles.toggle,
              autoState?.removeEmptyWorkspaces ? styles.toggleOn : null,
              busy || !autoState ? styles.disabled : null,
            ]}
            onPress={() => toggleAutoRelease.mutate({ removeEmptyWorkspaces: !autoState?.removeEmptyWorkspaces })}
          >
            <Text style={autoState?.removeEmptyWorkspaces ? styles.toggleTextOn : styles.toggleText}>
              Empty workspaces {autoState?.removeEmptyWorkspaces ? "on" : "off"}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.blockMeta}>
          idle &gt; {autoState?.idleMinutes ?? 10} min
          {autoState?.lastRunAt ? ` · ${formatTime(autoState.lastRunAt)}` : ""}
          {autoState && autoState.lastReleased.length > 0 ? ` · released ${autoState.lastReleased.length}` : ""}
          {autoState && autoState.lastRemovedWorkspaces.length > 0
            ? ` · removed ${autoState.lastRemovedWorkspaces.length}`
            : ""}
          {autoState?.lastSkipped ? ` · skipped ${autoState.lastSkipped}` : ""}
          {terminalTotals.count > 0 ? ` · ${terminalTotals.count} terminals ${formatBytes(terminalTotals.rssBytes)}` : ""}
          {autoState?.lastError ? ` · ${autoState.lastError}` : ""}
        </Text>

        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            disabled={busy || idleAgents.length === 0}
            style={[
              styles.button,
              styles.buttonPrimary,
              compact ? styles.buttonFull : null,
              busy || idleAgents.length === 0 ? styles.disabled : null,
            ]}
            onPress={() => {
              setFeedback(null);
              releaseIdle.mutate();
            }}
          >
            <Text style={styles.buttonTextOn}>Release idle everywhere ({idleAgents.length})</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={busy || !autoState}
            style={[styles.button, compact ? styles.buttonHalf : null, busy || !autoState ? styles.disabled : null]}
            onPress={() => {
              setFeedback(null);
              toggleAutoRelease.mutate({ runNow: true });
            }}
          >
            <Text style={styles.buttonText}>Check now</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            style={[styles.button, compact ? styles.buttonHalf : null]}
            onPress={() => void refreshAll()}
          >
            <Text style={styles.buttonText}>
              {workspaces.isFetching || overview.isFetching ? "Refreshing…" : "Refresh"}
            </Text>
          </Pressable>
        </View>

        <JobLine job={jobs.job} error={jobs.error} busy={jobs.busy} theme={theme} />
      </View>

      {sharedPaths.map((group) => (
        <Text key={group.key} style={styles.warning}>
          {group.rows.length} active workspaces share {group.cwd} — new sessions can land in either.
        </Text>
      ))}

      <ScrollView>
        <Text style={styles.sectionTitle}>Active ({activeWorkspaces.length})</Text>
        {activeWorkspaces.map((row) => renderWorkspace(row, false))}
        {activeWorkspaces.length === 0 ? <Text style={styles.empty}>No active workspace.</Text> : null}

        <Text style={styles.sectionTitle}>Archived ({archivedWorkspaces.length})</Text>
        {archivedWorkspaces.map((row) => renderWorkspace(row, true))}
        {archivedWorkspaces.length === 0 ? <Text style={styles.empty}>No archived workspace.</Text> : null}
      </ScrollView>

      {overview.data?.warning ? <Text style={styles.warning}>{overview.data.warning}</Text> : null}
      {feedback ? <Text style={styles.footer}>{feedback}</Text> : null}
    </View>
  );
}

function renderSystemLine(
  stats: SystemStats | undefined,
  styles: Record<string, unknown>,
  theme: { colors: { foregroundMuted: string; statusWarning: string } },
) {
  if (!stats) {
    return null;
  }
  const parts: Array<{ text: string; warn: boolean }> = [];
  if (stats.load1 !== null) {
    parts.push({ text: `load ${stats.load1.toFixed(2)}`, warn: false });
  }
  if (stats.cpuPercent !== null) {
    parts.push({ text: `cpu ${stats.cpuPercent.toFixed(0)}%`, warn: stats.cpuPercent >= 80 });
  }
  if (stats.memTotalBytes !== null && stats.memUsedBytes !== null) {
    const percent = (stats.memUsedBytes / stats.memTotalBytes) * 100;
    parts.push({
      text: `mem ${formatMegabytes(stats.memUsedBytes)}/${formatMegabytes(stats.memTotalBytes)}`,
      warn: percent >= 90,
    });
  }
  if (stats.swapTotalBytes !== null && stats.swapTotalBytes > 0 && stats.swapUsedBytes !== null) {
    const percent = (stats.swapUsedBytes / stats.swapTotalBytes) * 100;
    parts.push({
      text: `swap ${formatMegabytes(stats.swapUsedBytes)}/${formatMegabytes(stats.swapTotalBytes)}`,
      warn: percent >= 50,
    });
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <Text style={styles.subline as never} numberOfLines={2}>
      {parts.map((part, index) => (
        <Text key={part.text} style={part.warn ? { color: theme.colors.statusWarning } : undefined}>
          {index === 0 ? part.text : ` · ${part.text}`}
        </Text>
      ))}
    </Text>
  );
}


function summarize(label: string, freed: string | null, failed: Array<{ agentId: string; error: string }>): string {
  const head = freed ? `${label} · ${freed} freed` : label;
  if (failed.length === 0) {
    return head;
  }
  return `${head} · ${failed.length} failed: ${failed[0]?.error ?? ""}`;
}



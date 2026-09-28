import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
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
  const autoState = autoRelease.data;

  const terminalsByWorkspace = useMemo(() => {
    const map = new Map<string, { count: number; busy: number; rssBytes: number }>();
    for (const row of terminals.data?.workspaces ?? []) {
      map.set(row.workspaceId, { count: row.count, busy: row.busy, rssBytes: row.rssBytes });
    }
    return map;
  }, [terminals.data?.workspaces]);

  const styles = useMemo(() => {
    const palette = theme.colors;
    return {
      screen: { flex: 1, backgroundColor: palette.surface0, padding: compact ? 14 : 20 },
      headline: { color: palette.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" as const },
      subline: { color: palette.foregroundMuted, fontSize: 12, marginTop: 3, lineHeight: 17 },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 14 },
      sectionLabel: {
        color: palette.foregroundMuted,
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.6,
        marginTop: 20,
        marginBottom: 4,
      },
      wsRow: {
        borderTopWidth: 1,
        borderTopColor: palette.border,
        paddingVertical: compact ? 12 : 10,
        gap: 3,
      },
      wsName: { color: palette.foreground, fontSize: 14, fontWeight: "600" as const },
      wsMeta: { color: palette.foregroundMuted, fontSize: 12, lineHeight: 17 },
      wsFacts: { color: palette.foreground, fontSize: 12, lineHeight: 17 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 8 },
      button: {
        minHeight: 34,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: palette.surface2,
        borderWidth: 1,
        borderColor: palette.border,
      },
      buttonPrimary: { backgroundColor: palette.accent, borderColor: palette.accent },
      buttonDanger: { backgroundColor: palette.statusDanger, borderColor: palette.statusDanger },
      buttonHalf: { flexBasis: "48%" as const, flexGrow: 1 },
      buttonText: { color: palette.foreground, fontSize: 12 },
      buttonTextOn: { color: palette.accentForeground, fontSize: 12 },
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
      warning: { color: palette.statusWarning, fontSize: 12, marginTop: 10, lineHeight: 17 },
      empty: { color: palette.foregroundMuted, fontSize: 13, paddingVertical: 20 },
      footer: {
        color: palette.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        marginTop: 12,
        paddingTop: 10,
        borderTopWidth: 1,
        borderTopColor: palette.border,
      },
      jobRow: { marginTop: 10 },
    };
  }, [theme, compact]);

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
    const terminalInfo = terminalsByWorkspace.get(row.workspaceId);
    const facts = [
      stats.holding > 0 ? `${stats.holding} holding · ${formatBytes(stats.rssBytes)}` : null,
      `${stats.total} sessions`,
      stats.running > 0 ? `${stats.running} running` : null,
      terminalInfo && terminalInfo.count > 0
        ? `${terminalInfo.count} terminal${terminalInfo.count === 1 ? "" : "s"} ${formatBytes(terminalInfo.rssBytes)}${
            terminalInfo.busy > 0 ? ` (${terminalInfo.busy} busy)` : ""
          }`
        : null,
      row.kind === "directory" ? null : row.kind,
      row.projectName,
      alsoActive.length > 0 ? `+${alsoActive.length} active here` : null,
      archived && row.archivedAt ? `archived ${formatTime(row.archivedAt)}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <View key={row.workspaceId} style={styles.wsRow}>
        <Text style={styles.wsName} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.wsMeta} numberOfLines={1}>
          {row.cwd}
        </Text>
        <Text style={styles.wsFacts} numberOfLines={2}>
          {facts}
        </Text>

        {archived ? (
          <View style={styles.actions}>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[
                styles.button,
                styles.buttonPrimary,
                compact ? styles.buttonHalf : null,
                busy ? styles.disabled : null,
              ]}
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
              style={[styles.button, styles.buttonDanger, compact ? styles.buttonHalf : null, busy ? styles.disabled : null]}
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
              style={[
                styles.button,
                styles.buttonPrimary,
                compact ? styles.buttonHalf : null,
                busy || stats.holding === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                releaseWorkspace.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonTextOn}>Release ({stats.holding})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || stats.archived === 0}
              style={[
                styles.button,
                compact ? styles.buttonHalf : null,
                busy || stats.archived === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, release: true, tabsOnly: true });
              }}
            >
              <Text style={styles.buttonText}>Reopen ({stats.archived})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || stats.open === 0}
              style={[
                styles.button,
                compact ? styles.buttonHalf : null,
                busy || stats.open === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                closeTabsMutation.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>Tabs ({stats.open})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || (terminalInfo?.count ?? 0) === 0}
              style={[
                styles.button,
                compact ? styles.buttonHalf : null,
                busy || (terminalInfo?.count ?? 0) === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                if ((terminalInfo?.busy ?? 0) > 0) {
                  setPendingTerminals(row.workspaceId);
                  return;
                }
                setFeedback(null);
                closeTerminalsMutation.mutate(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>Terminals ({terminalInfo?.count ?? 0})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, compact ? styles.buttonHalf : null, busy ? styles.disabled : null]}
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
                Only active workspace at this path — Paseo reopens "{candidate ? workspaceLabel(candidate) : "an archived one"}
                " here next time.
              </Text>
            ) : null}
            {stats.total > 0 ? (
              <Text style={styles.wsMeta}>Tabs closes them without archiving, which frees the same memory.</Text>
            ) : null}
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={[
                  styles.button,
                  styles.buttonDanger,
                  compact ? styles.buttonHalf : null,
                  busy ? styles.disabled : null,
                ]}
                onPress={() => archiveWorkspaceMutation.mutate({ workspaceId: row.workspaceId, confirmLastActive: true })}
              >
                <Text style={styles.buttonTextOn}>Confirm archive</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonHalf : null]}
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
              Close {terminalInfo?.count ?? 0} terminal(s) in "{label}"? {terminalInfo?.busy ?? 0} are running a command —
              it stops.
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                style={[
                  styles.button,
                  styles.buttonDanger,
                  compact ? styles.buttonHalf : null,
                  busy ? styles.disabled : null,
                ]}
                onPress={() => closeTerminalsMutation.mutate(row.workspaceId)}
              >
                <Text style={styles.buttonTextOn}>Confirm close</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonHalf : null]}
                onPress={() => setPendingTerminals(null)}
              >
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
                style={[
                  styles.button,
                  styles.buttonDanger,
                  compact ? styles.buttonHalf : null,
                  busy ? styles.disabled : null,
                ]}
                onPress={() => deleteWorkspaceMutation.mutate(row.workspaceId)}
              >
                <Text style={styles.buttonTextOn}>Confirm delete</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonHalf : null]}
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
      <Text style={styles.headline} numberOfLines={2}>
        {workspaceRows.length} workspaces · {activeWorkspaces.length} active · {archivedWorkspaces.length} archived
      </Text>
      <Text style={styles.subline} numberOfLines={2}>
        {host.label} · {overview.data?.totals.total ?? 0} sessions · {overview.data?.totals.holdingProcess ?? 0} holding ·{" "}
        {formatBytes(overview.data?.totals.rssBytes ?? 0)}
      </Text>
      {renderSystemLine(system.data, styles, theme)}

      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          disabled={busy || idleAgents.length === 0}
          style={[
            styles.button,
            styles.buttonPrimary,
            compact ? styles.buttonHalf : null,
            busy || idleAgents.length === 0 ? styles.disabled : null,
          ]}
          onPress={() => {
            setFeedback(null);
            releaseIdle.mutate();
          }}
        >
          <Text style={styles.buttonTextOn}>Release idle ({idleAgents.length})</Text>
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

      {sharedPaths.map((group) => (
        <Text key={group.key} style={styles.warning}>
          {group.rows.length} active workspaces share {group.cwd} — new sessions can land in either.
        </Text>
      ))}

      <ScrollView>
        <Text style={styles.sectionLabel}>ACTIVE · {activeWorkspaces.length}</Text>
        {activeWorkspaces.map((row) => renderWorkspace(row, false))}
        {activeWorkspaces.length === 0 ? <Text style={styles.empty}>No active workspace.</Text> : null}

        <Text style={styles.sectionLabel}>ARCHIVED · {archivedWorkspaces.length}</Text>
        {archivedWorkspaces.map((row) => renderWorkspace(row, true))}
        {archivedWorkspaces.length === 0 ? <Text style={styles.empty}>No archived workspace.</Text> : null}
      </ScrollView>

      <View style={styles.jobRow}>
        <JobLine job={jobs.job} error={jobs.error} busy={jobs.busy} theme={theme} />
      </View>

      {overview.data?.warning ? <Text style={styles.warning}>{overview.data.warning}</Text> : null}
      <Text style={styles.footer}>{autoReleaseLine(autoState)}</Text>
      {feedback ? <Text style={styles.footer}>{feedback}</Text> : null}
    </View>
  );
}

function autoReleaseLine(state: { enabled: boolean; idleMinutes: number; lastRunAt: string | null; lastReleased: unknown[] } | undefined): string {
  if (!state) {
    return "auto-release · reading state…";
  }
  if (!state.enabled) {
    return "auto-release off (panel control removed; edit ~/.paseo/agent-manager/auto-release.json to change)";
  }
  const released = state.lastReleased.length > 0 ? ` · released ${state.lastReleased.length}` : "";
  const last = state.lastRunAt ? ` · last ${formatTime(state.lastRunAt)}` : "";
  return `auto-release on · idle > ${state.idleMinutes} min${last}${released}`;
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

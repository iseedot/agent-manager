import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";

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
  workspaceRenameRpc,
  type AutoReleaseSnapshot,
  type SystemStats,
  type WorkspaceRow,
} from "../shared/contracts";
import { formatBytes, formatMegabytes, formatTime, message } from "./format";
import { buildTones } from "./palette";
import {
  JobLine,
  activeAtPath,
  isLastActiveAtPath,
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
  const fetchAutoRelease = useRpc(autoReleaseStateRpc);
  const setAutoRelease = useRpc(autoReleaseSetRpc);
  const fetchTerminals = useRpc(terminalsRpc);
  const closeWorkspaceTerminals = useRpc(terminalsCloseRpc);
  const renameWorkspace = useRpc(workspaceRenameRpc);

  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<string | null>(null);
  const [pendingTerminals, setPendingTerminals] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
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
    queryFn: () => fetchAutoRelease({}),
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

  const autoReleaseMutation = useMutation({
    mutationFn: (patch: {
      enabled?: boolean;
      idleMinutes?: number;
      intervalMinutes?: number;
      onLoad?: "allIdle" | "threshold" | "off";
      removeEmptyWorkspaces?: boolean;
      runNow?: boolean;
    }) => setAutoRelease(patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(["agent-manager", "auto-release", host.id], next);
      setFeedback(`Auto-release: idle ${next.idleMinutes}m · on load ${next.onLoad} · ${next.enabled ? "on" : "off"}`);
      coolDown();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const renameMutation = useMutation({
    mutationFn: (input: { workspaceId: string; title: string }) => renameWorkspace(input),
    onSuccess: async (result) => {
      setRenaming(null);
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
    renameMutation.isPending ||
    jobs.busy ||
    cooling;

  const workspaceRows = workspaces.data?.workspaces ?? [];
  const activeWorkspaces = useMemo(() => workspaceRows.filter((row) => !row.archivedAt), [workspaceRows]);
  const archivedWorkspaces = useMemo(() => workspaceRows.filter((row) => row.archivedAt), [workspaceRows]);

  const terminalsByWorkspace = useMemo(() => {
    const map = new Map<string, { count: number; busy: number; rssBytes: number }>();
    for (const row of terminals.data?.workspaces ?? []) {
      map.set(row.workspaceId, { count: row.count, busy: row.busy, rssBytes: row.rssBytes });
    }
    return map;
  }, [terminals.data?.workspaces]);

  const styles = useMemo(() => {
    const palette = theme.colors;
    const tones = buildTones({
      surface0: palette.surface0,
      accent: palette.accent,
      statusSuccess: palette.statusSuccess,
      statusWarning: palette.statusWarning,
      statusDanger: palette.statusDanger,
    });
    return {
      screen: { flex: 1, backgroundColor: palette.surface0, padding: compact ? 14 : 20 },
      headline: { color: palette.foreground, fontSize: compact ? 15 : 16, fontWeight: "600" as const },
      subline: { color: palette.foregroundMuted, fontSize: 12, flexShrink: 1, lineHeight: 17 },
      toolbar: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 14 },
      sectionRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        marginTop: 22,
        marginBottom: 8,
      },
      sectionLabel: {
        fontSize: 11,
        fontWeight: "600" as const,
        letterSpacing: 0.6,
      },
      sectionLabelActive: { color: tones.accent },
      sectionLabelArchived: { color: palette.foregroundMuted },
      sectionRule: { flex: 1, height: 1, backgroundColor: palette.border },
      wsCard: {
        position: "relative" as const,
        gap: 4,
        padding: compact ? 12 : 10,
        marginBottom: 10,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface1,
        overflow: "hidden" as const,
      },
      wsCardArchived: { backgroundColor: palette.surface0 },
      wsStripe: { position: "absolute" as const, left: 0, top: 0, bottom: 0, width: 3 },
      wsStripeActive: { backgroundColor: tones.accent },
      wsStripeArchived: { backgroundColor: palette.foregroundMuted, opacity: 0.45 },
      wsName: { color: palette.foreground, fontSize: 14, fontWeight: "600" as const },
      wsFacts: { color: palette.foregroundMuted, fontSize: 12, lineHeight: 17 },
      factAccent: { color: tones.accent, fontWeight: "600" as const },
      factOk: { color: tones.ok },
      factWarn: { color: tones.warn },
      hero: {
        borderRadius: 10,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface1,
        padding: compact ? 10 : 12,
        gap: 8,
      },
      heroTop: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      wsNameArchived: { color: palette.foregroundMuted },
      wsMeta: { color: palette.foregroundMuted, fontSize: 12, lineHeight: 17 },
      actions: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, marginTop: 8 },
      button: {
        minHeight: 34,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        paddingHorizontal: 12,
        borderRadius: 8,
        backgroundColor: "transparent",
        borderWidth: 1,
        borderColor: palette.border,
      },
      buttonPrimary: { backgroundColor: tones.accent, borderColor: tones.accent },
      buttonDanger: { backgroundColor: tones.danger, borderColor: tones.danger },
      buttonHalf: { flexBasis: "48%" as const, flexGrow: 1 },
      buttonText: { color: palette.foreground, fontSize: 12 },
      buttonTextOn: { color: tones.onAccent, fontSize: 12 },
      disabled: { opacity: 0.45 },
      confirm: {
        borderWidth: 1,
        borderColor: tones.danger,
        borderRadius: 10,
        backgroundColor: palette.surface2,
        padding: 10,
        gap: 8,
        marginTop: 8,
      },
      confirmText: { color: palette.foreground, fontSize: 12, lineHeight: 17 },
      autoPanel: {
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 10,
        backgroundColor: palette.surface1,
        padding: compact ? 10 : 12,
        gap: 10,
        marginBottom: 14,
      },
      autoRow: {
        flexDirection: compact ? ("column" as const) : ("row" as const),
        alignItems: compact ? ("stretch" as const) : ("center" as const),
        justifyContent: "space-between" as const,
        gap: compact ? 6 : 12,
      },
      autoLabel: { color: palette.foreground, fontSize: 12, flexShrink: 1 },
      autoDivider: { height: 1, backgroundColor: palette.border, opacity: 0.6 },
      autoStatus: { color: palette.foregroundMuted, fontSize: 11, lineHeight: 16 },
      autoStatusWarn: { color: tones.danger, fontSize: 11, lineHeight: 16 },
      segment: {
        flexDirection: "row" as const,
        alignSelf: compact ? ("stretch" as const) : ("auto" as const),
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        overflow: "hidden" as const,
      },
      segmentItem: {
        flexGrow: 1,
        minHeight: 30,
        paddingHorizontal: compact ? 6 : 12,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        borderLeftWidth: 1,
        borderLeftColor: palette.border,
      },
      segmentItemFirst: { borderLeftWidth: 0 },
      segmentItemActive: { backgroundColor: tones.accent },
      segmentText: { color: palette.foregroundMuted, fontSize: 12 },
      segmentTextActive: { color: tones.onAccent, fontSize: 12, fontWeight: "600" as const },
      chip: {
        minHeight: 30,
        paddingHorizontal: 12,
        justifyContent: "center" as const,
        alignItems: "center" as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface1,
      },
      chipOn: { backgroundColor: tones.accent, borderColor: tones.accent },
      chipText: { color: palette.foreground, fontSize: 12 },
      chipTextOn: { color: tones.onAccent, fontSize: 12, fontWeight: "600" as const },
      renamePanel: {
        borderWidth: 1,
        borderColor: tones.accent,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        marginTop: 8,
      },
      renameInput: {
        minHeight: 36,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface2,
        color: palette.foreground,
        paddingHorizontal: 10,
        fontSize: 13,
      },
      warning: { color: tones.warn, fontSize: 12, marginTop: 10, lineHeight: 17 },
      empty: { color: palette.foregroundMuted, fontSize: 13, paddingVertical: 20 },
      footer: {
        color: palette.foreground,
        fontSize: 11,
        lineHeight: 16,
        marginTop: 12,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.surface1,
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
    const isRenaming = renaming === row.workspaceId;
    const facts: Array<{ text: string; tone: "quiet" | "accent" | "ok" | "warn" }> = [];
    if (stats.holding > 0) {
      facts.push({ text: `${stats.holding} holding · ${formatBytes(stats.rssBytes)}`, tone: "accent" });
    }
    facts.push({ text: `${stats.total} session${stats.total === 1 ? "" : "s"}`, tone: "quiet" });
    if (stats.running > 0) {
      facts.push({ text: `${stats.running} running`, tone: "ok" });
    }
    if (terminalInfo && terminalInfo.count > 0) {
      facts.push({
        text: `${terminalInfo.count} terminal${terminalInfo.count === 1 ? "" : "s"} · ${formatBytes(terminalInfo.rssBytes)}`,
        tone: terminalInfo.busy > 0 ? "warn" : "quiet",
      });
    }
    if (row.kind !== "directory") {
      facts.push({ text: row.kind, tone: "quiet" });
    }
    facts.push({ text: row.projectName ?? "project removed", tone: "quiet" });
    if (alsoActive.length > 0) {
      facts.push({ text: `+${alsoActive.length} active here`, tone: "quiet" });
    }
    if (archived && row.archivedAt) {
      facts.push({ text: `archived ${formatTime(row.archivedAt)}`, tone: "quiet" });
    }

    return (
      <View key={row.workspaceId} style={[styles.wsCard, archived ? styles.wsCardArchived : null]}>
        <View style={[styles.wsStripe, archived ? styles.wsStripeArchived : styles.wsStripeActive]} />
        <Text style={[styles.wsName, archived ? styles.wsNameArchived : null]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.wsMeta} numberOfLines={1}>
          {row.cwd}
        </Text>
        <Text style={styles.wsFacts} numberOfLines={2}>
          {facts.map((fact, index) => (
            <Text key={fact.text} style={factStyles(fact.tone, styles)}>
              {index === 0 ? fact.text : ` · ${fact.text}`}
            </Text>
          ))}
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
                jobs.activate({ workspaceId: row.workspaceId, workspaceName: label });
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
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, compact ? styles.buttonHalf : null, busy ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                setPendingArchive(null);
                setRenaming(isRenaming ? null : row.workspaceId);
                setRenameValue(row.name ?? "");
              }}
            >
              <Text style={styles.buttonText}>Rename…</Text>
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
                jobs.activate({ workspaceId: row.workspaceId, workspaceName: label, tabsOnly: true });
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
                setFeedback(null);
                setRenaming(null);
                if (stats.total === 0) {
                  archiveWorkspaceMutation.mutate({ workspaceId: row.workspaceId, confirmLastActive: true });
                  return;
                }
                setPendingWorkspaceDelete(null);
                setPendingArchive(row.workspaceId);
              }}
            >
              <Text style={styles.buttonText}>Archive</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              style={[styles.button, compact ? styles.buttonHalf : null, busy ? styles.disabled : null]}
              onPress={() => {
                setFeedback(null);
                setPendingArchive(null);
                setRenaming(isRenaming ? null : row.workspaceId);
                setRenameValue(row.name ?? "");
              }}
            >
              <Text style={styles.buttonText}>Rename…</Text>
            </Pressable>
          </View>
        )}

        {pendingArchive === row.workspaceId ? (
          <View style={styles.confirm}>
            <Text style={styles.confirmText}>
              {stats.total === 0
                ? `Archive "${label}"? It has no sessions, so Paseo removes the workspace record.`
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
            <Text style={styles.wsMeta}>Tabs closes them without archiving, which frees the same memory.</Text>
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

        {isRenaming ? (
          <View style={styles.renamePanel}>
            <TextInput
              autoFocus
              value={renameValue}
              onChangeText={setRenameValue}
              onSubmitEditing={() =>
                renameMutation.mutate({ workspaceId: row.workspaceId, title: renameValue })
              }
              placeholder="Workspace name"
              placeholderTextColor={theme.colors.foregroundMuted}
              returnKeyType="done"
              style={styles.renameInput}
            />
            <Text style={styles.wsMeta}>
              Saved on the daemon, archived or not. Clear the field to fall back to the directory name.
            </Text>
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
                onPress={() => renameMutation.mutate({ workspaceId: row.workspaceId, title: renameValue })}
              >
                <Text style={styles.buttonTextOn}>Save name</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={[styles.button, compact ? styles.buttonHalf : null]}
                onPress={() => setRenaming(null)}
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
      <View style={styles.hero}>
        <Text style={styles.headline} numberOfLines={1}>
          {workspaceRows.length} workspace{workspaceRows.length === 1 ? "" : "s"} · {activeWorkspaces.length} active ·{" "}
          {archivedWorkspaces.length} archived
        </Text>
        <Text style={styles.subline} numberOfLines={2}>
          {host.label} · {overview.data?.totals.total ?? 0} sessions ·{" "}
          <Text
            style={(overview.data?.totals.holdingProcess ?? 0) > 0 ? styles.factAccent : undefined}
          >
            {overview.data?.totals.holdingProcess ?? 0} holding · {formatBytes(overview.data?.totals.rssBytes ?? 0)}
          </Text>
        </Text>
        <Text style={styles.subline} numberOfLines={2}>
          {systemParts(system.data).map((part, index) => (
            <Text key={part.text} style={part.warn ? styles.factWarn : undefined}>
              {index === 0 ? part.text : ` · ${part.text}`}
            </Text>
          ))}
        </Text>
      </View>

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

      <ScrollView>
        {renderAutoRelease(autoRelease.data, autoReleaseMutation, styles, compact)}
        <View style={styles.sectionRow}>
          <View style={[styles.dot, styles.dotAccent]} />
          <Text style={[styles.sectionLabel, styles.sectionLabelActive]}>ACTIVE · {activeWorkspaces.length}</Text>
          <View style={styles.sectionRule} />
        </View>
        {activeWorkspaces.map((row) => renderWorkspace(row, false))}
        {activeWorkspaces.length === 0 ? <Text style={styles.empty}>No active workspace.</Text> : null}

        <View style={styles.sectionRow}>
          <View style={[styles.dot, styles.dotMuted]} />
          <Text style={[styles.sectionLabel, styles.sectionLabelArchived]}>ARCHIVED · {archivedWorkspaces.length}</Text>
          <View style={styles.sectionRule} />
        </View>
        {archivedWorkspaces.map((row) => renderWorkspace(row, true))}
        {archivedWorkspaces.length === 0 ? <Text style={styles.empty}>No archived workspace.</Text> : null}
      </ScrollView>

      <View style={styles.jobRow}>
        <JobLine job={jobs.job} error={jobs.error} busy={jobs.busy} theme={theme} />
      </View>

      {overview.data?.warning ? <Text style={styles.warning}>{overview.data.warning}</Text> : null}
      {feedback ? <Text style={styles.footer}>{feedback}</Text> : null}
    </View>
  );
}

interface SystemPart {
  text: string;
  warn: boolean;
}

function systemParts(stats: SystemStats | undefined): SystemPart[] {
  if (!stats) {
    return [];
  }
  const parts: SystemPart[] = [];
  if (stats.load1 !== null) {
    parts.push({ text: `load ${stats.load1.toFixed(2)}`, warn: false });
  }
  if (stats.cpuPercent !== null) {
    parts.push({ text: `cpu ${stats.cpuPercent.toFixed(0)}%`, warn: stats.cpuPercent >= 80 });
  }
  if (stats.memTotalBytes !== null && stats.memUsedBytes !== null) {
    parts.push({
      text: `mem ${formatMegabytes(stats.memUsedBytes)}/${formatMegabytes(stats.memTotalBytes)}`,
      warn: stats.memUsedBytes / stats.memTotalBytes >= 0.9,
    });
  }
  if (stats.swapTotalBytes !== null && stats.swapTotalBytes > 0 && stats.swapUsedBytes !== null) {
    parts.push({
      text: `swap ${formatMegabytes(stats.swapUsedBytes)}/${formatMegabytes(stats.swapTotalBytes)}`,
      warn: stats.swapUsedBytes / stats.swapTotalBytes >= 0.5,
    });
  }
  return parts;
}

function factStyles(
  tone: "quiet" | "accent" | "ok" | "warn",
  styles: Record<string, any>,
): Record<string, unknown> | undefined {
  if (tone === "accent") return styles.factAccent;
  if (tone === "ok") return styles.factOk;
  if (tone === "warn") return styles.factWarn;
  return undefined;
}

const IDLE_PRESETS = [5, 10, 15, 30, 60];
const ON_LOAD_MODES: Array<{ id: AutoReleaseSnapshot["onLoad"]; label: string }> = [
  { id: "threshold", label: "Respect timer" },
  { id: "allIdle", label: "All idle" },
  { id: "off", label: "Do nothing" },
];

function renderAutoRelease(
  state: AutoReleaseSnapshot | undefined,
  mutation: { mutate: (patch: Record<string, unknown>) => void; isPending: boolean },
  styles: Record<string, any>,
  compact: boolean,
) {
  if (!state) {
    return null;
  }
  const pending = mutation.isPending;
  const set = (patch: Record<string, unknown>) => mutation.mutate(patch);

  const segmented = (
    key: string,
    options: readonly { id: string; label: string }[],
    value: string,
    onSelect: (id: string) => void,
  ) => (
    <View key={key} style={styles.segment}>
      {options.map((option, index) => {
        const active = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            disabled={pending}
            style={[
              styles.segmentItem,
              index === 0 ? styles.segmentItemFirst : null,
              active ? styles.segmentItemActive : null,
              pending ? styles.disabled : null,
            ]}
            onPress={() => onSelect(option.id)}
          >
            <Text style={active ? styles.segmentTextActive : styles.segmentText} numberOfLines={1}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <>
      <View style={styles.sectionRow}>
        <View
          style={[
            styles.dot,
            state.lastError ? styles.dotWarn : state.enabled ? styles.dotOk : styles.dotMuted,
          ]}
        />
        <Text style={[styles.sectionLabel, styles.sectionLabelActive]}>AUTO-RELEASE</Text>
        <View style={styles.sectionRule} />
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          style={[styles.chip, state.enabled ? styles.chipOn : null, pending ? styles.disabled : null]}
          onPress={() => set({ enabled: !state.enabled })}
        >
          <Text style={state.enabled ? styles.chipTextOn : styles.chipText}>
            {state.enabled ? "On" : "Off"}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={pending}
          style={[styles.chip, pending ? styles.disabled : null]}
          onPress={() => set({ runNow: true })}
        >
          <Text style={styles.chipText}>Run now</Text>
        </Pressable>
      </View>

      <View style={styles.autoPanel}>
        <View style={styles.autoRow}>
          <Text style={styles.autoLabel}>Release idle after</Text>
          {segmented(
            "idle",
            IDLE_PRESETS.map((minutes) => ({ id: `${minutes}`, label: `${minutes}m` })),
            `${state.idleMinutes}`,
            (id) => set({ idleMinutes: Number(id) }),
          )}
        </View>
        <View style={styles.autoDivider} />
        <View style={styles.autoRow}>
          <Text style={styles.autoLabel}>After a reload</Text>
          {segmented("load", ON_LOAD_MODES, state.onLoad, (id) => set({ onLoad: id }))}
        </View>
        <View style={styles.autoDivider} />
        <View style={styles.autoRow}>
          <Text style={styles.autoLabel}>Remove empty workspaces</Text>
          {segmented(
            "empty",
            [
              { id: "on", label: "On" },
              { id: "off", label: "Off" },
            ],
            state.removeEmptyWorkspaces ? "on" : "off",
            (id) => set({ removeEmptyWorkspaces: id === "on" }),
          )}
        </View>
        <Text style={state.lastError ? styles.autoStatusWarn : styles.autoStatus} numberOfLines={2}>
          {autoReleaseLine(state)}
        </Text>
      </View>
    </>
  );
}

function autoReleaseLine(state: AutoReleaseSnapshot): string {
  const parts = [
    state.lastRunAt ? `last sweep ${formatTime(state.lastRunAt)}` : "no sweep yet",
    `${state.lastReleased.length} released`,
    state.lastRemovedWorkspaces.length > 0 ? `${state.lastRemovedWorkspaces.length} empty workspace(s) removed` : null,
    state.lastSkipped > 0 ? `${state.lastSkipped} waiting on you` : null,
    state.nextRunAt ? `next ${formatCountdown(state.nextRunAt)}` : null,
    state.lastError ? `error: ${state.lastError}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ");
}

function formatCountdown(value: string): string {
  const target = Date.parse(value);
  if (!Number.isFinite(target)) {
    return "—";
  }
  const minutes = Math.round((target - Date.now()) / 60000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}

function summarize(label: string, freed: string | null, failed: Array<{ agentId: string; error: string }>): string {
  const head = freed ? `${label} · ${freed} freed` : label;
  if (failed.length === 0) {
    return head;
  }
  return `${head} · ${failed.length} failed: ${failed[0]?.error ?? ""}`;
}

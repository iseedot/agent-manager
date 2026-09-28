import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import {
  moveStatusRpc,
  overviewRpc,
  projectsRpc,
  releaseManyRpc,
  systemRpc,
  terminalsCloseRpc,
  terminalsRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  workspaceMoveRpc,
  type MoveStatus,
  type ProjectRow,
  type SystemStats,
  type WorkspaceRow,
} from "../shared/contracts";
import { formatBytes, formatMegabytes, formatTime, message } from "./format";
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
  const fetchTerminals = useRpc(terminalsRpc);
  const closeWorkspaceTerminals = useRpc(terminalsCloseRpc);
  const fetchProjects = useRpc(projectsRpc);
  const fetchMoveStatus = useRpc(moveStatusRpc);
  const moveWorkspace = useRpc(workspaceMoveRpc);

  const [pendingArchive, setPendingArchive] = useState<string | null>(null);
  const [pendingWorkspaceDelete, setPendingWorkspaceDelete] = useState<string | null>(null);
  const [pendingTerminals, setPendingTerminals] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [moveDirectory, setMoveDirectory] = useState(false);
  const [moveWatch, setMoveWatch] = useState(false);
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

  const projects = useQuery({
    queryKey: ["agent-manager", "projects", host.id],
    queryFn: () => fetchProjects({}),
    ...READ_ONCE,
  });

  const moveStatus = useQuery({
    queryKey: ["agent-manager", "move", host.id],
    queryFn: () => fetchMoveStatus({}),
    refetchInterval: moveWatch ? 2500 : false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!moveWatch) {
      return;
    }
    const timer = setTimeout(() => setMoveWatch(false), 120000);
    return () => clearTimeout(timer);
  }, [moveWatch]);

  const movePhase = moveStatus.data?.phase ?? "idle";

  useEffect(() => {
    if (moveWatch && (movePhase === "applied" || movePhase === "failed")) {
      setMoveWatch(false);
    }
  }, [moveWatch, movePhase]);

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

  const moveMutation = useMutation({
    mutationFn: (input: { workspaceId: string; projectId: string; moveDirectory: boolean }) =>
      moveWorkspace(input),
    onSuccess: async (result) => {
      if (!result.ok) {
        setFeedback(`Failed: ${result.message}`);
        return;
      }
      setPendingMove(null);
      setMoveTarget(null);
      setMoveDirectory(false);
      setFeedback(result.message);
      setMoveWatch(true);
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
    moveMutation.isPending ||
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
      movePanel: {
        borderWidth: 1,
        borderColor: palette.accent,
        borderRadius: 8,
        padding: 10,
        gap: 8,
        marginTop: 8,
      },
      moveTarget: {
        borderWidth: 1,
        borderColor: palette.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: palette.surface2,
        gap: 2,
      },
      moveTargetActive: { borderColor: palette.accent, backgroundColor: palette.surface1 },
      moveTargetName: { color: palette.foreground, fontSize: 13 },
      moveTargetNameActive: { color: palette.accent, fontSize: 13, fontWeight: "600" as const },
      moveTargetMeta: { color: palette.foregroundMuted, fontSize: 11 },
      moveTargetPath: { color: palette.foregroundMuted, fontSize: 11 },
      moveToggle: { paddingVertical: 2 },
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
    const moveCandidates = (projects.data?.projects ?? []).filter(
      (project) => project.projectId !== row.projectId && !project.archived,
    );
    const moving = pendingMove === row.workspaceId;
    const target = moveCandidates.find((project) => project.projectId === moveTarget) ?? null;
    const targetChangesDirectory =
      target !== null && target.rootPath.length > 0 && target.rootPath !== row.cwd;
    const runningSessions = (overview.data?.agents ?? []).filter((entry) => entry.status === "running").length;
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
      row.projectName ?? "project removed",
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
            <Pressable
              accessibilityRole="button"
              disabled={busy || moveCandidates.length === 0}
              style={[
                styles.button,
                compact ? styles.buttonHalf : null,
                busy || moveCandidates.length === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                setPendingMove(moving ? null : row.workspaceId);
                setMoveTarget(null);
                setMoveDirectory(false);
              }}
            >
              <Text style={styles.buttonText}>Move…</Text>
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
            <Pressable
              accessibilityRole="button"
              disabled={busy || moveCandidates.length === 0}
              style={[
                styles.button,
                compact ? styles.buttonHalf : null,
                busy || moveCandidates.length === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                setPendingMove(moving ? null : row.workspaceId);
                setMoveTarget(null);
                setMoveDirectory(false);
              }}
            >
              <Text style={styles.buttonText}>Move…</Text>
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

        {moving ? (
          <View style={styles.movePanel}>
            <Text style={styles.confirmText}>
              {moveCandidates.length === 0
                ? "No other active project exists. Create it in Paseo first, then move again."
                : `Move "${label}" out of ${row.projectName ?? row.projectId}:`}
            </Text>
            {moveCandidates.map((project: ProjectRow) => (
              <Pressable
                key={project.projectId}
                accessibilityRole="button"
                disabled={busy}
                style={[
                  styles.moveTarget,
                  moveTarget === project.projectId ? styles.moveTargetActive : null,
                  busy ? styles.disabled : null,
                ]}
                onPress={() => {
                  setMoveTarget(project.projectId);
                  setMoveDirectory(project.rootPath.length > 0 && project.rootPath !== row.cwd);
                }}
              >
                <Text
                  style={
                    moveTarget === project.projectId ? styles.moveTargetNameActive : styles.moveTargetName
                  }
                  numberOfLines={1}
                >
                  {project.name ?? project.rootPath}
                  <Text style={styles.moveTargetMeta}>{`  ${project.workspaceCount} workspace(s)`}</Text>
                </Text>
                <Text style={styles.moveTargetPath} numberOfLines={1}>
                  {project.rootPath}
                </Text>
              </Pressable>
            ))}
            {target ? (
              <>
                {targetChangesDirectory ? (
                  <Pressable
                    accessibilityRole="button"
                    disabled={busy}
                    style={styles.moveToggle}
                    onPress={() => setMoveDirectory((value) => !value)}
                  >
                    <Text style={styles.confirmText}>
                      {`${moveDirectory ? "[x]" : "[ ]"} also set the working directory to ${target.rootPath}`}
                    </Text>
                  </Pressable>
                ) : (
                  <Text style={styles.wsMeta}>
                    {target.rootPath === row.cwd
                      ? "That project root is already this workspace directory."
                      : "That project has no root directory, so the directory stays."}
                  </Text>
                )}
                <Text style={styles.warning}>
                  {`Paseo restarts to apply this. ${runningSessions} running session(s), ${stats.holding} holding process(es) and every terminal stop for about ten seconds. Session history is kept.`}
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
                    onPress={() =>
                      moveMutation.mutate({
                        workspaceId: row.workspaceId,
                        projectId: target.projectId,
                        moveDirectory,
                      })
                    }
                  >
                    <Text style={styles.buttonTextOn}>Confirm move</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    style={[styles.button, compact ? styles.buttonHalf : null]}
                    onPress={() => {
                      setPendingMove(null);
                      setMoveTarget(null);
                    }}
                  >
                    <Text style={styles.buttonText}>Cancel</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
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
      {feedback ? <Text style={styles.footer}>{feedback}</Text> : null}
      {movePhase !== "idle" && moveStatus.data ? (
        <Text style={styles.warning}>{`Move: ${moveText(moveStatus.data)}`}</Text>
      ) : null}
    </View>
  );
}

function moveText(status: MoveStatus): string {
  const from = status.workspaceName ?? status.workspaceId ?? "workspace";
  const to = status.toProjectName ?? status.toProjectId ?? "project";
  if (status.phase === "applied") {
    return status.message.length > 0 ? status.message : `Moved ${from} to ${to}.`;
  }
  if (status.phase === "failed") {
    return status.message.length > 0 ? status.message : `Move to ${to} failed.`;
  }
  return status.message.length > 0 ? status.message : `Moving ${from} to ${to}…`;
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

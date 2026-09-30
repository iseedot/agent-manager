import { usePaseo, useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";

import {
  agentDeleteRpc,
  agentRestoreRpc,
  autoReleaseSetRpc,
  releaseManyRpc,
  snapshotRpc,
  terminalCloseRpc,
  terminalsCloseRpc,
  workspaceArchiveRpc,
  workspaceCloseTabsRpc,
  workspaceDeleteRpc,
  workspaceRenameRpc,
  type AgentRow,
  type ProjectRow,
  type SystemStats,
  type WorkspaceRow,
} from "../shared/contracts";
import { ActionsPane, agentTitle, statusWord, type ActionsContext } from "./actions";
import { SettingsSection, settingsSummary, type AutoReleasePatch } from "./settings";
import { formatBytes, formatMegabytes, formatTime, message } from "./format";
import { buildStyles, type FactTone, type TerminalInfo } from "./styles";
import { TreePane, type TreeKind, type TreeRow } from "./tree";
import { JobLine, workspaceLabel, workspaceStats, useWorkspaceJobs } from "./workspaces";

const READ_ONCE = { staleTime: 30000, refetchOnWindowFocus: false } as const;

export function AgentManagerPanel({ theme, host, layout, navigation }: PluginSurfaceProps) {
  const compact = layout.compact;
  const queryClient = useQueryClient();
  const paseo = usePaseo();
  const fetchSnapshot = useRpc(snapshotRpc);
  const releaseMany = useRpc(releaseManyRpc);
  const archiveWorkspace = useRpc(workspaceArchiveRpc);
  const closeWorkspaceTabs = useRpc(workspaceCloseTabsRpc);
  const deleteWorkspace = useRpc(workspaceDeleteRpc);
  const setAutoRelease = useRpc(autoReleaseSetRpc);
  const closeWorkspaceTerminals = useRpc(terminalsCloseRpc);
  const closeOneTerminal = useRpc(terminalCloseRpc);
  const renameWorkspace = useRpc(workspaceRenameRpc);
  const removeAgents = useRpc(agentDeleteRpc);
  const restoreAgent = useRpc(agentRestoreRpc);

  const [selection, setSelection] = useState<TreeRow | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [expandedWorkspaces, setExpandedWorkspaces] = useState<Set<string>>(() => new Set());
  const [detailOpen, setDetailOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scope, setScope] = useState<"unarchived" | "all">("unarchived");
  const [feedback, setFeedback] = useState<string | null>(null);
  const [cooling, setCooling] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSelected = useRef(false);

  const workspaces = useQuery({
    queryKey: ["agent-manager", "snapshot", host.id],
    queryFn: () => fetchSnapshot({}),
    ...READ_ONCE,
  });

  const jobs = useWorkspaceJobs(host.id);

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

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["agent-manager"] });
  }, [queryClient]);

  const report = useCallback((text: string | null) => setFeedback(text), []);

  const release = useAction(
    (agentIds: string[]) => releaseMany({ agentIds, allowSignalFallback: true }),
    (result) => summarize(`Released ${result.released.length}`, formatBytes(result.freedBytes), result.failed),
    [releaseMany],
    { refresh, coolDown, report },
  );

  const archiveWorkspaceAction = useAction(
    (workspaceId: string) => archiveWorkspace({ workspaceId, confirmLastActive: true }),
    (result) => (result.refused ? `Blocked: ${result.message}` : result.ok ? result.message : `Failed: ${result.message}`),
    [archiveWorkspace],
    { refresh, coolDown, report },
  );

  const closeTabs = useAction(
    (workspaceId: string) => closeWorkspaceTabs({ workspaceId }),
    (result) => result.message,
    [closeWorkspaceTabs],
    { refresh, coolDown, report },
  );

  const closeOneTerminalAction = useAction(
    (terminalIds: string[]) => closeOneTerminal({ terminalIds }),
    (result) =>
      result.failed.length > 0
        ? `Closed ${result.closed.length} terminal(s) · ${result.failed.length} failed`
        : `Closed ${result.closed.length} terminal(s)`,
    [closeOneTerminal],
    { refresh, coolDown, report },
  );

  const closeTerminals = useAction(
    (workspaceId: string) => closeWorkspaceTerminals({ workspaceId }),
    (result) =>
      result.failed.length > 0
        ? `Closed ${result.closed.length} terminal(s) · ${result.failed.length} failed`
        : `Closed ${result.closed.length} terminal(s)`,
    [closeWorkspaceTerminals],
    { refresh, coolDown, report },
  );

  const deleteWorkspaceAction = useAction(
    (workspaceId: string) => deleteWorkspace({ workspaceId }),
    (result) => (result.ok ? result.message : `Failed: ${result.message}`),
    [deleteWorkspace],
    {
      refresh,
      coolDown,
      report,
      after: (result, workspaceId) => {
        if (result.ok) {
          setSelection((current) => (current && current.id === workspaceId ? null : current));
        }
      },
    },
  );

  const rename = useAction(
    (input: { workspaceId: string; title: string }) => renameWorkspace(input),
    (result) => (result.ok ? result.message : `Failed: ${result.message}`),
    [renameWorkspace],
    { refresh, coolDown, report },
  );

  const archiveAgents = useAction(
    async (agentIds: string[]) => {
      for (const agentId of agentIds) {
        await paseo.agents.ref(agentId).archive();
      }
      return agentIds;
    },
    (agentIds) => `Archived ${agentIds.length} session(s).`,
    [paseo],
    { refresh, coolDown, report },
  );

  const restoreSession = useAction(
    (agentId: string) => restoreAgent({ agentId }),
    (result) => (result.ok ? result.message : `Failed: ${result.message}`),
    [restoreAgent],
    { refresh, coolDown, report },
  );

  const deleteAgentsAction = useAction(
    (agentIds: string[]) => removeAgents({ agentIds }),
    (result) => result.message,
    [removeAgents],
    {
      refresh,
      coolDown,
      report,
      after: (result) => {
        setSelection((current) => (current && result.deleted.includes(current.id) ? null : current));
      },
    },
  );

  const autoReleaseSave = useMutation({
    mutationFn: (patch: AutoReleasePatch) => setAutoRelease(patch),
    onSuccess: async (next) => {
      queryClient.setQueryData(
        ["agent-manager", "snapshot", host.id],
        (current: { autoRelease?: unknown } | undefined) => (current ? { ...current, autoRelease: next } : current),
      );
      setFeedback(`Auto-release: idle ${next.idleMinutes}m · on load ${next.onLoad} · ${next.enabled ? "on" : "off"}`);
      coolDown();
    },
    onError: (error) => setFeedback(`Failed: ${message(error)}`),
  });

  const terminalsByWorkspace = useMemo(() => {
    const map = new Map<string, TerminalInfo>();
    for (const row of workspaces.data?.terminals ?? []) {
      map.set(row.workspaceId, {
        count: row.count,
        busy: row.busy,
        working: row.working,
        idle: row.idle,
        rssBytes: row.rssBytes,
      });
    }
    return map;
  }, [workspaces.data?.terminals]);

  const workspaceRows = workspaces.data?.workspaces ?? [];
  const projectRows = workspaces.data?.projects ?? [];
  const systemStats = workspaces.data?.system;
  const autoRelease = workspaces.data?.autoRelease;

  const recordRows = workspaces.data?.overview.agents ?? [];
  const visibleAgents = useMemo(
    () => (scope === "unarchived" ? recordRows.filter((row) => !row.archived) : recordRows),
    [recordRows, scope],
  );

  const idleAgents = useMemo(
    () => visibleAgents.filter((row) => row.pid !== null && row.status !== "running"),
    [visibleAgents],
  );

  const visibleWorkspaces = useMemo(
    () => (scope === "unarchived" ? workspaceRows.filter((row) => row.archivedAt === null) : workspaceRows),
    [workspaceRows, scope],
  );

  const rows = useMemo(
    () =>
      buildRows(
        visibleWorkspaces,
        projectRows,
        visibleAgents,
        collapsedProjects,
        expandedWorkspaces,
        terminalsByWorkspace,
      ),
    [visibleWorkspaces, projectRows, visibleAgents, collapsedProjects, expandedWorkspaces, terminalsByWorkspace],
  );

  useEffect(() => {
    if (!selection && compact) {
      setDetailOpen(false);
    }
  }, [selection, compact]);

  useEffect(() => {
    if (autoSelected.current || selection || workspaceRows.length === 0) {
      return;
    }
    const first = workspaceRows.find((row) => row.archivedAt === null) ?? workspaceRows[0];
    if (!first) {
      return;
    }
    autoSelected.current = true;
    setSelection(findRow(rows, "workspace", first.workspaceId) ?? null);
    setExpandedWorkspaces((current) => new Set(current).add(first.workspaceId));
  }, [rows, selection, workspaceRows]);

  const busy =
    release.pending ||
    archiveWorkspaceAction.pending ||
    closeTabs.pending ||
    closeTerminals.pending ||
    closeOneTerminalAction.pending ||
    deleteWorkspaceAction.pending ||
    rename.pending ||
    archiveAgents.pending ||
    restoreSession.pending ||
    deleteAgentsAction.pending ||
    jobs.busy ||
    cooling;

  const { styles, tones } = useMemo(() => buildStyles(theme, compact), [theme, compact]);

  const ctx: ActionsContext = useMemo(
    () => ({
      busy,
      workspaceRows,
      projectRows,
      agents: visibleAgents,
      terminals: terminalsByWorkspace,
      terminalList: workspaces.data?.terminalList ?? [],
      closeTerminal: (terminalId) => closeOneTerminalAction.mutate([terminalId]),
      canOpenAgent: typeof navigation?.openAgent === "function",
      openWorkspace: (workspaceId) => navigation?.openWorkspace?.({ workspaceId }),
      openAgent: (agentId) => navigation?.openAgent?.({ agentId }),
      activate: (input) => {
        setFeedback(null);
        jobs.activate(input);
      },
      releaseAgents: release.mutate,
      closeTabs: closeTabs.mutate,
      closeTerminals: closeTerminals.mutate,
      archiveWorkspace: archiveWorkspaceAction.mutate,
      deleteWorkspace: deleteWorkspaceAction.mutate,
      renameWorkspace: (workspaceId, title) => rename.mutate({ workspaceId, title }),
      archiveAgents: archiveAgents.mutate,
      restoreAgent: restoreSession.mutate,
      deleteAgents: deleteAgentsAction.mutate,
    }),
    [
      busy,
      workspaceRows,
      projectRows,
      visibleAgents,
      terminalsByWorkspace,
      workspaces.data?.terminalList,
      closeOneTerminalAction,
      navigation,
      jobs,
      release,
      closeTabs,
      closeTerminals,
      archiveWorkspaceAction,
      deleteWorkspaceAction,
      rename,
      archiveAgents,
      restoreSession,
      deleteAgentsAction,
    ],
  );

  const onSelect = useCallback(
    (row: TreeRow) => {
      setSelection(row);
      if (compact) {
        setDetailOpen(true);
      }
    },
    [compact],
  );

  const onToggle = useCallback((row: TreeRow) => {
    if (row.kind === "project" || row.kind === "orphan") {
      setCollapsedProjects((current) => toggleSet(current, row.id, !row.expanded));
      return;
    }
    if (row.kind === "workspace") {
      setExpandedWorkspaces((current) => toggleSet(current, row.id, row.expanded));
    }
  }, []);

  if (workspaces.isLoading && !workspaces.data) {
    return (
      <View style={styles.screen}>
        <ActivityIndicator color={tones.accent} />
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

  const activeCount = workspaceRows.filter((row) => row.archivedAt === null).length;
  const archivedCount = recordRows.filter((row) => row.archived).length;
  const unarchivedCount = recordRows.length - archivedCount;
  const noRuntimeCount = recordRows.filter((row) => !row.archived && row.status === "closed").length;

  return (
    <View style={styles.screen}>
      <View style={styles.hero}>
        <Text style={styles.headline} numberOfLines={1}>
          {workspaceRows.length} workspace{workspaceRows.length === 1 ? "" : "s"} · {activeCount} active
        </Text>

        <Text style={styles.subline} numberOfLines={2}>
          {host.label} · {recordRows.length} records ·{" "}
          <Text style={styles.factAccent}>
            {unarchivedCount} unarchived
            {noRuntimeCount > 0 ? ` (${noRuntimeCount} no runtime)` : ""}
          </Text>
          {archivedCount > 0 ? ` · ${archivedCount} archived` : ""}
        </Text>

        <Text style={styles.subline} numberOfLines={2}>
          <Text style={(workspaces.data?.overview.totals.holdingProcess ?? 0) > 0 ? styles.factAccent : undefined}>
            {workspaces.data?.overview.totals.holdingProcess ?? 0} holding ·{" "}
            {formatBytes(workspaces.data?.overview.totals.rssBytes ?? 0)}
          </Text>
          {systemParts(systemStats).map((part) => (
            <Text key={part.text} style={part.warn ? styles.factWarn : undefined}>
              {` · ${part.text}`}
            </Text>
          ))}
        </Text>

        <View style={styles.heroActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: settingsOpen }}
            onPress={() => setSettingsOpen((value) => !value)}
            style={[styles.chip, settingsOpen ? styles.chipOn : null]}
          >
            <View style={styles.heroSettingsLabel}>
              <View
                style={[
                  styles.dot,
                  autoRelease?.lastError
                    ? styles.dotWarn
                    : autoRelease?.enabled
                      ? styles.dotOk
                      : styles.dotMuted,
                ]}
              />
              <Text style={settingsOpen ? styles.chipTextOn : styles.chipText}>
                Settings {settingsOpen ? "▼" : "▶"}
              </Text>
            </View>
          </Pressable>
          <Text style={styles.heroSettingsHint} numberOfLines={1}>
            {settingsSummary(autoRelease)}
          </Text>
          <View style={styles.heroButtons}>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setFeedback(null);
                void refresh();
              }}
              style={[
                styles.button,
                styles.buttonSmall,
                compact ? styles.buttonHalf : null,
                workspaces.isFetching ? styles.disabled : null,
              ]}
            >
              <Text style={styles.buttonText}>{workspaces.isFetching ? "Refreshing…" : "Refresh"}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={busy || idleAgents.length === 0}
              style={[
                styles.button,
                styles.buttonSmall,
                styles.buttonPrimary,
                compact ? styles.buttonHalf : null,
                busy || idleAgents.length === 0 ? styles.disabled : null,
              ]}
              onPress={() => {
                setFeedback(null);
                release.mutate(idleAgents.map((row) => row.id));
              }}
            >
              <Text style={styles.buttonTextOn}>Release idle ({idleAgents.length})</Text>
            </Pressable>
          </View>
        </View>

        {settingsOpen ? (
          <SettingsSection
            state={autoRelease}
            pending={autoReleaseSave.isPending}
            onPatch={(patch) => autoReleaseSave.mutate(patch)}
            styles={styles}
            compact={compact}
            scope={scope}
            onScope={setScope}
            unarchivedCount={unarchivedCount}
            recordCount={recordRows.length}
          />
        ) : null}
      </View>

      <View style={styles.body}>
        {!compact || !detailOpen ? (
          <View style={compact ? styles.pane : styles.paneTree}>
            <TreePane
              rows={rows}
              selectedKey={selection?.key ?? null}
              onSelect={onSelect}
              onToggle={onToggle}
              styles={styles}
              compact={compact}
              emptyText={
                scope === "unarchived"
                  ? "No unarchived workspace here — switch Settings › Show to All."
                  : "No workspace on this host."
              }
            />
          </View>
        ) : null}

        {!compact || detailOpen ? (
          <View style={styles.pane}>
            <ActionsPane
              selection={selection}
              ctx={ctx}
              styles={styles}
              compact={compact}
              showBack={compact}
              onBack={() => setDetailOpen(false)}
            />
          </View>
        ) : null}
      </View>

      <View style={styles.footerRow}>
        <Text style={styles.buildStamp}>ui {uiFingerprint()}</Text>
        <View style={styles.jobRow}>
          <JobLine job={jobs.job} error={jobs.error} busy={jobs.busy} theme={theme} />
        </View>
        {workspaces.data?.overview.warning ? (
          <Text style={styles.warning}>{workspaces.data.overview.warning}</Text>
        ) : null}
        {feedback ? <Text style={styles.footer}>{feedback}</Text> : null}
      </View>
    </View>
  );
}

function useAction<TInput, TResult>(
  run: (input: TInput) => Promise<TResult>,
  describeResult: (result: TResult, input: TInput) => string | null,
  deps: unknown[],
  hooks: {
    refresh: () => Promise<void>;
    coolDown: () => void;
    report: (text: string | null) => void;
    after?: (result: TResult, input: TInput) => void;
  },
) {
  const mutation = useMutation({
    mutationFn: (input: TInput) => run(input),
    onSuccess: async (result, input) => {
      hooks.after?.(result, input);
      hooks.report(describeResult(result, input));
      hooks.coolDown();
      await hooks.refresh();
    },
    onError: (error) => hooks.report(`Failed: ${message(error)}`),
  });
  const mutate = useCallback(
    (input: TInput) => {
      hooks.report(null);
      mutation.mutate(input);
    },
    [mutation.mutate],
  );
  return { mutate, pending: mutation.isPending };
}

function buildRows(
  workspaceRows: WorkspaceRow[],
  projectRows: ProjectRow[],
  agents: AgentRow[],
  collapsedProjects: Set<string>,
  expandedWorkspaces: Set<string>,
  terminals: Map<string, TerminalInfo>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const byProject = new Map<string, WorkspaceRow[]>();
  for (const row of workspaceRows) {
    const list = byProject.get(row.projectId);
    if (list) {
      list.push(row);
    } else {
      byProject.set(row.projectId, [row]);
    }
  }

  const groups = [...byProject.entries()].map(([projectId, list]) => {
    const project = projectRows.find((entry) => entry.projectId === projectId) ?? null;
    return {
      projectId,
      name: project?.name ?? list.find((row) => row.projectName)?.projectName ?? "project removed",
      rootPath: project?.rootPath ?? list.find((row) => row.projectRoot)?.projectRoot ?? null,
      workspaces: [...list].sort(compareWorkspaces),
    };
  });
  groups.sort((left, right) => left.name.localeCompare(right.name));

  for (const group of groups) {
    const collapsed = collapsedProjects.has(group.projectId);
    const scoped = agents.filter((agent) =>
      group.workspaces.some((row) => row.workspaceId === agent.workspaceId),
    );
    const holding = scoped.filter((agent) => agent.pid !== null);
    const running = scoped.filter((agent) => agent.status === "running").length;
    const archivedAgents = scoped.filter((agent) => agent.archived).length;
    const noRuntime = scoped.filter((agent) => !agent.archived && agent.status === "closed").length;

    rows.push({
      key: `project:${group.projectId}`,
      kind: "project",
      id: group.projectId,
      workspaceId: null,
      label: group.name,
      facts: [
        {
          text: `${scoped.length - archivedAgents} unarchived${noRuntime > 0 ? ` (${noRuntime} no runtime)` : ""}`,
          tone: "quiet",
        },
        ...(archivedAgents > 0 ? [{ text: `${archivedAgents} archived`, tone: "quiet" as FactTone }] : []),
        ...(holding.length > 0
          ? [
              {
                text: `${holding.length} holding · ${formatBytes(holding.reduce((sum, agent) => sum + (agent.rssBytes ?? 0), 0))}`,
                tone: "accent" as FactTone,
              },
            ]
          : []),
        ...(running > 0 ? [{ text: `${running} running`, tone: "ok" as FactTone }] : []),
        ...(group.rootPath ? [{ text: group.rootPath, tone: "quiet" as FactTone }] : []),
      ],
      depth: 0,
      expandable: true,
      expanded: !collapsed,
      archived: group.workspaces.every((row) => row.archivedAt !== null),
      status: running > 0 ? "running" : holding.length > 0 ? "idle" : null,
      count: group.workspaces.length,
    });

    if (collapsed) {
      continue;
    }

    for (const workspace of group.workspaces) {
      const stats = workspaceStats(agents, workspace.workspaceId);
      const facts: Array<{ text: string; tone: FactTone }> = [
        { text: workspace.branch ?? workspace.kind, tone: "quiet" },
      ];
      if (stats.holding > 0) {
        facts.push({ text: `${stats.holding} holding · ${formatBytes(stats.rssBytes)}`, tone: "accent" });
      }
      facts.push({
        text: `${stats.open} unarchived${stats.noRuntime > 0 ? ` (${stats.noRuntime} no runtime)` : ""}`,
        tone: "quiet",
      });
      if (stats.archived > 0) {
        facts.push({ text: `${stats.archived} archived`, tone: "quiet" });
      }
      const terminal = terminals.get(workspace.workspaceId);
      if ((terminal?.count ?? 0) > 0) {
        const busy = terminal?.working ?? 0;
        facts.push({
          text: `${terminal?.count ?? 0} terminal${(terminal?.count ?? 0) === 1 ? "" : "s"}${busy > 0 ? ` (${busy} working)` : ""} · ${formatBytes(terminal?.rssBytes ?? 0)}`,
          tone: busy > 0 || (terminal?.busy ?? 0) > 0 ? "warn" : "quiet",
        });
      }
      facts.push({ text: formatTime(workspace.createdAt), tone: "quiet" });
      if (workspace.pinnedAt) {
        facts.push({ text: "pinned", tone: "quiet" });
      }
      if (workspace.isPaseoOwnedWorktree) {
        facts.push({ text: "worktree", tone: "quiet" });
      }
      if (workspace.autoArchivedChangeRequestUrl) {
        facts.push({ text: "auto-archived by PR", tone: "quiet" });
      }
      if (workspace.archivedAt) {
        facts.push({ text: `archived ${formatTime(workspace.archivedAt)}`, tone: "quiet" });
      }

      rows.push({
        key: `workspace:${workspace.workspaceId}`,
        kind: "workspace",
        id: workspace.workspaceId,
        workspaceId: workspace.workspaceId,
        label: workspaceLabel(workspace),
        facts,
        depth: 1,
        expandable: stats.open > 0,
        expanded: expandedWorkspaces.has(workspace.workspaceId),
        archived: workspace.archivedAt !== null,
        status: stats.running > 0 ? "running" : stats.holding > 0 ? "idle" : "closed",
        count: stats.open,
      });

      if (!expandedWorkspaces.has(workspace.workspaceId)) {
        continue;
      }

      const scopedAgents = agents
        .filter((agent) => agent.workspaceId === workspace.workspaceId)
        .sort(compareAgents);
      const ids = new Set(scopedAgents.map((agent) => agent.id));
      for (const agent of scopedAgents) {
        const isChild = agent.parentAgentId !== null && ids.has(agent.parentAgentId);
        if (isChild) {
          continue;
        }
        rows.push(agentRow(agent, 2));
        for (const child of scopedAgents) {
          if (child.parentAgentId === agent.id) {
            rows.push(agentRow(child, 3));
          }
        }
      }
    }
  }

  const orphans = agents.filter((agent) => agent.workspaceId === null).sort(compareAgents);
  if (orphans.length > 0) {
    const collapsed = collapsedProjects.has("orphan");
    rows.push({
      key: "orphan:sessions",
      kind: "orphan",
      id: "orphan",
      workspaceId: null,
      label: "No workspace",
      facts: [
        { text: `${orphans.length} session${orphans.length === 1 ? "" : "s"}`, tone: "quiet" },
        { text: "workspace record is gone", tone: "quiet" },
      ],
      depth: 0,
      expandable: true,
      expanded: !collapsed,
      archived: orphans.every((agent) => agent.archived),
      status: null,
      count: orphans.length,
    });
    if (!collapsed) {
      for (const agent of orphans) {
        rows.push(agentRow(agent, 1));
      }
    }
  }

  return rows;
}

function agentRow(agent: AgentRow, depth: number): TreeRow {
  const statusTone: FactTone =
    agent.status === "running" ? "ok" : agent.status === "error" ? "danger" : agent.status === "closed" ? "quiet" : "accent";
  const facts: Array<{ text: string; tone: FactTone }> = [
    { text: statusWord(agent.status), tone: statusTone },
    {
      text: agent.pid === null ? formatTime(agent.updatedAt) : `${formatBytes(agent.rssBytes ?? 0)} · pid ${agent.pid}`,
      tone: agent.pid === null ? "quiet" : "accent",
    },
  ];
  if (agent.attentionReason) {
    facts.push({ text: agent.attentionReason, tone: "warn" });
  }
  const labels = Object.entries(agent.labels);
  if (labels.length > 0) {
    facts.push({
      text: labels.map(([key, value]) => (value ? `${key}=${value}` : key)).join(" "),
      tone: "quiet",
    });
  }
  facts.push({ text: formatTime(agent.updatedAt), tone: "quiet" });
  if (agent.provider) {
    facts.push({ text: agent.provider, tone: "quiet" });
  }
  if (agent.archived) {
    facts.push({ text: "archived", tone: "quiet" });
  }
  return {
    key: `agent:${agent.id}`,
    kind: "agent",
    id: agent.id,
    workspaceId: agent.workspaceId,
    label: agent.parentAgentId ? `↳ ${agentTitle(agent)}` : agentTitle(agent),
    facts,
    depth,
    expandable: false,
    expanded: false,
    archived: agent.archived,
    status: agent.status === "error" ? "error" : agent.status,
    count: null,
  };
}

function compareWorkspaces(left: WorkspaceRow, right: WorkspaceRow): number {
  if ((left.archivedAt === null) !== (right.archivedAt === null)) {
    return left.archivedAt === null ? -1 : 1;
  }
  return workspaceLabel(left).localeCompare(workspaceLabel(right));
}

function compareAgents(left: AgentRow, right: AgentRow): number {
  if (left.archived !== right.archived) {
    return left.archived ? 1 : -1;
  }
  if ((left.pid !== null) !== (right.pid !== null)) {
    return left.pid !== null ? -1 : 1;
  }
  return agentTitle(left).localeCompare(agentTitle(right));
}

function findRow(rows: TreeRow[], kind: TreeKind, id: string): TreeRow | null {
  return rows.find((row) => row.kind === kind && row.id === id) ?? null;
}

function uiFingerprint(): string {
  const sources = [AgentManagerPanel, TreePane, ActionsPane, SettingsSection].map((component) => {
    try {
      return String(component);
    } catch {
      return "";
    }
  });
  let hash = 2166136261;
  for (const part of sources.join("|")) {
    hash ^= part.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6);
}

function toggleSet(current: Set<string>, key: string, on: boolean): Set<string> {
  const next = new Set(current);
  if (on) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
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

function summarize(label: string, freed: string | null, failed: Array<{ agentId: string; error: string }>): string {
  const head = freed ? `${label} · ${freed} freed` : label;
  if (failed.length === 0) {
    return head;
  }
  return `${head} · ${failed.length} failed: ${failed[0]?.error ?? ""}`;
}

import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import type { AgentRow, ProjectRow, TerminalEntryRow, WorkspaceRow } from "../shared/contracts";
import { formatBytes, formatTime } from "./format";
import { factStyle, type FactTone, type StyleMap, type TerminalInfo } from "./styles";
import type { TreeRow } from "./tree";
import {
  activeAtPath,
  isLastActiveAtPath,
  reopenCandidate,
  workspaceLabel,
  workspaceStats,
  type WorkspaceStats,
} from "./workspaces";

export interface ActionsContext {
  busy: boolean;
  workspaceRows: WorkspaceRow[];
  projectRows: ProjectRow[];
  agents: AgentRow[];
  terminals: Map<string, TerminalInfo>;
  terminalList: TerminalEntryRow[];
  closeTerminal: (terminalId: string) => void;
  canOpenAgent: boolean;
  openWorkspace: (workspaceId: string) => void;
  openAgent: (agentId: string) => void;
  activate: (input: { workspaceId: string; workspaceName?: string; tabsOnly?: boolean }) => void;
  releaseAgents: (agentIds: string[]) => void;
  closeTabs: (workspaceId: string) => void;
  closeTerminals: (workspaceId: string) => void;
  archiveWorkspace: (workspaceId: string) => void;
  deleteWorkspace: (workspaceId: string) => void;
  renameWorkspace: (workspaceId: string, title: string) => void;
  archiveAgents: (agentIds: string[]) => void;
  restoreAgent: (agentId: string) => void;
  deleteAgents: (agentIds: string[]) => void;
}

interface Action {
  id: string;
  label: string;
  tone: "default" | "primary" | "danger";
  disabled?: boolean;
  run: () => void;
  confirm?: { title: string; lines: string[]; confirmLabel: string };
}

interface Pending {
  title: string;
  lines: string[];
  confirmLabel: string;
  run: () => void;
}

interface InfoRow {
  label: string;
  value: string;
}

interface SelectionView {
  kindLabel: string;
  title: string;
  sub: string | null;
  facts: Array<{ text: string; tone: FactTone }>;
  info: InfoRow[];
  hint: string | null;
  renameValue: string;
  workspace: WorkspaceRow | null;
  agent: AgentRow | null;
  stats: WorkspaceStats | null;
  terminal: TerminalInfo | null;
  terminalRows: TerminalEntryRow[];
  scoped: AgentRow[];
}

export function ActionsPane({
  selection,
  ctx,
  styles,
  compact,
  showBack,
  onBack,
}: {
  selection: TreeRow | null;
  ctx: ActionsContext;
  styles: StyleMap;
  compact: boolean;
  showBack: boolean;
  onBack: () => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const selectionKey = selection?.key ?? null;

  useEffect(() => {
    setPending(null);
    setRenaming(false);
    setRenameValue("");
  }, [selectionKey]);

  if (!selection) {
    return (
      <ScrollView style={styles.paneScroll} contentContainerStyle={styles.actionsPaneContent}>
        {showBack ? (
          <View style={styles.treeRowInner}>
            <Pressable accessibilityRole="button" style={styles.chip} onPress={onBack}>
              <Text style={styles.chipText}>Back</Text>
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.empty}>Select a project, workspace or session on the left.</Text>
      </ScrollView>
    );
  }

  const view = describe(selection, ctx);
  const actions = buildActions(selection, view, ctx, {
    rename: () => {
      setRenaming(true);
      setRenameValue(view.renameValue);
    },
  });

  return (
    <ScrollView style={styles.paneScroll} contentContainerStyle={styles.actionsPaneContent}>
      <View style={styles.actionsHead}>
        <View style={styles.treeRowInner}>
          {showBack ? (
            <Pressable accessibilityRole="button" style={styles.chip} onPress={onBack}>
              <Text style={styles.chipText}>Back</Text>
            </Pressable>
          ) : null}
          <Text style={styles.actionsKind}>{view.kindLabel}</Text>
        </View>
        <Text style={styles.actionsTitle} numberOfLines={2}>
          {view.title}
        </Text>
        {view.sub ? (
          <Text style={styles.actionsSub} numberOfLines={2}>
            {view.sub}
          </Text>
        ) : null}
        {view.facts.length > 0 ? (
          <Text style={styles.actionsSub} numberOfLines={2}>
            {view.facts.map((fact, index) => (
              <Text key={fact.text} style={factStyle(fact.tone, styles)}>
                {index === 0 ? fact.text : ` · ${fact.text}`}
              </Text>
            ))}
          </Text>
        ) : null}
      </View>

      {view.info.map((row) => (
        <View key={row.label} style={styles.infoRow}>
          <Text style={styles.infoLabel}>{row.label}</Text>
          <Text style={styles.infoValue} numberOfLines={2}>
            {row.value}
          </Text>
        </View>
      ))}

      {view.terminalRows.length > 0 ? (
        <>
          <View style={styles.divider} />
          {view.terminalRows.map((terminal) => (
            <View key={terminal.id} style={styles.terminalRow}>
              <View style={styles.terminalText}>
                <Text style={styles.infoValue} numberOfLines={1}>
                  {terminal.name}
                </Text>
                <Text style={styles.hint} numberOfLines={1}>
                  {terminalStateLabel(terminal)} · {terminal.cwd}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={ctx.busy}
                style={[styles.button, ctx.busy ? styles.disabled : null]}
                onPress={() => ctx.closeTerminal(terminal.id)}
              >
                <Text style={styles.buttonText}>Close</Text>
              </Pressable>
            </View>
          ))}
        </>
      ) : null}

      {actions.length > 0 ? <View style={styles.divider} /> : null}
      <View style={styles.actionsGrid}>
        {actions.map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            disabled={ctx.busy || action.disabled === true}
            style={[
              styles.button,
              action.tone === "primary" ? styles.buttonPrimary : null,
              action.tone === "danger" ? styles.buttonDanger : null,
              compact ? styles.buttonHalf : null,
              ctx.busy || action.disabled === true ? styles.disabled : null,
            ]}
            onPress={() => {
              setPending(action.confirm ? { ...action.confirm, run: action.run } : null);
              if (!action.confirm) {
                action.run();
              }
            }}
          >
            <Text style={action.tone === "default" ? styles.buttonText : styles.buttonTextOn}>{action.label}</Text>
          </Pressable>
        ))}
      </View>

      {view.hint ? <Text style={styles.hint}>{view.hint}</Text> : null}

      {pending ? (
        <View style={styles.confirm}>
          <Text style={styles.confirmText}>{pending.title}</Text>
          {pending.lines.map((line) => (
            <Text key={line} style={styles.hint}>
              {line}
            </Text>
          ))}
          <View style={styles.actionsGrid}>
            <Pressable
              accessibilityRole="button"
              disabled={ctx.busy}
              style={[
                styles.button,
                styles.buttonDanger,
                compact ? styles.buttonHalf : null,
                ctx.busy ? styles.disabled : null,
              ]}
              onPress={() => {
                const run = pending.run;
                setPending(null);
                run();
              }}
            >
              <Text style={styles.buttonTextOn}>{pending.confirmLabel}</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.button, compact ? styles.buttonHalf : null]}
              onPress={() => setPending(null)}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {renaming ? (
        <View style={styles.renamePanel}>
          <TextInput
            autoFocus
            value={renameValue}
            onChangeText={setRenameValue}
            onSubmitEditing={() => {
              ctx.renameWorkspace(selection.id, renameValue);
              setRenaming(false);
            }}
            placeholder="Workspace name"
            returnKeyType="done"
            style={styles.renameInput}
          />
          <Text style={styles.hint}>
            Saved on the daemon, archived or not. Clear the field to fall back to the directory name.
          </Text>
          <View style={styles.actionsGrid}>
            <Pressable
              accessibilityRole="button"
              disabled={ctx.busy}
              style={[
                styles.button,
                styles.buttonPrimary,
                compact ? styles.buttonHalf : null,
                ctx.busy ? styles.disabled : null,
              ]}
              onPress={() => {
                ctx.renameWorkspace(selection.id, renameValue);
                setRenaming(false);
              }}
            >
              <Text style={styles.buttonTextOn}>Save name</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[styles.button, compact ? styles.buttonHalf : null]}
              onPress={() => setRenaming(false)}
            >
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function describe(selection: TreeRow, ctx: ActionsContext): SelectionView {
  if (selection.kind === "agent") {
    return describeAgent(selection.id, ctx);
  }
  if (selection.kind === "workspace") {
    return describeWorkspace(selection.id, ctx);
  }
  return describeGroup(selection, ctx);
}

function describeAgent(agentId: string, ctx: ActionsContext): SelectionView {
  const agent = ctx.agents.find((row) => row.id === agentId) ?? null;
  if (!agent) {
    return emptyView("SESSION");
  }
  const workspace = ctx.workspaceRows.find((row) => row.workspaceId === agent.workspaceId) ?? null;
  const parent = agent.parentAgentId ? ctx.agents.find((row) => row.id === agent.parentAgentId) ?? null : null;
  const labelText = Object.entries(agent.labels)
    .map(([key, value]) => (value ? `${key}=${value}` : key))
    .join(" · ");
  return {
    kindLabel: agent.archived ? "SESSION · ARCHIVED" : "SESSION",
    title: agentTitle(agent),
    sub: agent.cwd,
    facts: [],
    info: [
      { label: "Status", value: agent.archived ? `archived · ${statusWord(agent.status)}` : statusWord(agent.status) },
      {
        label: "Runtime",
        value: agent.pid === null ? "no runtime process" : `pid ${agent.pid} · ${formatBytes(agent.rssBytes ?? 0)}`,
      },
      { label: "Provider", value: [agent.provider, agent.model].filter(Boolean).join(" · ") || "—" },
      { label: "Created", value: formatTime(agent.createdAt) },
      { label: "Updated", value: formatTime(agent.updatedAt) },
      ...(agent.lastUserMessageAt ? [{ label: "Last message", value: formatTime(agent.lastUserMessageAt) }] : []),
      ...(agent.attentionReason ? [{ label: "Waiting", value: agent.attentionReason }] : []),
      ...(labelText ? [{ label: "Labels", value: labelText }] : []),
      ...(parent ? [{ label: "Parent", value: agentTitle(parent) }] : []),
      { label: "Workspace", value: workspace ? workspaceLabel(workspace) : "none" },
      { label: "Path", value: agent.cwd ?? "—" },
    ],
    hint: agent.archived
      ? "Archived: Paseo keeps the record and its history but hides it from the tab strip. Restore puts it back."
      : agent.status === "closed"
        ? "No runtime: nothing is running for this session right now — its tab and history stay, and the next message starts a process again. Only archived sessions leave the tab strip."
        : "Release stops the runtime process. The tab and its history stay, and the next message starts a process again.",
    renameValue: "",
    workspace,
    agent,
    stats: null,
    terminal: null,
    terminalRows: [],
    scoped: [],
  };
}

function describeWorkspace(workspaceId: string, ctx: ActionsContext): SelectionView {
  const row = ctx.workspaceRows.find((entry) => entry.workspaceId === workspaceId) ?? null;
  if (!row) {
    return emptyView("WORKSPACE");
  }
  const stats = workspaceStats(ctx.agents, row.workspaceId);
  const terminal = ctx.terminals.get(row.workspaceId) ?? null;
  const archived = row.archivedAt !== null;
  const facts: Array<{ text: string; tone: FactTone }> = [];
  if (stats.holding > 0) {
    facts.push({ text: `${stats.holding} holding · ${formatBytes(stats.rssBytes)}`, tone: "accent" });
  }
  facts.push({ text: `${stats.total} session${stats.total === 1 ? "" : "s"}`, tone: "quiet" });
  if (stats.running > 0) {
    facts.push({ text: `${stats.running} running`, tone: "ok" });
  }
  if ((terminal?.count ?? 0) > 0) {
    facts.push({
      text: `${terminal?.count ?? 0} terminal${(terminal?.count ?? 0) === 1 ? "" : "s"} · ${formatBytes(terminal?.rssBytes ?? 0)}`,
      tone: (terminal?.working ?? 0) > 0 || (terminal?.busy ?? 0) > 0 ? "warn" : "quiet",
    });
  }
  const siblings = archived
    ? []
    : activeAtPath(ctx.workspaceRows, row).filter((entry) => entry.workspaceId !== row.workspaceId);
  if (siblings.length > 0) {
    facts.push({ text: `+${siblings.length} active at this path`, tone: "quiet" });
  }
  const info: InfoRow[] = [
    { label: "Project", value: row.projectName ?? "project removed" },
    { label: "Kind", value: row.kind },
    { label: "Branch", value: row.branch ?? "—" },
  ];
  if (row.baseBranch) {
    info.push({ label: "Base branch", value: row.baseBranch });
  }
  if (row.isPaseoOwnedWorktree) {
    info.push({ label: "Worktree", value: row.mainRepoRoot ? `Paseo-owned · ${row.mainRepoRoot}` : "Paseo-owned" });
  }
  info.push({ label: "Sessions", value: `${stats.open} open · ${stats.archived} archived` });
  if ((terminal?.count ?? 0) > 0) {
    const busy = terminal?.working ?? 0;
    const idle = terminal?.idle ?? 0;
    const unknown = Math.max(0, (terminal?.count ?? 0) - busy - idle);
    const parts = [`${terminal?.count ?? 0} open`, `${formatBytes(terminal?.rssBytes ?? 0)}`];
    if (busy > 0) parts.push(`${busy} working`);
    if (idle > 0) parts.push(`${idle} waiting at a prompt`);
    if (unknown > 0) parts.push(`${unknown} not reporting activity`);
    info.push({ label: "Terminals", value: parts.join(" · ") });
  }
  info.push({ label: "Created", value: formatTime(row.createdAt) });
  if (archived) {
    info.push({ label: "Archived", value: formatTime(row.archivedAt) });
  }
  if (row.pinnedAt) {
    info.push({ label: "Pinned", value: formatTime(row.pinnedAt) });
  }
  if (row.autoArchivedChangeRequestUrl) {
    info.push({ label: "Auto-archived", value: row.autoArchivedChangeRequestUrl });
  }
  return {
    kindLabel: archived ? "WORKSPACE · ARCHIVED" : "WORKSPACE",
    title: workspaceLabel(row),
    sub: row.cwd,
    facts,
    info,
    hint: archived
      ? "Restore brings the workspace back and reopens the tabs it had when it was archived."
      : "Release idle stops the runtimes that are not working. Close open tabs stops every tab and frees the same memory.",
    renameValue: row.name ?? "",
    workspace: row,
    agent: null,
    stats,
    terminal,
    terminalRows: ctx.terminalList.filter((terminal) => terminal.workspaceId === row.workspaceId),
    scoped: [],
  };
}

function describeGroup(selection: TreeRow, ctx: ActionsContext): SelectionView {
  const orphan = selection.kind === "orphan";
  const workspaceIds = new Set(
    orphan
      ? []
      : ctx.workspaceRows.filter((row) => row.projectId === selection.id).map((row) => row.workspaceId),
  );
  const scoped = ctx.agents.filter((agent) =>
    orphan ? agent.workspaceId === null : agent.workspaceId !== null && workspaceIds.has(agent.workspaceId),
  );
  const holding = scoped.filter((agent) => agent.pid !== null);
  const running = scoped.filter((agent) => agent.pid !== null && agent.status === "running");
  const idle = holding.filter((agent) => agent.status !== "running");
  const archived = scoped.filter((agent) => agent.archived).length;
  const facts: Array<{ text: string; tone: FactTone }> = [];
  if (holding.length > 0) {
    facts.push({
      text: `${holding.length} holding · ${formatBytes(holding.reduce((sum, agent) => sum + (agent.rssBytes ?? 0), 0))}`,
      tone: "accent",
    });
  }
  facts.push({ text: `${scoped.length} session${scoped.length === 1 ? "" : "s"}`, tone: "quiet" });
  if (running.length > 0) {
    facts.push({ text: `${running.length} running`, tone: "ok" });
  }
  const project = orphan ? null : ctx.projectRows.find((row) => row.projectId === selection.id) ?? null;
  return {
    kindLabel: orphan ? "SESSIONS · NO WORKSPACE" : "PROJECT",
    title: selection.label,
    sub: project?.rootPath ?? null,
    facts,
    info: orphan
      ? []
      : [
          { label: "Kind", value: project?.kind ?? "—" },
          { label: "Root", value: project?.rootPath ?? "—" },
          { label: "Workspaces", value: `${workspaceIds.size}` },
          { label: "Sessions", value: `${scoped.length - archived} open · ${archived} archived` },
          { label: "Idle runtimes", value: `${idle.length}` },
        ],
    hint:
      idle.length > 0
        ? `${idle.length} idle session(s) here still hold a process. Release idle frees them without touching the ones that are working.`
        : "No idle session holds a process here.",
    renameValue: "",
    workspace: null,
    agent: null,
    stats: null,
    terminal: null,
    terminalRows: [],
    scoped,
  };
}

function buildActions(
  selection: TreeRow,
  view: SelectionView,
  ctx: ActionsContext,
  helpers: { rename: () => void },
): Action[] {
  const busy = ctx.busy;

  if (selection.kind === "agent") {
    const agent = view.agent;
    if (!agent) {
      return [];
    }
    const actions: Action[] = [
      {
        id: "open",
        label: "Open tab",
        tone: "primary",
        disabled: !ctx.canOpenAgent,
        run: () => ctx.openAgent(agent.id),
      },
      {
        id: "release",
        label: "Release process",
        tone: "default",
        disabled: agent.pid === null,
        run: () => ctx.releaseAgents([agent.id]),
      },
    ];
    if (agent.archived) {
      actions.push({
        id: "restore",
        label: "Restore session",
        tone: "primary",
        run: () => ctx.restoreAgent(agent.id),
      });
    } else {
      actions.push({
        id: "archive",
        label: "Archive session",
        tone: "default",
        run: () => ctx.archiveAgents([agent.id]),
      });
    }
    actions.push({
      id: "delete",
      label: "Delete session…",
      tone: "danger",
      run: () => ctx.deleteAgents([agent.id]),
      confirm: {
        title: `Delete "${agentTitle(agent)}" permanently?`,
        lines: [
          "The session record and its history are removed and the runtime stops.",
          "The provider's own session file stays on disk, so it can be imported again.",
        ],
        confirmLabel: "Confirm delete",
      },
    });
    return actions;
  }

  if (selection.kind === "workspace") {
    const row = view.workspace;
    if (!row || !view.stats) {
      return [];
    }
    const label = workspaceLabel(row);
    const stats = view.stats;
    if (row.archivedAt !== null) {
      return [
        {
          id: "restore",
          label: "Restore workspace",
          tone: "primary",
          disabled: busy,
          run: () => ctx.activate({ workspaceId: row.workspaceId, workspaceName: label }),
        },
        { id: "rename", label: "Rename workspace…", tone: "default", run: helpers.rename },
        {
          id: "delete",
          label: "Delete workspace",
          tone: "danger",
          run: () => ctx.deleteWorkspace(row.workspaceId),
          confirm: {
            title: `Delete "${label}" permanently?`,
            lines: [`${stats.total} session(s) and their history are removed.`],
            confirmLabel: "Confirm delete",
          },
        },
      ];
    }

    const idle = ctx.agents
      .filter((agent) => agent.workspaceId === row.workspaceId && agent.pid !== null && agent.status !== "running")
      .map((agent) => agent.id);
    const running = ctx.agents.filter(
      (agent) => agent.workspaceId === row.workspaceId && agent.pid !== null && agent.status === "running",
    );
    const lastActive = isLastActiveAtPath(ctx.workspaceRows, row);
    const candidate = lastActive ? reopenCandidate(ctx.workspaceRows, row) : null;
    const actions: Action[] = [
      {
        id: "open",
        label: "Open in app",
        tone: "default",
        disabled: busy,
        run: () => ctx.openWorkspace(row.workspaceId),
      },
      {
        id: "release-idle",
        label: `Release idle (${idle.length})`,
        tone: "primary",
        disabled: busy || idle.length === 0,
        run: () => ctx.releaseAgents(idle),
      },
    ];
    if (running.length > 0) {
      actions.push({
        id: "release-running",
        label: `Release running (${running.length})`,
        tone: "default",
        disabled: busy,
        run: () => ctx.releaseAgents(running.map((agent) => agent.id)),
        confirm: {
          title: `Release ${running.length} running session(s)?`,
          lines: ["Their current turn is interrupted."],
          confirmLabel: "Confirm release",
        },
      });
    }
    actions.push(
      {
        id: "reopen",
        label: `Reopen archived tabs (${stats.archived})`,
        tone: "default",
        disabled: busy || stats.archived === 0,
        run: () => ctx.activate({ workspaceId: row.workspaceId, workspaceName: label, tabsOnly: true }),
      },
      {
        id: "tabs",
        label: `Close open tabs (${stats.open})`,
        tone: "default",
        disabled: busy || stats.open === 0,
        run: () => ctx.closeTabs(row.workspaceId),
      },
      {
        id: "terminals",
        label: `Close terminals (${view.terminal?.count ?? 0})`,
        tone: "default",
        disabled: busy || (view.terminal?.count ?? 0) === 0,
        run: () => ctx.closeTerminals(row.workspaceId),
        confirm: {
          title: `Close ${view.terminal?.count ?? 0} terminal(s) in "${label}"?`,
          lines: [
            `This closes: ${terminalNames(view.terminalRows)}.`,
            ...(terminalWarning(view.terminal) === null ? ["Nothing reports a running command."] : [terminalWarning(view.terminal) as string]),
          ],
          confirmLabel: "Confirm close",
        },
      },
      {
        id: "archive",
        label: "Archive workspace",
        tone: "default",
        disabled: busy,
        run: () => ctx.archiveWorkspace(row.workspaceId),
        confirm:
          stats.total === 0
            ? undefined
            : {
                title: `Archive "${label}"?`,
                lines: [
                  `${stats.total} session(s) stop now${stats.running > 0 ? ` (${stats.running} running)` : ""}.`,
                  ...(lastActive
                    ? [
                        `Only active workspace at this path — Paseo reopens "${
                          candidate ? workspaceLabel(candidate) : "an archived one"
                        }" here next time.`,
                      ]
                    : []),
                  "Close open tabs does the same to the sessions without hiding the workspace.",
                ],
                confirmLabel: "Confirm archive",
              },
      },
      { id: "rename", label: "Rename workspace…", tone: "default", run: helpers.rename },
    );
    return actions;
  }

  const holding = view.scoped.filter((agent) => agent.pid !== null);
  const idle = holding.filter((agent) => agent.status !== "running").map((agent) => agent.id);
  const running = holding.filter((agent) => agent.status === "running").map((agent) => agent.id);
  const actions: Action[] = [
    {
      id: "release-idle",
      label: `Release idle (${idle.length})`,
      tone: "primary",
      disabled: busy || idle.length === 0,
      run: () => ctx.releaseAgents(idle),
    },
  ];
  if (running.length > 0) {
    actions.push({
      id: "release-running",
      label: `Release running (${running.length})`,
      tone: "default",
      disabled: busy,
      run: () => ctx.releaseAgents(running),
      confirm: {
        title: `Release ${running.length} running session(s)?`,
        lines: ["Their current turn is interrupted."],
        confirmLabel: "Confirm release",
      },
    });
  }
  return actions;
}

export function terminalNames(rows: TerminalEntryRow[]): string {
  if (rows.length === 0) {
    return "none";
  }
  const shown = rows.slice(0, 4).map((row) => row.name);
  return rows.length > shown.length ? `${shown.join(", ")} +${rows.length - shown.length} more` : shown.join(", ");
}

export function terminalStateLabel(row: TerminalEntryRow): string {
  if (row.attention === "needs_input") {
    return "needs input";
  }
  if (row.attention === "finished") {
    return "finished";
  }
  if (row.state === "working") {
    return "working";
  }
  if (row.state === "idle") {
    return "waiting at a prompt";
  }
  return "not reporting activity";
}

export function terminalWarning(terminal: TerminalInfo | null): string | null {
  if (!terminal) {
    return null;
  }
  if (terminal.working > 0) {
    return `${terminal.working} of them are working — that command stops.`;
  }
  if (terminal.busy > 0) {
    return `${terminal.busy} of them have child processes; anything running there stops.`;
  }
  return null;
}

export function statusWord(status: string): string {
  if (status === "closed") return "no runtime";
  if (status === "initializing") return "starting";
  return status;
}

export function agentTitle(agent: AgentRow): string {
  const title = agent.title?.trim();
  return title ? title : agent.id.slice(0, 7);
}

function emptyView(kindLabel: string): SelectionView {
  return {
    kindLabel,
    title: "Not found",
    sub: null,
    facts: [],
    info: [],
    hint: null,
    renameValue: "",
    workspace: null,
    agent: null,
    stats: null,
    terminal: null,
    terminalRows: [],
    scoped: [],
  };
}

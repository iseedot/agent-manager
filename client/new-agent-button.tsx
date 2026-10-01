import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

import { overviewRpc, workspacesRpc, type AgentRow } from "../shared/contracts";
import { WorkspacePillPanel } from "./composer-panel";
import { formatBytes, formatMegabytes, message } from "./format";

const PILL_ID = "agent-workspace-pill";
const FOCUS_SURFACE_ID = "open-agent";
const PILL_TITLE = "Tabs and status";
const LABEL_FALLBACK = "Tabs";
const PILL_ICON = "Layers";
const OVERVIEW_THROTTLE_MS = 5000;
const OVERVIEW_RETRY_MS = 4000;
const AGENT_PAGE_LIMIT = 200;
const REFRESH_THROTTLE_MS = 5000;
const ERROR_TITLE_MS = 8000;

type Paseo = PluginClientContext["paseo"];

interface AgentLike {
  id?: unknown;
  status?: unknown;
  workspaceId?: unknown;
  archivedAt?: unknown;
  provider?: unknown;
  model?: unknown;
  currentModeId?: unknown;
  thinkingOptionId?: unknown;
  runtimeInfo?: { modeId?: unknown; thinkingOptionId?: unknown } | null;
}

interface AgentConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface NewAgentRequest {
  workspaceId: string;
  paseo: Paseo;
}

let pendingFocus: string | null = null;
let pendingRequest: NewAgentRequest | null = null;
const requestListeners = new Set<() => void>();

function emitRequest(): void {
  for (const listener of [...requestListeners]) {
    try {
      listener();
    } catch {
      continue;
    }
  }
}

export function requestAgentFocus(agentId: string): void {
  pendingFocus = agentId;
  emitRequest();
}

export function consumeAgentFocus(): string | null {
  const agentId = pendingFocus;
  pendingFocus = null;
  return agentId;
}

export function requestNewAgent(workspaceId: string, paseo: Paseo): void {
  pendingRequest = { workspaceId, paseo };
  emitRequest();
}

export function consumeNewAgentRequest(): NewAgentRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

export function subscribeComposerRequests(listener: () => void): () => void {
  requestListeners.add(listener);
  return () => {
    requestListeners.delete(listener);
  };
}

let mountedFocusSurfaces = 0;

export function markFocusSurfaceMounted(): void {
  mountedFocusSurfaces += 1;
}

export function unmarkFocusSurfaceMounted(): void {
  mountedFocusSurfaces = Math.max(0, mountedFocusSurfaces - 1);
}

export function isFocusSurfaceMounted(): boolean {
  return mountedFocusSurfaces > 0;
}

export function contributeComposerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const busy = new Set<string>();
  let released = false;
  let lastListedAt = 0;
  let overview: AgentRow[] = [];
  let lastOverviewAt = 0;
  let overviewTask: Promise<void> | null = null;
  let overviewRetry: ReturnType<typeof setTimeout> | null = null;
  const signatures = new Map<string, string>();

  const flash = (title: string): void => {
    for (const registration of pills.values()) {
      try {
        registration.update({ title });
      } catch {
        continue;
      }
    }
    setTimeout(() => {
      for (const agentId of [...pills.keys()]) {
        signatures.delete(agentId);
        applyStatus(agentId);
      }
    }, ERROR_TITLE_MS);
  };

  const fail = (what: string, error: unknown): void => {
    console.log(`agent-manager could not ${what}: ${message(error)}`);
    if (what === "create the session") {
      flash(`New agent — failed: ${message(error)}`);
    }
  };

  const register = (agentId: string, workspaceId: string): void => {
    if (released || pills.has(agentId)) {
      return;
    }
    const Content = (props: PluginButtonContentProps) => (
      <WorkspacePillPanel
        {...props}
        client={client}
        onNewAgent={(id) => void press(id)}
        onOpenTab={openTab}
      />
    );
    const pill = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: PILL_TITLE,
        label: LABEL_FALLBACK,
        icon: PILL_ICON,
        behavior: { kind: "popover" as const, Content },
      },
    });
    pills.set(agentId, pill);
    applyStatus(agentId);
    void scheduleOverview(true).then(() => applyStatus(agentId));
  };

  const tabsFor = (workspaceId: string): AgentRow[] =>
    overview.filter(
      (row) => row.workspaceId === workspaceId && !row.archived && row.parentAgentId === null,
    );

  const applyStatus = (agentId: string): void => {
    const registration = pills.get(agentId);
    if (!registration) {
      return;
    }
    const agent = overview.find((row) => row.id === agentId) ?? null;
    if (!agent || !agent.workspaceId) {
      return;
    }
    const tabs = tabsFor(agent.workspaceId);
    const holding = overview.filter((row) => row.workspaceId === agent.workspaceId && row.pid !== null);
    const bytes = holding.reduce((sum, row) => sum + (row.rssBytes ?? 0), 0);
    const signature = `${tabs.length}|${holding.length}|${Math.round(bytes / (1024 * 1024))}`;
    if (signatures.get(agentId) === signature) {
      return;
    }
    signatures.set(agentId, signature);
    const count = tabs.length;
    const tabsWord = `${count} tab${count === 1 ? "" : "s"}`;
    const label = count === 0 ? LABEL_FALLBACK : bytes > 0 ? `${tabsWord} · ${formatMegabytes(bytes)}` : tabsWord;
    const title =
      count === 0
        ? "No open tab in this workspace"
        : `${tabsWord} · ${holding.length} holding${bytes > 0 ? ` · ${formatBytes(bytes)}` : ""} in this workspace`;
    try {
      registration.update({ label, title });
    } catch (error) {
      fail("update the composer pill", error);
    }
  };

  const openTab = (agentId: string): void => {
    requestAgentFocus(agentId);
    if (isFocusSurfaceMounted()) {
      return;
    }
    try {
      client.openSurface(FOCUS_SURFACE_ID);
    } catch (error) {
      fail("open the tab", error);
    }
  };

  const scheduleOverview = (force = false): Promise<void> => {
    if (released) {
      return Promise.resolve();
    }
    if (overviewTask) {
      return overviewTask;
    }
    if (!force && Date.now() - lastOverviewAt < OVERVIEW_THROTTLE_MS) {
      return Promise.resolve();
    }
    lastOverviewAt = Date.now();
    overviewTask = (async () => {
      try {
        overview = (await client.rpc(overviewRpc, {})).agents;
        if (overviewRetry) {
          clearTimeout(overviewRetry);
          overviewRetry = null;
        }
      } catch (error) {
        lastOverviewAt = 0;
        fail("read session memory", error);
        if (!overviewRetry && !released) {
          overviewRetry = setTimeout(() => {
            overviewRetry = null;
            void scheduleOverview(true);
          }, OVERVIEW_RETRY_MS);
        }
      }
      for (const agentId of pills.keys()) {
        applyStatus(agentId);
      }
    })().then(
      () => {
        overviewTask = null;
      },
      () => {
        overviewTask = null;
      },
    );
    return overviewTask;
  };

  const drop = (agentId: string): void => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    signatures.delete(agentId);
  };

  const track = (entries: readonly AgentLike[]): void => {
    const live = new Set<string>();
    for (const agent of entries) {
      const id = text(agent?.id);
      const workspaceId = text(agent?.workspaceId);
      if (!id || !workspaceId || agent?.archivedAt != null) {
        continue;
      }
      live.add(id);
      try {
        register(id, workspaceId);
      } catch (error) {
        fail("register the composer pill", error);
      }
    }
    for (const id of [...pills.keys()]) {
      if (!live.has(id)) {
        drop(id);
      }
    }
  };

  const listAgents = async (): Promise<void> => {
    if (released || Date.now() - lastListedAt < REFRESH_THROTTLE_MS) {
      return;
    }
    lastListedAt = Date.now();
    try {
      const listed = (await client.paseo.agents.list({ page: { limit: AGENT_PAGE_LIMIT } } as never)) as {
        entries?: { agent?: AgentLike }[];
      };
      track((listed.entries ?? []).map((entry) => entry.agent ?? {}));
    } catch (error) {
      lastListedAt = 0;
      fail("list sessions for the composer pill", error);
    }
  };

  const createAgent = async (workspaceId: string): Promise<string | null> => {
    if (released || busy.has(workspaceId)) {
      return null;
    }
    busy.add(workspaceId);
    try {
      const config = await resolveNewAgentConfig(client.paseo, workspaceId);
      const handle = (await client.paseo.workspaces.ref(workspaceId).agents.create({ config })) as
        | { id?: unknown }
        | null;
      return text(handle?.id);
    } catch (error) {
      fail("create the session", error);
      return null;
    } finally {
      busy.delete(workspaceId);
    }
  };

  const press = async (workspaceId: string): Promise<void> => {
    if (released) {
      return;
    }
    if (triggerNewAgentShortcut() || (await openDraftDeepLink(client, workspaceId))) {
      return;
    }
    requestNewAgent(workspaceId, client.paseo);
    if (isFocusSurfaceMounted()) {
      return;
    }
    try {
      client.openSurface(FOCUS_SURFACE_ID);
    } catch (error) {
      fail("open the session redirect", error);
      consumeNewAgentRequest();
      await createAgent(workspaceId);
    }
  };

  void listAgents();
  void scheduleOverview(true);
  const stopAgents = client.paseo.agents.subscribe((update) => {
    const payload = update as { kind?: unknown; agent?: AgentLike | null; id?: unknown } | null;
    const agentId = text(payload?.agent?.id) ?? text(payload?.id);
    const workspaceId = text(payload?.agent?.workspaceId);
    if (!agentId) {
      void listAgents();
      return;
    }
    if (payload?.kind === "remove" || payload?.agent?.archivedAt != null || !workspaceId) {
      drop(agentId);
      return;
    }
    try {
      register(agentId, workspaceId);
      applyStatus(agentId);
    } catch (error) {
      fail("register the composer pill", error);
    }
  });

  return () => {
    released = true;
    if (overviewRetry) {
      clearTimeout(overviewRetry);
      overviewRetry = null;
    }
    stopAgents();
    for (const agentId of [...pills.keys()]) {
      drop(agentId);
    }
  };
}

interface WindowLike {
  KeyboardEvent?: new (type: string, init: Record<string, unknown>) => Event;
  navigator?: { platform?: unknown; userAgent?: unknown };
  dispatchEvent?: (event: Event) => boolean;
}

function triggerNewAgentShortcut(): boolean {
  const globals = globalThis as { window?: WindowLike; document?: { visibilityState?: string } };
  const win = globals.window;
  if (!win?.dispatchEvent || !globals.document || typeof win.KeyboardEvent !== "function") {
    return false;
  }
  if (globals.document.visibilityState !== undefined && globals.document.visibilityState !== "visible") {
    return false;
  }
  const platform = `${win.navigator?.platform ?? ""} ${win.navigator?.userAgent ?? ""}`;
  const mac = /mac/i.test(platform);
  const primary = mac
    ? { ctrlKey: false, metaKey: true, shiftKey: true }
    : { ctrlKey: true, metaKey: false, shiftKey: true };
  const secondary = mac
    ? { ctrlKey: true, metaKey: false, shiftKey: true }
    : { ctrlKey: false, metaKey: true, shiftKey: true };
  return dispatchShortcut(win, primary) || dispatchShortcut(win, secondary);
}

function dispatchShortcut(win: WindowLike, modifiers: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  const EventConstructor = win.KeyboardEvent;
  if (!EventConstructor) {
    return false;
  }
  const event = new EventConstructor("keydown", {
    key: "A",
    code: "KeyA",
    altKey: false,
    repeat: false,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...modifiers,
  });
  return win.dispatchEvent?.(event) === false;
}

export async function resolveNewAgentConfig(paseo: Paseo, workspaceId: string): Promise<AgentConfig> {
  const recent = await recentChoice(paseo, workspaceId);
  if (recent) {
    return recent;
  }
  const provider = await defaultProvider(paseo);
  const models = (await paseo.providers.listModels(provider)) as unknown as { models?: { id?: unknown }[] };
  const model = models.models?.map((entry) => text(entry?.id)).find((id): id is string => id !== null);
  if (!model) {
    throw new Error(`Provider "${provider}" lists no model`);
  }
  return { provider: `${provider}/${model}` };
}

async function recentChoice(paseo: Paseo, workspaceId: string): Promise<AgentConfig | null> {
  const listed = (await paseo.agents.list({
    filter: { workspaceId, includeArchived: true },
    page: { limit: 20 },
  } as never)) as unknown as { entries?: { agent?: AgentLike }[] };
  for (const entry of listed.entries ?? []) {
    const agent = entry?.agent;
    const provider = text(agent?.provider);
    const model = text(agent?.model);
    if (!provider || !model) {
      continue;
    }
    const modeId = text(agent?.currentModeId) ?? text(agent?.runtimeInfo?.modeId);
    const thinkingOptionId = text(agent?.thinkingOptionId) ?? text(agent?.runtimeInfo?.thinkingOptionId);
    return {
      provider: `${provider}/${model}`,
      ...(modeId ? { modeId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }
  return null;
}

async function defaultProvider(paseo: Paseo): Promise<string> {
  const available = (await paseo.providers.listAvailable()) as unknown as {
    providers?: { provider?: unknown; available?: unknown }[];
  };
  const found = (available.providers ?? []).find((entry) => entry?.available === true && text(entry.provider));
  const provider = text(found?.provider);
  if (!provider) {
    throw new Error("No provider is available on this host");
  }
  return provider;
}

let cachedServerId: string | null = null;

async function resolveServerId(client: PluginClientContext): Promise<string | null> {
  if (cachedServerId) {
    return cachedServerId;
  }
  try {
    const listed = (await client.rpc(workspacesRpc, {})) as { serverId?: unknown };
    cachedServerId = text(listed?.serverId);
    return cachedServerId;
  } catch {
    return null;
  }
}

async function openDraftDeepLink(client: PluginClientContext, workspaceId: string): Promise<boolean> {
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
    return false;
  }
  const link = (Linking ?? {}) as {
    canOpenURL?: (url: string) => Promise<boolean>;
    openURL?: (url: string) => Promise<unknown>;
  };
  if (typeof link.openURL !== "function") {
    return false;
  }
  const serverId = await resolveServerId(client);
  if (!serverId) {
    return false;
  }
  const draftId = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const url = `paseo:/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(workspaceId)}?open=${encodeURIComponent(`draft:${draftId}`)}`;
  try {
    if (typeof link.canOpenURL === "function" && !(await link.canOpenURL("paseo:"))) {
      return false;
    }
    await link.openURL(url);
    return true;
  } catch {
    return false;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

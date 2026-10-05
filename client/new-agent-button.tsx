import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

import { workspacesRpc } from "../shared/contracts";
import { agentDirectoryStore, type DirectoryAgent } from "./agent-directory";
import { WorkspacePillPanel } from "./composer-panel";
import { message } from "./format";
import {
  gitNoticeWarning,
  gitNoticesSnapshot,
  subscribeGitNotices,
} from "./git-notices";

const PILL_ID = "agent-workspace-pill";
const FOCUS_SURFACE_ID = "open-agent";
/** Host-supplied heading (a tooltip on desktop, the sheet title on a phone) until the name is known. */
const PILL_TITLE = "Tabs";
const LABEL_FALLBACK = "Tabs";
const PILL_ICON = "Layers";
const ERROR_TITLE_MS = 8000;

type Paseo = PluginClientContext["paseo"];

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

function requestAgentFocus(agentId: string): void {
  pendingFocus = agentId;
  emitRequest();
}

export function consumeAgentFocus(): string | null {
  const agentId = pendingFocus;
  pendingFocus = null;
  return agentId;
}

function requestNewAgent(workspaceId: string, paseo: Paseo): void {
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

function isFocusSurfaceMounted(): boolean {
  return mountedFocusSurfaces > 0;
}

interface AgentIndex {
  byId: Map<string, DirectoryAgent>;
  tabsByWorkspace: Map<string, DirectoryAgent[]>;
}

function indexAgents(): AgentIndex {
  const byId = new Map<string, DirectoryAgent>();
  const tabsByWorkspace = new Map<string, DirectoryAgent[]>();
  for (const agent of agentDirectoryStore.getSnapshot()) {
    byId.set(agent.id, agent);
    if (agent.archivedAt !== null || agent.parentAgentId !== null || !agent.workspaceId) {
      continue;
    }
    const list = tabsByWorkspace.get(agent.workspaceId);
    if (list) {
      list.push(agent);
    } else {
      tabsByWorkspace.set(agent.workspaceId, [agent]);
    }
  }
  return { byId, tabsByWorkspace };
}

export function contributeComposerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, ReturnType<PluginClientContext["addComposerPill"]>>();
  const busy = new Set<string>();
  let released = false;
  const signatures = new Map<string, string>();
  const workspaceNames = new Map<string, string>();
  const lookingUpNames = new Set<string>();

  // The host shows the button title as the sheet heading, so make it the workspace's own name
  // instead of a generic word. One lookup per workspace, then cached.
  const ensureWorkspaceName = (workspaceId: string): void => {
    if (workspaceNames.has(workspaceId) || lookingUpNames.has(workspaceId)) {
      return;
    }
    lookingUpNames.add(workspaceId);
    void Promise.resolve()
      .then(() => client.paseo.workspaces.ref(workspaceId).current())
      .then((workspace) => {
        const name = text(workspace?.title) ?? text(workspace?.name);
        if (name) {
          workspaceNames.set(workspaceId, name);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        lookingUpNames.delete(workspaceId);
        sync();
      });
  };

  const flash = (title: string): void => {
    for (const registration of pills.values()) {
      try {
        registration.update({ title });
      } catch {
        continue;
      }
    }
    setTimeout(() => {
      const index = indexAgents();
      for (const agentId of [...pills.keys()]) {
        signatures.delete(agentId);
        applyStatus(agentId, index);
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
    ensureWorkspaceName(workspaceId);
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
  };

  const applyStatus = (agentId: string, index?: AgentIndex): void => {
    const registration = pills.get(agentId);
    if (!registration) {
      return;
    }
    const resolved = index ?? indexAgents();
    const agent = resolved.byId.get(agentId);
    if (!agent?.workspaceId) {
      return;
    }
    const tabs = resolved.tabsByWorkspace.get(agent.workspaceId) ?? [];
    const running = tabs.filter((row) => row.status === "running").length;
    const gitWarning = gitNoticeWarning(gitNoticesSnapshot());
    const title = workspaceNames.get(agent.workspaceId) ?? PILL_TITLE;
    const signature = `${tabs.length}|${running}|${gitWarning ?? ""}|${title}`;
    if (signatures.get(agentId) === signature) {
      return;
    }
    signatures.set(agentId, signature);
    const count = tabs.length;
    const tabsWord = `${count} tab${count === 1 ? "" : "s"}`;
    const label = `${count === 0 ? LABEL_FALLBACK : tabsWord}${gitWarning ? " ⚠" : ""}`;
    void running;
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

  const drop = (agentId: string): void => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
    signatures.delete(agentId);
  };

  const sync = (): void => {
    if (released) {
      return;
    }
    const index = indexAgents();
    const live = new Set<string>();
    for (const agent of index.byId.values()) {
      if (agent.archivedAt !== null || !agent.workspaceId) {
        continue;
      }
      live.add(agent.id);
      try {
        register(agent.id, agent.workspaceId);
      } catch (error) {
        fail("register the composer pill", error);
      }
    }
    for (const id of [...pills.keys()]) {
      if (!live.has(id)) {
        drop(id);
      }
    }
    for (const id of [...pills.keys()]) {
      applyStatus(id, index);
    }
  };

  const unsubscribe = agentDirectoryStore.subscribe(sync);
  const unsubscribeNotices = subscribeGitNotices(sync);
  sync();

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

  return () => {
    released = true;
    unsubscribeNotices();
    unsubscribe();
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
  } as never)) as unknown as { entries?: { agent?: Record<string, unknown> }[] };
  for (const entry of listed.entries ?? []) {
    const agent = entry?.agent;
    const provider = text(agent?.provider);
    const model = text(agent?.model);
    if (!provider || !model) {
      continue;
    }
    const runtimeInfo = agent?.runtimeInfo as { modeId?: unknown; thinkingOptionId?: unknown } | undefined;
    const modeId = text(agent?.currentModeId) ?? text(runtimeInfo?.modeId);
    const thinkingOptionId = text(agent?.thinkingOptionId) ?? text(runtimeInfo?.thinkingOptionId);
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

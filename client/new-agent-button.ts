import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

import { workspacesRpc } from "../shared/contracts";
import { message } from "./format";

const PILL_ID = "new-agent-pill";
const PANEL_PILL_ID = "agent-manager-pill";
const PANEL_SURFACE_ID = "agent-manager";
const PANEL_TITLE = "Agent Manager";
const FOCUS_SURFACE_ID = "open-agent";
const TITLE = "New agent";
const PILL_LABEL = "\u200b";
const ICON = "Plus";
const PANEL_ICON = "Cpu";
const AGENT_PAGE_LIMIT = 200;
const REFRESH_THROTTLE_MS = 5000;
const ERROR_TITLE_MS = 8000;

type Paseo = PluginClientContext["paseo"];

interface AgentLike {
  id?: unknown;
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

let pendingRequest: { workspaceId: string; paseo: Paseo } | null = null;

export function consumeNewAgentRequest(): { workspaceId: string; paseo: Paseo } | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

export function contributeComposerPills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration[]>();
  const busy = new Set<string>();
  let released = false;
  let lastListedAt = 0;

  const flash = (title: string): void => {
    for (const registrations of pills.values()) {
      registrations[0]?.update({ title });
    }
    setTimeout(() => {
      for (const registrations of pills.values()) {
        registrations[0]?.update({ title: TITLE });
      }
    }, ERROR_TITLE_MS);
  };

  const openPanel = (): void => {
    try {
      client.openSurface(PANEL_SURFACE_ID);
    } catch (error) {
      fail("open the panel", error);
    }
  };

  const fail = (what: string, error: unknown): void => {
    console.log(`agent-manager could not ${what}: ${message(error)}`);
    if (what === "create the session") {
      flash(`${TITLE} — failed: ${message(error)}`);
    }
  };

  const register = (agentId: string, workspaceId: string): void => {
    if (released || pills.has(agentId)) {
      return;
    }
    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: TITLE,
        label: PILL_LABEL,
        icon: ICON,
        behavior: { kind: "action" as const, onPress: () => void press(workspaceId) },
      },
    });
    const panel = client.addComposerPill({
      id: PANEL_PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: PANEL_TITLE,
        label: PILL_LABEL,
        icon: PANEL_ICON,
        behavior: { kind: "action" as const, onPress: openPanel },
      },
    });
    pills.set(agentId, [registration, panel]);
  };

  const drop = (agentId: string): void => {
    for (const registration of pills.get(agentId) ?? []) {
      registration.remove();
    }
    pills.delete(agentId);
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
    pendingRequest = { workspaceId, paseo: client.paseo };
    try {
      client.openSurface(FOCUS_SURFACE_ID);
    } catch (error) {
      fail("open the session redirect", error);
      pendingRequest = null;
      await createAgent(workspaceId);
    }
  };

  void listAgents();
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
    } catch (error) {
      fail("register the composer pill", error);
    }
  });

  return () => {
    released = true;
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

import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

import { workspacesRpc } from "../shared/contracts";
import { message } from "./format";

const PILL_ID = "new-agent-pill";
const FOCUS_SURFACE_ID = "open-agent";

type Paseo = PluginClientContext["paseo"];
const TITLE = "New agent";
const PILL_LABEL = "\u200b";
const ICON = "Plus";
const AGENT_PAGE_LIMIT = 200;
const REFRESH_THROTTLE_MS = 5000;
const ERROR_TITLE_MS = 8000;

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

interface ButtonHolder {
  registration: PluginButtonRegistration | null;
}

interface RecentChoice {
  provider: string;
  model: string;
  modeId: string | null;
  thinkingOptionId: string | null;
}

interface AgentConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
}

let pendingRequest: NewAgentRequest | null = null;

export interface NewAgentRequest {
  workspaceId: string;
  paseo: Paseo;
}

export function consumeNewAgentRequest(): NewAgentRequest | null {
  const request = pendingRequest;
  pendingRequest = null;
  return request;
}

interface WindowLike {
  KeyboardEvent?: new (type: string, init: Record<string, unknown>) => Event;
  navigator?: { platform?: unknown; userAgent?: unknown };
  dispatchEvent?: (event: Event) => boolean;
}

interface DocumentLike {
  visibilityState?: string;
}

export function contributeNewAgentButtons(client: PluginClientContext): () => void {
  const pills = new Map<string, ButtonHolder>();
  const busy = new Set<string>();
  let released = false;
  let listingAgents = false;
  let lastAgentList = 0;

  const registerPill = (agentId: string, workspaceId: string): void => {
    if (released || pills.has(agentId)) {
      return;
    }
    const holder: ButtonHolder = { registration: null };
    holder.registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId,
      button: {
        title: TITLE,
        label: PILL_LABEL,
        icon: ICON,
        behavior: { kind: "action" as const, onPress: () => press(workspaceId) },
      },
    });
    pills.set(agentId, holder);
  };

  const drop = (map: Map<string, ButtonHolder>, key: string): void => {
    const holder = map.get(key);
    if (!holder) {
      return;
    }
    holder.registration?.remove();
    map.delete(key);
  };

  const dropAll = (map: Map<string, ButtonHolder>): void => {
    for (const key of [...map.keys()]) {
      drop(map, key);
    }
  };

  const syncAgents = (entries: readonly { id?: unknown; workspaceId?: unknown; archivedAt?: unknown }[]): void => {
    const known = new Set<string>();
    for (const entry of entries) {
      const id = text(entry?.id);
      const workspaceId = text(entry?.workspaceId);
      if (!id || !workspaceId || entry?.archivedAt != null) {
        continue;
      }
      known.add(id);
      guarded(() => registerPill(id, workspaceId));
    }
    for (const id of [...pills.keys()]) {
      if (!known.has(id)) {
        drop(pills, id);
      }
    }
  };

  const refreshAgents = async (): Promise<void> => {
    if (released || listingAgents || Date.now() - lastAgentList < REFRESH_THROTTLE_MS) {
      return;
    }
    listingAgents = true;
    lastAgentList = Date.now();
    try {
      const listed = await client.paseo.agents.list({ page: { limit: AGENT_PAGE_LIMIT } } as never);
      const entries = (listed as unknown as { entries?: { agent?: AgentLike }[] }).entries ?? [];
      syncAgents(entries.map((entry) => entry.agent ?? {}));
    } catch (error) {
      lastAgentList = 0;
      report("composer pill", error);
    } finally {
      listingAgents = false;
    }
  };

  const applyAgentUpdate = (update: unknown): void => {
    const payload = update as { kind?: unknown; agent?: AgentLike | null; id?: unknown } | null;
    const agent = payload?.agent ?? null;
    const agentId = text(agent?.id) ?? text(payload?.id);
    if (!agentId) {
      void refreshAgents();
      return;
    }
    const workspaceId = text(agent?.workspaceId);
    if (payload?.kind === "remove" || agent?.archivedAt != null || !workspaceId) {
      drop(pills, agentId);
      return;
    }
    guarded(() => registerPill(agentId, workspaceId));
  };

  const createAgent = async (workspaceId: string): Promise<string | null> => {
    if (busy.has(workspaceId) || released) {
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
      report("new agent", error);
      flash(`${TITLE} — failed: ${message(error)}`);
      return null;
    } finally {
      busy.delete(workspaceId);
    }
  };

  const press = async (workspaceId: string): Promise<void> => {
    if (released) {
      return;
    }
    if (triggerNewAgentShortcut()) {
      return;
    }
    if (await openDraftDeepLink(client, workspaceId)) {
      return;
    }
    pendingRequest = { workspaceId, paseo: client.paseo };
    try {
      client.openSurface(FOCUS_SURFACE_ID);
    } catch (error) {
      report("the session redirect", error);
      pendingRequest = null;
      await createAgent(workspaceId);
    }
  };

  const flash = (title: string): void => {
    for (const holder of pills.values()) {
      holder.registration?.update({ title });
    }
    setTimeout(() => {
      for (const holder of pills.values()) {
        holder.registration?.update({ title: TITLE });
      }
    }, ERROR_TITLE_MS);
  };

  const guarded = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      report("button registration", error);
    }
  };

  void refreshAgents();
  const stopAgents = client.paseo.agents.subscribe((update) => applyAgentUpdate(update));

  return () => {
    released = true;
    stopAgents();
    dropAll(pills);
  };
}

function report(what: string, error: unknown): void {
  console.log(`agent-manager could not register ${what}: ${message(error)}`);
}

function triggerNewAgentShortcut(): boolean {
  const globals = globalThis as { window?: WindowLike; document?: DocumentLike };
  const win = globals.window;
  const doc = globals.document;
  if (!win?.dispatchEvent || !doc || typeof win.KeyboardEvent !== "function") {
    return false;
  }
  if (doc.visibilityState !== undefined && doc.visibilityState !== "visible") {
    return false;
  }
  const agent = `${win.navigator?.platform ?? ""} ${win.navigator?.userAgent ?? ""}`;
  const mac = /mac/i.test(agent);
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
    return {
      provider: `${recent.provider}/${recent.model}`,
      ...(recent.modeId ? { modeId: recent.modeId } : {}),
      ...(recent.thinkingOptionId ? { thinkingOptionId: recent.thinkingOptionId } : {}),
    };
  }

  const provider = await defaultProvider(paseo);
  const models = (await paseo.providers.listModels(provider)) as unknown as {
    models?: { id?: unknown }[];
  };
  const model = models.models?.map((entry) => text(entry?.id)).find((id): id is string => id !== null);
  if (!model) {
    throw new Error(`Provider "${provider}" lists no model`);
  }
  return { provider: `${provider}/${model}` };
}

async function recentChoice(paseo: Paseo, workspaceId: string): Promise<RecentChoice | null> {
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
    return {
      provider,
      model,
      modeId: text(agent?.currentModeId) ?? text(agent?.runtimeInfo?.modeId),
      thinkingOptionId: text(agent?.thinkingOptionId) ?? text(agent?.runtimeInfo?.thinkingOptionId),
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
    const serverId = text(listed?.serverId);
    if (serverId) {
      cachedServerId = serverId;
    }
    return serverId;
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
  const intent = encodeURIComponent(`draft:${draftId}`);
  const url = `paseo:/h/${encodeURIComponent(serverId)}/workspace/${encodeURIComponent(workspaceId)}?open=${intent}`;
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

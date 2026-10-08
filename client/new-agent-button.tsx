import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Linking } from "react-native";

import { workspacesRpc } from "../shared/contracts";
import { agentDirectoryStore, type DirectoryAgent } from "./agent-directory";
import { WorkspacePillPanel } from "./composer-panel";

const PILL_ID = "agent-workspace-pill";
/** The screen that performs a tab switch or a new-agent creation. */
export const OPEN_AGENT_SCREEN_ID = "open-agent";
/** The pill's fixed heading. The label carries the count, so this never changes. */
const PILL_TITLE = "Tabs";
const LABEL_FALLBACK = "Tabs";
const PILL_ICON = "Layers";

type Paseo = PluginClientContext["paseo"];

export interface AgentConfig {
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
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
  let released = false;
  const signatures = new Map<string, string>();

  const fail = (what: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.log(`agent-manager could not ${what}: ${detail}`);
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
    const title = PILL_TITLE;
    const signature = `${tabs.length}|${title}`;
    if (signatures.get(agentId) === signature) {
      return;
    }
    signatures.set(agentId, signature);
    const count = tabs.length;
    const tabsWord = `${count} tab${count === 1 ? "" : "s"}`;
    const label = count === 0 ? LABEL_FALLBACK : tabsWord;
    try {
      registration.update({ label, title });
    } catch (error) {
      fail("update the composer pill", error);
    }
  };

  /**
   * Switch tabs by opening a screen whose URL carries the agent id. The screen reads the id from
   * its params and calls the client's own `navigation.openAgent`, so there is no cross-mount state
   * and a second pick before the first navigation lands cannot be lost.
   */
  const openTab = (agentId: string): void => {
    try {
      client.openScreen({ screenId: OPEN_AGENT_SCREEN_ID, params: { agentId } });
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

  const unsubscribeAgents = agentDirectoryStore.subscribe(sync);
  sync();

  /**
   * New agent: keep the two native fast paths (the app's own shortcut and its `paseo:` draft deep
   * link) and otherwise hand off to the screen, which creates the session through the SDK.
   */
  const press = async (workspaceId: string): Promise<void> => {
    if (released) {
      return;
    }
    if (triggerNewAgentShortcut() || (await openDraftDeepLink(client, workspaceId))) {
      return;
    }
    try {
      client.openScreen({
        screenId: OPEN_AGENT_SCREEN_ID,
        // The nonce makes a second press on the same workspace a new params object, so the screen
        // runs its creation effect again instead of keeping the previous run's result.
        params: {
          workspaceId,
          nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        },
      });
    } catch (error) {
      fail("open the new-agent screen", error);
    }
  };

  return () => {
    released = true;
    unsubscribeAgents();
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

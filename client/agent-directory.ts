import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const PAGE_LIMIT = 200;
const RETRY_MS = 4000;

export interface DirectoryAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  archivedAt: string | null;
  archived: boolean;
  status: string;
  attentionReason: string | null;
  title: string | null;
  provider: string | null;
  model: string | null;
  cwd: string | null;
  labels: Record<string, string>;
  createdAt: string | null;
  updatedAt: string | null;
  lastUserMessageAt: string | null;
}

interface AgentDirectoryStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly DirectoryAgent[];
}

interface AgentLike {
  id?: unknown;
  workspaceId?: unknown;
  archivedAt?: unknown;
  status?: unknown;
  attentionReason?: unknown;
  title?: unknown;
  provider?: unknown;
  model?: unknown;
  cwd?: unknown;
  labels?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  lastUserMessageAt?: unknown;
}

interface AgentUpdate {
  kind?: unknown;
  agent?: AgentLike | null;
  agentId?: unknown;
}

interface SubscriptionLike {
  subscribe(observer: {
    snapshot: (snapshot: unknown) => void;
    update: (message: unknown) => void;
    error: (error: unknown) => void;
  }): void;
  release(): Promise<void>;
}

interface ListPage {
  entries?: Array<{ agent?: AgentLike }>;
  pageInfo?: { hasMore?: unknown; hasMoreAfter?: unknown; nextCursor?: unknown; afterCursor?: unknown };
  subscription?: SubscriptionLike;
}

const agents = new Map<string, DirectoryAgent>();
let snapshot: readonly DirectoryAgent[] = [];
const listeners = new Set<() => void>();
let stopDirectory: (() => void) | null = null;

export const agentDirectoryStore: AgentDirectoryStore = {
  subscribe: (listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
};

export function useAgentDirectory(): readonly DirectoryAgent[] {
  return useSyncExternalStore(agentDirectoryStore.subscribe, agentDirectoryStore.getSnapshot);
}

export function startAgentDirectory(client: PluginClientContext): () => void {
  if (stopDirectory) {
    return stopDirectory;
  }
  const lifetime = new AbortController();
  let released = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let subscription: SubscriptionLike | null = null;

  const publish = (): void => {
    snapshot = [...agents.values()];
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const upsert = (raw: AgentLike | null | undefined): void => {
    const id = text(raw?.id);
    if (!id) {
      return;
    }
    agents.set(id, {
      id,
      workspaceId: text(raw?.workspaceId),
      parentAgentId: parentAgentIdFromLabels(raw?.labels),
      archivedAt: text(raw?.archivedAt),
      archived: text(raw?.archivedAt) !== null,
      status: text(raw?.status) ?? "unknown",
      attentionReason: text(raw?.attentionReason),
      title: text(raw?.title),
      provider: text(raw?.provider),
      model: text(raw?.model),
      cwd: text(raw?.cwd),
      labels: stringMap(raw?.labels),
      createdAt: text(raw?.createdAt),
      updatedAt: text(raw?.updatedAt),
      lastUserMessageAt: text(raw?.lastUserMessageAt),
    });
  };

  const applyUpdate = (payload: AgentUpdate | null): void => {
    if (!payload) {
      return;
    }
    if (payload.kind === "remove") {
      const id = text(payload.agentId);
      if (id) {
        agents.delete(id);
      }
      return;
    }
    upsert(payload.agent);
  };

  const applyPage = (page: ListPage | null): void => {
    for (const entry of page?.entries ?? []) {
      upsert(entry?.agent);
    }
  };

  const scheduleRetry = (): void => {
    if (released || retry) {
      return;
    }
    retry = setTimeout(() => {
      retry = null;
      void load();
    }, RETRY_MS);
  };

  const load = async (): Promise<void> => {
    if (released) {
      return;
    }
    try {
      const first = (await client.paseo.agents.list({
        subscribe: {},
        filter: { includeArchived: true },
        page: { limit: PAGE_LIMIT },
        signal: lifetime.signal,
      } as never)) as unknown as ListPage;
      const nextSubscription = first.subscription;
      if (!nextSubscription) {
        throw new Error("The daemon did not return an agent subscription");
      }
      if (released) {
        await nextSubscription.release().catch(() => undefined);
        return;
      }
      subscription = nextSubscription;
      const buffered: AgentUpdate[] = [];
      let seeding = true;
      nextSubscription.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (released) {
            return;
          }
          const payload = (message as { type?: unknown; payload?: unknown })?.payload as AgentUpdate | null;
          if (!payload) {
            return;
          }
          if (seeding) {
            buffered.push(payload);
            return;
          }
          applyUpdate(payload);
          publish();
        },
        error: () => {
          scheduleRetry();
        },
      });
      applyPage(first);
      let cursor = nextCursor(first.pageInfo);
      while (cursor) {
        const page = (await client.paseo.agents.list({
          filter: { includeArchived: true },
          page: { limit: PAGE_LIMIT, cursor },
          signal: lifetime.signal,
        } as never)) as unknown as ListPage;
        applyPage(page);
        cursor = nextCursor(page.pageInfo);
      }
      seeding = false;
      for (const payload of buffered) {
        applyUpdate(payload);
      }
      publish();
    } catch {
      scheduleRetry();
    }
  };

  void load();

  stopDirectory = () => {
    released = true;
    stopDirectory = null;
    lifetime.abort();
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    void subscription?.release().catch(() => undefined);
    subscription = null;
  };
  return stopDirectory;
}

function nextCursor(pageInfo: ListPage["pageInfo"]): string | null {
  const hasMore = pageInfo?.hasMore === true || pageInfo?.hasMoreAfter === true;
  if (!hasMore) {
    return null;
  }
  return text(pageInfo?.nextCursor) ?? text(pageInfo?.afterCursor);
}

function parentAgentIdFromLabels(labels: unknown): string | null {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    return null;
  }
  return text((labels as Record<string, unknown>)[PARENT_AGENT_ID_LABEL]);
}

function stringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const item = text(entry);
    if (item !== null) {
      out[key] = item;
    }
  }
  return out;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

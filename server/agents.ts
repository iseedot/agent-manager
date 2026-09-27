import { str } from "./util";

export interface AgentRecord {
  id: string;
  title: string | null;
  status: string;
  archivedAt: string | null;
  workspaceId: string | null;
  parentAgentId: string | null;
  updatedAt: string | null;
  requiresAttention: boolean;
  cwd: string | null;
}

export interface AgentPage {
  entries?: unknown;
  pageInfo?: unknown;
}

export type AgentLister = (options: Record<string, unknown>) => Promise<AgentPage>;

interface RawAgent {
  id?: unknown;
  title?: unknown;
  status?: unknown;
  archivedAt?: unknown;
  workspaceId?: unknown;
  parentAgentId?: unknown;
  updatedAt?: unknown;
  requiresAttention?: unknown;
  cwd?: unknown;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

export async function listAllAgents(list: AgentLister): Promise<AgentRecord[]> {
  const agents: AgentRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await list({
      filter: { includeArchived: true },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: cursor ? { limit: PAGE_SIZE, cursor } : { limit: PAGE_SIZE },
    });
    const batch = Array.isArray(result?.entries) ? result.entries : [];
    for (const entry of batch) {
      const record = toAgentRecord((entry as { agent?: RawAgent })?.agent);
      if (record) {
        agents.push(record);
      }
    }
    const next = nextCursor(result?.pageInfo);
    if (!next || batch.length === 0) {
      break;
    }
    cursor = next;
  }
  return agents;
}

function toAgentRecord(raw: RawAgent | undefined): AgentRecord | null {
  const id = str(raw?.id);
  if (!raw || !id) {
    return null;
  }
  return {
    id,
    title: str(raw.title),
    status: str(raw.status) ?? "unknown",
    archivedAt: str(raw.archivedAt),
    workspaceId: str(raw.workspaceId),
    parentAgentId: str(raw.parentAgentId),
    updatedAt: str(raw.updatedAt),
    requiresAttention: raw.requiresAttention === true,
    cwd: str(raw.cwd),
  };
}

function nextCursor(pageInfo: unknown): string | undefined {
  if (!pageInfo || typeof pageInfo !== "object") {
    return undefined;
  }
  const cursor = (pageInfo as { nextCursor?: unknown; hasMore?: unknown }).nextCursor;
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

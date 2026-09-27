import type { AgentRow } from "../shared/contracts";
import { isCliAvailable } from "./cli";
import { resolveMcpEndpoint } from "./daemon-mcp";
import { scanAgentProcesses } from "./processes";

interface RawPlacement {
  workspaceName?: unknown;
  projectName?: unknown;
}

interface RawAgent {
  id?: unknown;
  shortId?: unknown;
  title?: unknown;
  provider?: unknown;
  model?: unknown;
  status?: unknown;
  archivedAt?: unknown;
  workspaceId?: unknown;
  cwd?: unknown;
  updatedAt?: unknown;
}

export interface OverviewResult {
  agents: AgentRow[];
  totals: {
    total: number;
    holdingProcess: number;
    closed: number;
    archived: number;
    rssBytes: number;
  };
  endpoint: string | null;
  cliAvailable: boolean;
  warning: string | null;
}

export interface PaseoLike {
  agents: { list(options?: unknown): Promise<{ entries?: unknown }> };
}

export async function buildOverview(paseo: PaseoLike): Promise<OverviewResult> {
  const agentPage = await paseo.agents.list({
    filter: { includeArchived: true },
    sort: [{ key: "updated_at", direction: "desc" }],
    page: { limit: 200 },
  });

  const entries = asArray(agentPage?.entries);
  const agents: AgentRow[] = [];

  for (const entry of entries) {
    const raw = (entry as { agent?: unknown }).agent as RawAgent | undefined;
    const placement = (entry as { project?: unknown }).project as RawPlacement | undefined;
    const id = str(raw?.id);
    if (!raw || !id) {
      continue;
    }
    const workspaceId = str(raw.workspaceId);
    const status = str(raw.status) ?? "unknown";
    agents.push({
      id,
      shortId: str(raw.shortId) ?? id.slice(0, 7),
      title: str(raw.title) ?? "(untitled)",
      provider: str(raw.provider) ?? "unknown",
      model: str(raw.model),
      status,
      archived: Boolean(str(raw.archivedAt)),
      workspaceId,
      workspaceName: str(placement?.workspaceName) ?? str(placement?.projectName),
      cwd: str(raw.cwd) ?? "",
      updatedAt: str(raw.updatedAt),
      pid: null,
      rssBytes: null,
      processCommand: null,
      isDaemonChild: null,
    });
  }

  const [processes, cliAvailable] = await Promise.all([
    scanAgentProcesses().catch(() => new Map<string, never>()),
    isCliAvailable().catch(() => false),
  ]);

  for (const agent of agents) {
    const process = processes.get(agent.id);
    if (!process) {
      continue;
    }
    agent.pid = process.pid;
    agent.rssBytes = process.rssBytes;
    agent.processCommand = process.command;
    agent.isDaemonChild = process.isDaemonChild;
  }

  agents.sort(compareRows);

  let holdingProcess = 0;
  let closed = 0;
  let archived = 0;
  let rssBytes = 0;
  let anyOpen = false;
  for (const agent of agents) {
    if (agent.pid !== null) {
      holdingProcess += 1;
      rssBytes += agent.rssBytes ?? 0;
    }
    if (agent.status === "closed") {
      closed += 1;
    } else {
      anyOpen = true;
    }
    if (agent.archived) {
      archived += 1;
    }
  }

  return {
    agents,
    totals: { total: agents.length, holdingProcess, closed, archived, rssBytes },
    endpoint: await resolveMcpEndpoint().catch(() => null),
    cliAvailable,
    warning:
      holdingProcess === 0 && anyOpen
        ? "No process carrying PASEO_AGENT_ID was found. Process and memory columns need a Linux host."
        : null,
  };
}

function compareRows(left: AgentRow, right: AgentRow): number {
  const leftLive = left.pid === null ? 1 : 0;
  const rightLive = right.pid === null ? 1 : 0;
  if (leftLive !== rightLive) {
    return leftLive - rightLive;
  }
  if ((right.rssBytes ?? 0) !== (left.rssBytes ?? 0)) {
    return (right.rssBytes ?? 0) - (left.rssBytes ?? 0);
  }
  return (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

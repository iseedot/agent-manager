import type { AgentRow } from "../shared/contracts";
import { listAllAgents, type AgentLister } from "./agents";
import { scanAgentProcesses } from "./processes";

export interface OverviewResult {
  agents: AgentRow[];
  totals: {
    total: number;
    holdingProcess: number;
    closed: number;
    archived: number;
    rssBytes: number;
  };
  warning: string | null;
}

export interface PaseoLike {
  agents: { list(options?: unknown): Promise<{ entries?: unknown; pageInfo?: unknown }> };
}

export async function buildOverview(paseo: PaseoLike): Promise<OverviewResult> {
  const records = await listAllAgents(paseo.agents.list as unknown as AgentLister);
  const agents: AgentRow[] = records.map((record) => ({
    id: record.id,
    status: record.status,
    archived: record.archivedAt !== null,
    workspaceId: record.workspaceId,
    pid: null,
    rssBytes: null,
  }));

  const processes = await scanAgentProcesses().catch(() => new Map<string, never>());

  let holdingProcess = 0;
  let closed = 0;
  let archived = 0;
  let rssBytes = 0;
  let anyOpen = false;
  for (const agent of agents) {
    const process = processes.get(agent.id);
    if (process) {
      agent.pid = process.pid;
      agent.rssBytes = process.rssBytes;
      holdingProcess += 1;
      rssBytes += process.rssBytes;
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
    warning:
      holdingProcess === 0 && anyOpen
        ? "No runtime process was found for any live session. Process tracking needs a Linux host where the daemon spawns agent runtimes as its own children."
        : null,
  };
}

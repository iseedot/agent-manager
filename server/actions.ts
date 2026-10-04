import { deleteAgentViaCli } from "./cli";
import { killAgentViaDaemonMcp } from "./daemon-mcp";
import { describe } from "./util";

interface ReleaseOutcome {
  released: string[];
  failed: Array<{ agentId: string; error: string }>;
}

export async function releaseAgents(agentIds: string[]): Promise<ReleaseOutcome> {
  const released: string[] = [];
  const failed: ReleaseOutcome["failed"] = [];
  for (const agentId of agentIds) {
    try {
      await killAgentViaDaemonMcp(agentId);
      released.push(agentId);
    } catch (error) {
      failed.push({ agentId, error: describe(error) });
    }
  }
  return { released, failed };
}

export interface DeleteAgentsOutcome {
  deleted: string[];
  failed: Array<{ agentId: string; error: string }>;
}

export async function deleteAgents(agentIds: string[]): Promise<DeleteAgentsOutcome> {
  const deleted: string[] = [];
  const failed: DeleteAgentsOutcome["failed"] = [];

  for (const agentId of agentIds) {
    const result = await deleteAgentViaCli(agentId);
    if (result.ok) {
      deleted.push(agentId);
    } else {
      failed.push({ agentId, error: result.output || "Delete failed" });
    }
  }

  return { deleted, failed };
}

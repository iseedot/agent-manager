import { deleteAgentViaCli } from "./cli";
import { killAgentViaDaemonMcp } from "./daemon-mcp";
import { scanAgentProcesses } from "./processes";
import type { PaseoLike } from "./overview";

export interface ReleaseOutcome {
  ok: boolean;
  message: string;
  freedBytes: number | null;
}

export interface BatchOutcome {
  succeeded: string[];
  failed: Array<{ agentId: string; error: string }>;
}

export interface PaseoAgentControl extends PaseoLike {
  agents: PaseoLike["agents"] & {
    ref(agentId: string): { archive(): Promise<{ archivedAt: string }> };
  };
}

export async function releaseAgent(
  agentId: string,
  options: { allowSignalFallback: boolean },
): Promise<ReleaseOutcome> {
  const before = await scanAgentProcesses().catch(() => new Map());
  const target = before.get(agentId);
  if (!target) {
    return { ok: true, message: "No runtime process to release.", freedBytes: null };
  }

  try {
    await killAgentViaDaemonMcp(agentId);
  } catch (error) {
    const reason = describe(error);
    if (!options.allowSignalFallback) {
      return { ok: false, message: reason, freedBytes: null };
    }
    if (!target.isDaemonChild) {
      return {
        ok: false,
        message: `${reason} The matched pid ${target.pid} is not a daemon child, so no signal was sent.`,
        freedBytes: null,
      };
    }
    return signalFallback(agentId, target.pid, target.rssBytes, reason);
  }

  const gone = await waitForProcessExit(target.pid);
  if (!gone) {
    return { ok: false, message: "The daemon accepted kill_agent but the process is still running.", freedBytes: null };
  }
  return {
    ok: true,
    message: `Released pid ${target.pid}. The session stays in its workspace as closed.`,
    freedBytes: target.rssBytes,
  };
}

export async function releaseAgents(
  agentIds: string[],
  options: { allowSignalFallback: boolean },
): Promise<{ released: string[]; failed: BatchOutcome["failed"]; freedBytes: number }> {
  const released: string[] = [];
  const failed: BatchOutcome["failed"] = [];
  let freedBytes = 0;

  for (const agentId of agentIds) {
    const outcome = await releaseAgent(agentId, options);
    if (outcome.ok) {
      released.push(agentId);
      freedBytes += outcome.freedBytes ?? 0;
    } else {
      failed.push({ agentId, error: outcome.message });
    }
  }

  return { released, failed, freedBytes };
}

export async function archiveAgents(
  paseo: PaseoAgentControl,
  agentIds: string[],
): Promise<BatchOutcome> {
  const succeeded: string[] = [];
  const failed: BatchOutcome["failed"] = [];

  for (const agentId of agentIds) {
    try {
      await paseo.agents.ref(agentId).archive();
      succeeded.push(agentId);
    } catch (error) {
      failed.push({ agentId, error: describe(error) });
    }
  }

  return { succeeded, failed };
}

export async function deleteAgents(agentIds: string[]): Promise<BatchOutcome> {
  const succeeded: string[] = [];
  const failed: BatchOutcome["failed"] = [];

  for (const agentId of agentIds) {
    const result = await deleteAgentViaCli(agentId);
    if (result.ok) {
      succeeded.push(agentId);
    } else {
      failed.push({ agentId, error: result.output || "Delete failed" });
    }
  }

  return { succeeded, failed };
}

async function signalFallback(
  agentId: string,
  pid: number,
  rssBytes: number,
  reason: string,
): Promise<ReleaseOutcome> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, message: `${reason} SIGTERM failed: ${describe(error)}`, freedBytes: null };
  }
  const gone = await waitForProcessExit(pid);
  return {
    ok: gone,
    message: gone
      ? `Sent SIGTERM to pid ${pid}. The daemon may still report the agent as idle until it is reloaded (paseo agent reload ${agentId.slice(0, 7)}). Reason: ${reason}`
      : `SIGTERM was sent but pid ${pid} is still running. Reason: ${reason}`,
    freedBytes: gone ? rssBytes : null,
  };
}

async function waitForProcessExit(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isRunning(pid)) {
      return true;
    }
    await delay(100);
  }
  return !isRunning(pid);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { DeleteAgentsOutcome, ReleaseOutcome } from "../shared/contracts";
import { deleteAgentViaCli } from "./cli";
import { killAgentViaDaemonMcp } from "./daemon-mcp";
import { scanAgentProcesses, scanAgentProcessesFresh, type AgentProcessInfo } from "./processes";
import { describe, readProcStatSync } from "./util";

interface KillAttempt {
  error: string | null;
  note: string | null;
}

export async function releaseAgents(
  agentIds: string[],
  options: { allowSignalFallback: boolean },
): Promise<ReleaseOutcome> {
  const before = await scanAgentProcessesFresh().catch(() => new Map<string, AgentProcessInfo>());
  const released: string[] = [];
  const failed: ReleaseOutcome["failed"] = [];
  const pending: Array<{ agentId: string; pid: number; rssBytes: number }> = [];

  for (const agentId of agentIds) {
    const target = before.get(agentId);
    if (!target) {
      released.push(agentId);
      continue;
    }
    const attempt = await killOrSignal(agentId, target, options.allowSignalFallback);
    if (attempt.error) {
      failed.push({ agentId, error: attempt.error });
      continue;
    }
    pending.push({ agentId, pid: target.pid, rssBytes: target.rssBytes });
  }

  const exited = await waitForProcessesExit(pending.map((entry) => entry.pid));
  const remaining = await scanAgentProcessesFresh().catch(() => new Map<string, AgentProcessInfo>());
  let freedBytes = 0;
  for (const entry of pending) {
    if (exited.has(entry.pid) || !remaining.has(entry.agentId)) {
      released.push(entry.agentId);
      freedBytes += entry.rssBytes;
    } else {
      failed.push({ agentId: entry.agentId, error: STILL_RUNNING });
    }
  }

  return { released, failed, freedBytes };
}

export async function deleteAgents(agentIds: string[]): Promise<Omit<DeleteAgentsOutcome, "message">> {
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

const STILL_RUNNING = "The daemon accepted kill_agent but the runtime process is still alive.";

async function killOrSignal(
  agentId: string,
  target: AgentProcessInfo,
  allowSignalFallback: boolean,
): Promise<KillAttempt> {
  try {
    await killAgentViaDaemonMcp(agentId);
    return { error: null, note: null };
  } catch (error) {
    const reason = describe(error);
    if (!allowSignalFallback || !target.isDaemonChild) {
      return { error: reason, note: null };
    }
    const outcome = await signalFallback(agentId, target.pid, reason);
    return outcome.ok ? { error: null, note: outcome.message } : { error: outcome.message, note: null };
  }
}

async function signalFallback(
  agentId: string,
  pid: number,
  reason: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return { ok: false, message: `${reason} SIGTERM failed: ${describe(error)}` };
  }
  const exited = await waitForProcessesExit([pid]);
  return exited.has(pid)
    ? {
        ok: true,
        message: `Sent SIGTERM to pid ${pid}. The daemon may still report the session as idle until it is reloaded (paseo agent reload ${agentId.slice(0, 7)}). Reason: ${reason}`,
      }
    : { ok: false, message: `SIGTERM was sent but pid ${pid} is still running. Reason: ${reason}` };
}

async function waitForProcessesExit(pids: number[], timeoutMs = 3000): Promise<Set<number>> {
  const remaining = new Set(pids);
  const deadline = Date.now() + timeoutMs;
  while (remaining.size > 0 && Date.now() < deadline) {
    for (const pid of remaining) {
      if (!isRunning(pid)) {
        remaining.delete(pid);
      }
    }
    if (remaining.size > 0) {
      await delay(100);
    }
  }
  const exited = new Set(pids);
  for (const pid of remaining) {
    exited.delete(pid);
  }
  return exited;
}

function isRunning(pid: number): boolean {
  const stat = readProcStatSync(pid);
  if (stat) {
    return stat.state !== "Z" && stat.state !== "X";
  }
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

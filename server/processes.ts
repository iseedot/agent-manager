import { readFile, readdir } from "node:fs/promises";

export interface AgentProcessInfo {
  pid: number;
  rssBytes: number;
  command: string;
  isDaemonChild: boolean;
}

const PAGE_SIZE_BYTES = 4096;

interface ProcessStat {
  ppid: number;
  startTimeTicks: number;
}

interface Candidate {
  agentId: string;
  pid: number;
  ppid: number;
  startTimeTicks: number;
  rssBytes: number;
  command: string;
}

export async function scanAgentProcesses(
  expectedAgentIds: Iterable<string> = [],
): Promise<Map<string, AgentProcessInfo>> {
  const found = new Map<string, AgentProcessInfo>();
  if (process.platform !== "linux") {
    return found;
  }

  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return found;
  }

  const pids = entries.filter((name) => /^\d+$/.test(name)).map(Number);
  const daemonPid = process.ppid;
  const stats = new Map<number, ProcessStat>();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readStat(pid);
      if (stat) {
        stats.set(pid, stat);
      }
    }),
  );

  const daemonChildren = pids.filter((pid) => stats.get(pid)?.ppid === daemonPid);
  collect(await readCandidates(daemonChildren, stats), found);

  const missing = [...expectedAgentIds].filter((agentId) => !found.has(agentId));
  if (missing.length > 0) {
    const childSet = new Set(daemonChildren);
    const rest = pids.filter((pid) => !childSet.has(pid));
    const candidates = await readCandidates(rest, stats);
    collect(
      candidates.filter((candidate) => missing.includes(candidate.agentId)),
      found,
    );
  }

  return found;
}

function collect(candidates: Candidate[], found: Map<string, AgentProcessInfo>): void {
  const byAgent = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byAgent.get(candidate.agentId);
    if (list) {
      list.push(candidate);
    } else {
      byAgent.set(candidate.agentId, [candidate]);
    }
  }

  for (const [agentId, group] of byAgent) {
    const existing = found.get(agentId);
    const winner = group.reduce((best, candidate) =>
      candidate.startTimeTicks < best.startTimeTicks ? candidate : best,
    );
    if (existing && existing.pid === winner.pid) {
      continue;
    }
    found.set(agentId, {
      pid: winner.pid,
      rssBytes: winner.rssBytes,
      command: winner.command,
      isDaemonChild: winner.ppid === process.ppid,
    });
  }
}

async function readCandidates(
  pids: number[],
  stats: Map<number, ProcessStat>,
): Promise<Candidate[]> {
  const candidates = await Promise.all(
    pids.map(async (pid) => {
      const stat = stats.get(pid);
      if (!stat) {
        return null;
      }
      const agentId = await readAgentId(pid);
      if (!agentId) {
        return null;
      }
      return {
        agentId,
        pid,
        ppid: stat.ppid,
        startTimeTicks: stat.startTimeTicks,
        rssBytes: await readResidentBytes(pid),
        command: await readCommand(pid),
      } satisfies Candidate;
    }),
  );
  return candidates.filter((candidate): candidate is Candidate => candidate !== null);
}

async function readStat(pid: number): Promise<ProcessStat | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close < 0) {
      return null;
    }
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    const ppid = Number(fields[1]);
    const startTimeTicks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(startTimeTicks)) {
      return null;
    }
    return { ppid, startTimeTicks };
  } catch {
    return null;
  }
}

async function readAgentId(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`, "utf8");
    const match = /(?:^|\0)PASEO_AGENT_ID=([^\0]+)/.exec(raw);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function readResidentBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match) {
      return Number(match[1]) * 1024;
    }
  } catch {
    return readStatmResidentBytes(pid);
  }
  return readStatmResidentBytes(pid);
}

async function readStatmResidentBytes(pid: number): Promise<number> {
  try {
    const statm = await readFile(`/proc/${pid}/statm`, "utf8");
    const residentPages = Number(statm.split(/\s+/)[1]);
    if (Number.isFinite(residentPages)) {
      return residentPages * PAGE_SIZE_BYTES;
    }
  } catch {
    return 0;
  }
  return 0;
}

async function readCommand(pid: number): Promise<string> {
  try {
    return (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
  } catch {
    return "";
  }
}

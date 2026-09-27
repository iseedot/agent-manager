import { readFile, readdir } from "node:fs/promises";

export interface AgentProcessInfo {
  pid: number;
  rssBytes: number;
  command: string;
  isDaemonChild: boolean;
}

const PAGE_SIZE_BYTES = 4096;
const ENV_PREFIX = Buffer.from("PASEO_AGENT_ID=");

interface Candidate {
  agentId: string;
  pid: number;
  startTimeTicks: number;
  rssBytes: number;
  command: string;
}

export async function scanAgentProcesses(): Promise<Map<string, AgentProcessInfo>> {
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

  const daemonPid = process.ppid;
  const candidates = (
    await Promise.all(
      entries
        .filter((name) => /^\d+$/.test(name))
        .map((name) => readCandidate(Number(name), daemonPid)),
    )
  ).filter((candidate): candidate is Candidate => candidate !== null);

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
    const winner = group.reduce((best, candidate) =>
      candidate.startTimeTicks < best.startTimeTicks ? candidate : best,
    );
    found.set(agentId, {
      pid: winner.pid,
      rssBytes: winner.rssBytes,
      command: winner.command,
      isDaemonChild: true,
    });
  }

  return found;
}

async function readCandidate(pid: number, daemonPid: number): Promise<Candidate | null> {
  const agentId = await readAgentId(pid);
  if (!agentId) {
    return null;
  }
  const stat = await readStat(pid);
  if (!stat || stat.ppid !== daemonPid) {
    return null;
  }
  return {
    agentId,
    pid,
    startTimeTicks: stat.startTimeTicks,
    rssBytes: await readResidentBytes(pid),
    command: await readCommand(pid),
  };
}

async function readAgentId(pid: number): Promise<string | null> {
  try {
    const raw = await readFile(`/proc/${pid}/environ`);
    const start = raw.indexOf(ENV_PREFIX);
    if (start === -1 || (start !== 0 && raw[start - 1] !== 0)) {
      return null;
    }
    let end = start + ENV_PREFIX.length;
    while (end < raw.length && raw[end] !== 0) {
      end += 1;
    }
    if (end === start + ENV_PREFIX.length) {
      return null;
    }
    return raw.toString("latin1", start + ENV_PREFIX.length, end);
  } catch {
    return null;
  }
}

async function readStat(pid: number): Promise<{ ppid: number; startTimeTicks: number } | null> {
  try {
    const raw = await readFile(`/proc/${pid}/stat`);
    const close = raw.lastIndexOf(41);
    if (close < 0) {
      return null;
    }
    const fields = raw.toString("latin1", close + 1).trim().split(/\s+/);
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

async function readResidentBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "latin1");
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
    const statm = await readFile(`/proc/${pid}/statm`, "latin1");
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
    return (await readFile(`/proc/${pid}/comm`, "latin1")).trim();
  } catch {
    return "";
  }
}

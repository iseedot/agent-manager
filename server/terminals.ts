import { readFile, readdir, readlink } from "node:fs/promises";

import { readProcStat } from "./util";

export interface TerminalShell {
  pid: number;
  cwd: string | null;
  rssBytes: number;
  cpuTicks: number;
  children: number;
}

export interface TerminalSummary {
  workspaceId: string;
  count: number;
  shells: number;
  busy: number;
  rssBytes: number;
}

export interface TerminalEntry {
  id: string;
  name: string;
  cwd: string;
  workspaceId: string;
}

interface ProcessStat {
  ppid: number;
  cpuTicks: number;
}

const WORKER_MARKER = "terminal-worker";

export interface TerminalLister {
  terminals: {
    list(options: Record<string, never>): Promise<{ entries?: Array<Record<string, unknown>> }>;
  };
}

export interface TerminalKiller {
  terminals: {
    ref(terminalId: string): { kill(): Promise<void> };
  };
}

export async function closeTerminals(paseo: TerminalKiller, terminalIds: string[]): Promise<{ closed: string[]; failed: Array<{ terminalId: string; error: string }> }> {
  const closed: string[] = [];
  const failed: Array<{ terminalId: string; error: string }> = [];
  for (const terminalId of terminalIds) {
    try {
      await paseo.terminals.ref(terminalId).kill();
      closed.push(terminalId);
    } catch (error) {
      failed.push({ terminalId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { closed, failed };
}

export async function listAllTerminals(paseo: TerminalLister): Promise<TerminalEntry[]> {
  const page = await paseo.terminals.list({});
  const entries = Array.isArray(page?.entries) ? page.entries : [];
  const terminals: TerminalEntry[] = [];
  for (const entry of entries) {
    const id = str(entry?.id);
    const cwd = str(entry?.cwd);
    const owner = str(entry?.workspaceId);
    if (!id || !cwd || !owner) {
      continue;
    }
    terminals.push({
      id,
      name: str(entry?.name) ?? id.slice(0, 7),
      cwd,
      workspaceId: owner,
    });
  }
  return terminals;
}

export async function summarizeTerminals(
  list: () => Promise<TerminalEntry[]>,
  workspaceIds: string[],
): Promise<Map<string, TerminalSummary>> {
  const terminals = await list().catch(() => [] as TerminalEntry[]);
  const summaries = new Map<string, TerminalSummary>();
  for (const workspaceId of workspaceIds) {
    summaries.set(workspaceId, { workspaceId, count: 0, shells: 0, busy: 0, rssBytes: 0 });
  }
  if (terminals.length === 0) {
    return summaries;
  }
  const shells = await scanTerminalShells().catch(() => [] as TerminalShell[]);
  const byWorkspace = new Map<string, TerminalEntry[]>();
  for (const terminal of terminals) {
    const group = byWorkspace.get(terminal.workspaceId);
    if (group) {
      group.push(terminal);
    } else {
      byWorkspace.set(terminal.workspaceId, [terminal]);
    }
  }
  for (const [workspaceId, entries] of byWorkspace) {
    if (!summaries.has(workspaceId)) {
      summaries.set(workspaceId, { workspaceId, count: 0, shells: 0, busy: 0, rssBytes: 0 });
    }
    const cwds = new Set(entries.map((terminal) => terminal.cwd.replace(/\/+$/, "")));
    const matching = shells.filter((shell) => shell.cwd !== null && cwds.has(shell.cwd.replace(/\/+$/, "")));
    summaries.set(workspaceId, {
      workspaceId,
      count: entries.length,
      shells: matching.length,
      busy: Math.min(entries.length, matching.filter((shell) => shell.children > 0).length),
      rssBytes: matching.reduce((total, shell) => total + shell.rssBytes, 0),
    });
  }
  return summaries;
}

const SCAN_CACHE_MS = 800;
let scanCache: { at: number; shells: TerminalShell[] } | null = null;

export async function scanTerminalShells(): Promise<TerminalShell[]> {
  if (process.platform !== "linux") {
    return [];
  }
  if (scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS) {
    return scanCache.shells;
  }
  const shells = await scanTerminalShellsUncached();
  scanCache = { at: Date.now(), shells };
  return shells;
}

async function scanTerminalShellsUncached(): Promise<TerminalShell[]> {
  const daemonPid = process.ppid;
  const pids = await listPids();
  const children = new Map<number, number[]>();
  const stats = new Map<number, ProcessStat>();
  for (const pid of pids) {
    const stat = await readProcStat(pid);
    if (!stat) {
      continue;
    }
    stats.set(pid, { ppid: stat.ppid, cpuTicks: stat.cpuTicks });
    const siblings = children.get(stat.ppid);
    if (siblings) {
      siblings.push(pid);
    } else {
      children.set(stat.ppid, [pid]);
    }
  }

  const workerPid = await findWorkerPid(children.get(daemonPid) ?? []);
  if (workerPid === null) {
    return [];
  }

  const shells: TerminalShell[] = [];
  for (const shellPid of children.get(workerPid) ?? []) {
    const tree = collectTree(shellPid, children);
    let rssBytes = 0;
    let cpuTicks = 0;
    for (const pid of tree) {
      rssBytes += await readResidentBytes(pid);
      cpuTicks += stats.get(pid)?.cpuTicks ?? 0;
    }
    shells.push({
      pid: shellPid,
      cwd: await readCwd(shellPid),
      rssBytes,
      cpuTicks,
      children: tree.length - 1,
    });
  }
  return shells;
}

function collectTree(root: number, children: Map<number, number[]>): number[] {
  const seen: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift() as number;
    seen.push(pid);
    for (const child of children.get(pid) ?? []) {
      queue.push(child);
    }
  }
  return seen;
}

async function findWorkerPid(candidates: number[]): Promise<number | null> {
  for (const pid of candidates) {
    try {
      const cmdline = await readFile(`/proc/${pid}/cmdline`, "latin1");
      if (cmdline.includes(WORKER_MARKER)) {
        return pid;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function listPids(): Promise<number[]> {
  try {
    return (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return [];
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
    return 0;
  }
  return 0;
}

async function readCwd(pid: number): Promise<string | null> {
  try {
    return await readlink(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

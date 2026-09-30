import { readFile, readdir, readlink } from "node:fs/promises";

import type { TerminalEntryRow, TerminalSummaryRow } from "../shared/contracts";
import { readProcStat } from "./util";

export interface TerminalShell {
  pid: number;
  cwd: string | null;
  command: string;
  rssBytes: number;
  cpuTicks: number;
  children: number;
}

export type TerminalSummary = TerminalSummaryRow;
export type TerminalEntry = TerminalEntryRow;

export interface TerminalLister {
  terminals: {
    list(options: Record<string, never>): Promise<{ entries?: Array<Record<string, unknown>> }>;
  };
}

interface DaemonTerminalClient {
  listTerminals(
    cwd?: string,
    requestId?: string,
    options?: { workspaceId?: string },
  ): Promise<{ terminals?: Array<Record<string, unknown>> }>;
  killTerminal(terminalId: string, requestId?: string): Promise<unknown>;
}

export function terminalApiFromClient(client: DaemonTerminalClient): TerminalLister & TerminalKiller {
  return {
    terminals: {
      list: async () => ({ entries: (await client.listTerminals(undefined, undefined, {})).terminals ?? [] }),
      ref: (terminalId: string) => ({
        kill: async () => {
          await client.killTerminal(terminalId);
        },
      }),
    },
  };
}

export interface TerminalKiller {
  terminals: {
    ref(terminalId: string): { kill(): Promise<void> };
  };
}

interface ProcessStat {
  ppid: number;
  cpuTicks: number;
}

const WORKER_MARKER = "terminal-worker";

export async function closeTerminals(
  paseo: TerminalLister & TerminalKiller,
  terminalIds: string[],
): Promise<{ closed: string[]; failed: Array<{ terminalId: string; error: string }> }> {
  if (terminalIds.length === 0) {
    return { closed: [], failed: [] };
  }
  const before = await listAllTerminals(paseo).catch(() => null);
  const known = before === null ? null : new Set(before.map((terminal) => terminal.id));
  const closed: string[] = [];
  const failed: Array<{ terminalId: string; error: string }> = [];
  for (const terminalId of terminalIds) {
    if (known !== null && !known.has(terminalId)) {
      failed.push({ terminalId, error: "No such terminal on this host." });
      continue;
    }
    try {
      await paseo.terminals.ref(terminalId).kill();
      closed.push(terminalId);
    } catch (error) {
      failed.push({ terminalId, error: describeError(error) });
    }
  }
  if (closed.length === 0) {
    return { closed, failed };
  }
  const after = await listAllTerminals(paseo).catch(() => null);
  if (after === null) {
    return { closed, failed };
  }
  const remaining = new Set(after.map((terminal) => terminal.id));
  const gone = closed.filter((terminalId) => !remaining.has(terminalId));
  for (const terminalId of closed) {
    if (remaining.has(terminalId)) {
      failed.push({ terminalId, error: "The daemon still lists this terminal." });
    }
  }
  return { closed: gone, failed };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    const activity = (entry?.activity ?? null) as { state?: unknown; attentionReason?: unknown; changedAt?: unknown } | null;
    terminals.push({
      id,
      name: str(entry?.name) ?? id.slice(0, 7),
      cwd,
      workspaceId: owner,
      state: str(activity?.state),
      attention: str(activity?.attentionReason),
      changedAt: typeof activity?.changedAt === "number" ? activity.changedAt : null,
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
    summaries.set(workspaceId, emptySummary(workspaceId));
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
    const cwds = new Set(entries.map((terminal) => terminal.cwd.replace(/\/+$/, "")));
    const matching = shells.filter((shell) => shell.cwd !== null && cwds.has(shell.cwd.replace(/\/+$/, "")));
    summaries.set(workspaceId, {
      workspaceId,
      count: entries.length,
      shells: matching.length,
      busy: Math.min(entries.length, matching.filter((shell) => shell.children > 0).length),
      working: entries.filter((terminal) => terminal.state === "working" || terminal.attention !== null).length,
      idle: entries.filter((terminal) => terminal.state === "idle" && terminal.attention === null).length,
      rssBytes: matching.reduce((total, shell) => total + shell.rssBytes, 0),
      names: entries.slice(0, 3).map((terminal) => terminal.name),
    });
  }
  return summaries;
}

function emptySummary(workspaceId: string): TerminalSummary {
  return { workspaceId, count: 0, shells: 0, busy: 0, working: 0, idle: 0, rssBytes: 0, names: [] };
}

export async function closeIdleTerminals(
  paseo: TerminalLister & TerminalKiller,
  idleMinutes: number,
): Promise<{ closed: string[]; failed: Array<{ terminalId: string; error: string }>; skipped: number }> {
  const terminals = await listAllTerminals(paseo);
  const shells = await scanTerminalShells().catch(() => [] as TerminalShell[]);
  const now = Date.now();
  const deadline = now - idleMinutes * 60000;
  const targets: string[] = [];
  let skipped = 0;

  for (const terminal of terminals) {
    const since = idleSince(terminal, matchingShell(terminal, shells), now);
    if (since === null || since > deadline) {
      skipped += 1;
      continue;
    }
    targets.push(terminal.id);
  }
  pruneQuiet(terminals.map((terminal) => terminal.id));

  if (targets.length === 0) {
    return { closed: [], failed: [], skipped };
  }
  const result = await closeTerminals(paseo, targets);
  for (const id of result.closed) {
    quietSince.delete(id);
  }
  return { closed: result.closed, failed: result.failed, skipped };
}

const QUIET_SHELLS = new Set(["bash", "sh", "zsh", "fish", "dash", "ash", "ksh", "mksh", "nu", "elvish", "xonsh"]);
const quietSince = new Map<string, number>();

function idleSince(terminal: TerminalEntry, shell: TerminalShell | undefined, now: number): number | null {
  if (terminal.state === "idle" && terminal.attention === null && terminal.changedAt !== null) {
    quietSince.delete(terminal.id);
    return terminal.changedAt;
  }
  const quietPrompt =
    terminal.state === null &&
    terminal.attention === null &&
    shell !== undefined &&
    shell.children === 0 &&
    QUIET_SHELLS.has(shell.command.replace(/^-/, ""));
  if (!quietPrompt) {
    quietSince.delete(terminal.id);
    return null;
  }
  const first = quietSince.get(terminal.id);
  if (first !== undefined) {
    return first;
  }
  quietSince.set(terminal.id, now);
  return now;
}

function pruneQuiet(liveIds: string[]): void {
  const live = new Set(liveIds);
  for (const id of [...quietSince.keys()]) {
    if (!live.has(id)) {
      quietSince.delete(id);
    }
  }
}

function matchingShell(terminal: TerminalEntry, shells: TerminalShell[]): TerminalShell | undefined {
  const cwd = terminal.cwd.replace(/\/+$/, "");
  return shells.find((shell) => shell.cwd !== null && shell.cwd.replace(/\/+$/, "") === cwd);
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
      command: await readCommand(shellPid),
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

async function readCommand(pid: number): Promise<string> {
  try {
    const raw = await readFile(`/proc/${pid}/comm`, "latin1");
    return raw.trim();
  } catch {
    return "";
  }
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

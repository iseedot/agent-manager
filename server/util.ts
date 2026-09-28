import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function normalizePath(value: string): string {
  return value.replace(/\/+$/, "");
}

export function pathBasename(value: string): string {
  return normalizePath(value).split("/").filter(Boolean).pop() ?? value;
}

let writeQueue: Promise<unknown> = Promise.resolve();

export function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.catch(() => undefined);
  return next;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export interface ProcStat {
  ppid: number;
  cpuTicks: number;
  startTimeTicks: number;
  state: string;
}

export async function readProcStat(pid: number): Promise<ProcStat | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, "latin1"));
  } catch {
    return null;
  }
}

export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const fields = raw.slice(close + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const state = fields[0] ?? "";
  const cpuTicks = Number(fields[11]) + Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(cpuTicks) || !Number.isFinite(startTimeTicks)) {
    return null;
  }
  return { ppid, cpuTicks, startTimeTicks, state };
}

export function readProcStatSync(pid: number): ProcStat | null {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, "latin1"));
  } catch {
    return null;
  }
}

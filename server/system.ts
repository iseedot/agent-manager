import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";

export interface SystemStats {
  load1: number | null;
  load5: number | null;
  load15: number | null;
  cpuPercent: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  memUsedPercent: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
  swapUsedPercent: number | null;
  /** Free space of the root filesystem, as a percentage. */
  diskFreePercent: number | null;
  uptimeSeconds: number | null;
}

const SAMPLE_WINDOW_MS = 200;
const MIN_WINDOW_MS = 400;

interface CpuTicks {
  busy: number;
  total: number;
}

let lastTicks: CpuTicks | null = null;
let lastPercent: { value: number | null; at: number } | null = null;

export async function readSystemStats(): Promise<SystemStats> {
  const [meminfo, loadavg, uptime, ticks, diskFreePercent] = await Promise.all([
    readText("/proc/meminfo"),
    readText("/proc/loadavg"),
    readText("/proc/uptime"),
    readCpuTicks(),
    readDiskFreePercent(),
  ]);

  const cpuPercent = await cpuPercentSinceLastSample(ticks);
  const memory = parseMemory(meminfo);
  const load = parseLoad(loadavg);

  return {
    load1: load[0] ?? null,
    load5: load[1] ?? null,
    load15: load[2] ?? null,
    cpuPercent,
    memTotalBytes: memory.total,
    memUsedBytes: memory.used,
    memUsedPercent: percentage(memory.used, memory.total),
    swapTotalBytes: memory.swapTotal,
    swapUsedBytes: memory.swapUsed,
    swapUsedPercent: percentage(memory.swapUsed, memory.swapTotal),
    diskFreePercent,
    uptimeSeconds: uptime === null ? null : Number(uptime.trim().split(/\s+/)[0]) || null,
  };
}

function percentage(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || whole <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (part / whole) * 100));
}

async function readDiskFreePercent(): Promise<number | null> {
  try {
    const stats = await statfs("/");
    const total = stats.blocks * stats.bsize;
    const free = stats.bavail * stats.bsize;
    return percentage(free, total);
  } catch {
    return null;
  }
}

async function cpuPercentSinceLastSample(ticks: CpuTicks | null): Promise<number | null> {
  if (ticks === null) {
    return lastPercent?.value ?? null;
  }
  const now = Date.now();
  const previous = lastTicks;
  if (previous === null) {
    const seeded = await seedTicks(ticks);
    return seeded;
  }
  lastTicks = ticks;
  if (now - (lastPercent?.at ?? 0) < MIN_WINDOW_MS) {
    return lastPercent?.value ?? null;
  }
  const percent = percentBetween(previous, ticks);
  if (percent !== null) {
    lastPercent = { value: percent, at: now };
  }
  return lastPercent?.value ?? null;
}

async function seedTicks(first: CpuTicks): Promise<number | null> {
  await delay(SAMPLE_WINDOW_MS);
  const second = await readCpuTicks();
  if (second === null) {
    return null;
  }
  lastTicks = second;
  const percent = percentBetween(first, second);
  lastPercent = { value: percent, at: Date.now() };
  return percent;
}

function percentBetween(previous: CpuTicks, next: CpuTicks): number | null {
  const totalDelta = next.total - previous.total;
  const busyDelta = next.busy - previous.busy;
  if (totalDelta <= 0 || busyDelta < 0) {
    return null;
  }
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
}

async function readCpuTicks(): Promise<CpuTicks | null> {
  const stat = await readText("/proc/stat");
  if (stat === null) {
    return null;
  }
  const line = stat.split("\n").find((entry) => entry.startsWith("cpu "));
  if (!line) {
    return null;
  }
  const fields = line.trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite);
  if (fields.length < 4) {
    return null;
  }
  const idle = fields[3] + (fields[4] ?? 0);
  const total = fields.reduce((sum, value) => sum + value, 0);
  return { busy: total - idle, total };
}

function parseMemory(meminfo: string | null): {
  total: number | null;
  used: number | null;
  swapTotal: number | null;
  swapUsed: number | null;
} {
  if (meminfo === null) {
    return { total: null, used: null, swapTotal: null, swapUsed: null };
  }
  const values = new Map<string, number>();
  for (const line of meminfo.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match) {
      values.set(match[1], Number(match[2]) * 1024);
    }
  }
  const total = values.get("MemTotal") ?? null;
  const available =
    values.get("MemAvailable") ??
    ((values.get("MemFree") ?? 0) + (values.get("Buffers") ?? 0) + (values.get("Cached") ?? 0) || null);
  const swapTotal = values.get("SwapTotal") ?? null;
  const swapFree = values.get("SwapFree") ?? null;
  return {
    total,
    used: total !== null && available !== null ? Math.max(0, total - available) : null,
    swapTotal,
    swapUsed: swapTotal !== null && swapFree !== null ? Math.max(0, swapTotal - swapFree) : null,
  };
}

function parseLoad(loadavg: string | null): Array<number | null> {
  if (loadavg === null) {
    return [null, null, null];
  }
  const parts = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  return [parts[0] ?? null, parts[1] ?? null, parts[2] ?? null].map((value) =>
    typeof value === "number" && Number.isFinite(value) ? value : null,
  );
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

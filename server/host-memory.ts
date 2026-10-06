import { readFile } from "node:fs/promises";

/**
 * Memory and swap usage, read straight from /proc/meminfo.
 *
 * This exists only so the sweep can put a number in its log line; unlike the old host facts it is
 * never sent to a client and nothing else reads it.
 */
export interface MemoryUsage {
  memUsedPercent: number | null;
  swapUsedPercent: number | null;
}

export async function readMemoryUsage(): Promise<MemoryUsage> {
  try {
    const values = new Map<string, number>();
    for (const line of (await readFile("/proc/meminfo", "utf8")).split("\n")) {
      const match = /^(\w+):\s+(\d+)/.exec(line);
      if (match) {
        values.set(match[1], Number(match[2]));
      }
    }
    return {
      memUsedPercent: percent(values.get("MemTotal"), values.get("MemAvailable")),
      swapUsedPercent: percent(values.get("SwapTotal"), values.get("SwapFree")),
    };
  } catch {
    return { memUsedPercent: null, swapUsedPercent: null };
  }
}

/** `mem 53% swap 13%`, with `?` when the reading is unavailable. */
export function formatMemory(usage: MemoryUsage): string {
  return `mem ${percentText(usage.memUsedPercent)} swap ${percentText(usage.swapUsedPercent)}`;
}

function percent(total: number | undefined, free: number | undefined): number | null {
  if (!total || total <= 0 || free === undefined) {
    return null;
  }
  return Math.round(((total - free) / total) * 100);
}

function percentText(value: number | null): string {
  return value === null ? "?" : `${value}%`;
}

import type { FactsPayload, TerminalPresence } from "../shared/contracts";

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatTime(value: string | null): string {
  if (!value) {
    return "—";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }
  const minutes = Math.floor((Date.now() - parsed.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "?" : `${Math.round(value)}%`;
}

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}G` : `${Math.round(mb)}M`;
}

export function clock(iso: string | null): string {
  const date = new Date(iso ?? "");
  if (Number.isNaN(date.getTime())) {
    return "?";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Memory, swap and root-filesystem percentages, then the workspace's terminals. */
export function hostLine(facts: FactsPayload, terminal: TerminalPresence | null): string {
  const system = facts.system;
  const parts: string[] = [];
  if (system.load1 !== null) parts.push(`load ${system.load1.toFixed(2)}`);
  parts.push(`cpu ${percent(system.cpuPercent)}`);
  parts.push(`mem ${percent(system.memUsedPercent)}/${percent(system.swapUsedPercent)}`);
  if (system.diskFreePercent !== null) {
    parts.push(`disk ${percent(system.diskFreePercent)} free`);
  } else if (system.memTotalBytes !== null && system.memUsedBytes !== null) {
    parts.push(`mem ${megabytes(system.memUsedBytes)}/${megabytes(system.memTotalBytes)}`);
  }
  const count = terminal?.count ?? 0;
  parts.push(`${count} terminal${count === 1 ? "" : "s"}`);
  if (terminal && terminal.working > 0) parts.push(`${terminal.working} working`);
  if (terminal && terminal.waiting > 0) parts.push(`${terminal.waiting} waiting`);
  return parts.join(" · ");
}

/** Auto-release state, one short line under the host numbers. */
export function sweepLine(status: FactsPayload["autoRelease"]): string {
  const parts: string[] =
    status.running === true
      ? ["Sweep sweeping now"]
      : [status.lastRunAt ? `Sweep ${clock(status.lastRunAt)}` : "Sweep never ran"];
  if (status.dueAt) {
    parts.push(`due ${clock(status.dueAt)}`);
  } else if (status.nextRunAt) {
    parts.push(clock(status.nextRunAt));
  }
  if (status.error) {
    parts.push(`error: ${status.error}`);
  }
  return parts.join(" · ");
}

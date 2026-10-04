import type { TerminalPresence } from "../shared/contracts";

export interface TerminalLister {
  terminals: {
    list(options: Record<string, never>): Promise<{ entries?: Array<Record<string, unknown>> }>;
  };
}

interface TerminalEntry {
  id: string;
  name: string;
  workspaceId: string;
  cwd: string;
  state: string | null;
  attention: string | null;
  changedAt: number | null;
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

export function summarizeTerminalPresence(terminals: TerminalEntry[]): TerminalPresence[] {
  const byWorkspace = new Map<string, TerminalPresence>();
  for (const terminal of terminals) {
    const presence =
      byWorkspace.get(terminal.workspaceId) ??
      { workspaceId: terminal.workspaceId, count: 0, working: 0, waiting: 0 };
    presence.count += 1;
    if (terminal.state === "working" || terminal.attention !== null) {
      presence.working += 1;
    }
    if (terminal.attention === "needs_input") {
      presence.waiting += 1;
    }
    byWorkspace.set(terminal.workspaceId, presence);
  }
  return [...byWorkspace.values()];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

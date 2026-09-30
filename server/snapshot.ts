import type {
  AutoReleaseSnapshot,
  OverviewPayload,
  ProjectRow,
  SystemStats,
  WorkspaceRow,
} from "../shared/contracts";
import { readAutoReleaseState } from "./auto-release";
import { buildOverview, type PaseoLike } from "./overview";
import { readSystemStats } from "./system";
import {
  listAllTerminals,
  summarizeTerminals,
  type TerminalEntry,
  type TerminalLister,
  type TerminalSummary,
} from "./terminals";
import { listProjectRows, listWorkspaceRows } from "./workspaces";

export interface SnapshotPayload {
  overview: OverviewPayload;
  workspaces: WorkspaceRow[];
  projects: ProjectRow[];
  terminals: TerminalSummary[];
  terminalList: TerminalEntry[];
  system: SystemStats;
  autoRelease: AutoReleaseSnapshot;
}

export async function buildSnapshot(paseo: PaseoLike): Promise<SnapshotPayload> {
  const [overview, workspaces, projects, system, autoRelease, terminals] = await Promise.all([
    buildOverview(paseo),
    listWorkspaceRows(),
    listProjectRows(),
    readSystemStats(),
    readAutoReleaseState(),
    listAllTerminals(paseo as unknown as TerminalLister).catch(() => [] as TerminalEntry[]),
  ]);
  const summaries = await summarizeTerminals(
    async () => terminals,
    workspaces.map((row) => row.workspaceId),
  );
  return {
    overview,
    workspaces,
    projects,
    terminals: [...summaries.values()],
    terminalList: terminals.map((terminal) => ({
      id: terminal.id,
      name: terminal.name,
      workspaceId: terminal.workspaceId,
      cwd: terminal.cwd,
      state: terminal.state,
      attention: terminal.attention,
      changedAt: terminal.changedAt,
    })),
    system,
    autoRelease,
  };
}

import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { message } from "./format";
import {
  jobStatusRpc,
  workspaceActivateRpc,
  workspacesRpc,
  type AgentRow,
  type JobSnapshot,
  type WorkspaceRow,
} from "../shared/contracts";

export interface WorkspaceStats {
  total: number;
  archived: number;
  open: number;
  holding: number;
  idle: number;
  running: number;
  rssBytes: number;
}

export interface ActivateInput {
  workspaceId: string;
  workspaceName?: string;
  release: boolean;
  tabsOnly?: boolean;
}

export interface WorkspaceJobs {
  job: JobSnapshot | null;
  busy: boolean;
  error: string | null;
  activate: (input: ActivateInput) => void;
  dismiss: () => void;
}

const POLL_INTERVAL_MS = 600;

const sharedJobs = new Map<string, string>();

export function useWorkspaces(hostId: string) {
  const list = useRpc(workspacesRpc);
  return useQuery({
    queryKey: ["agent-manager", "workspaces", hostId],
    queryFn: () => list({}),
  });
}

export function useWorkspaceJobs(hostId: string): WorkspaceJobs {
  const start = useRpc(workspaceActivateRpc);
  const status = useRpc(jobStatusRpc);
  const queryClient = useQueryClient();
  const [jobId, setJobIdState] = useState<string | null>(sharedJobs.get(hostId) ?? null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const rememberJobId = useCallback(
    (next: string | null) => {
      if (next) {
        sharedJobs.set(hostId, next);
      } else {
        sharedJobs.delete(hostId);
      }
      setJobIdState(next);
    },
    [hostId],
  );

  useEffect(() => {
    if (!jobId) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const next = await statusRef.current({ jobId });
        if (cancelled) {
          return;
        }
        setJob(next);
        if (!next.finished) {
          timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          return;
        }
        await queryClient.invalidateQueries({ queryKey: ["agent-manager"] });
      } catch (pollError) {
        if (!cancelled) {
          setError(message(pollError));
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [jobId, queryClient]);

  const activate = useCallback(
    (input: ActivateInput) => {
      setError(null);
      setJob(null);
      void (async () => {
        try {
          const started = await start(input);
          rememberJobId(started.jobId);
        } catch (startError) {
          setError(message(startError));
        }
      })();
    },
    [start, rememberJobId],
  );

  const dismiss = useCallback(() => {
    setJob(null);
    setError(null);
    rememberJobId(null);
  }, [rememberJobId]);

  return {
    job,
    busy: job ? !job.finished : false,
    error,
    activate,
    dismiss,
  };
}

export function workspaceStats(agents: readonly AgentRow[] | undefined, workspaceId: string): WorkspaceStats {
  const stats: WorkspaceStats = { total: 0, archived: 0, open: 0, holding: 0, idle: 0, running: 0, rssBytes: 0 };
  for (const row of agents ?? []) {
    if (row.workspaceId !== workspaceId) {
      continue;
    }
    stats.total += 1;
    if (row.archived) {
      stats.archived += 1;
    } else {
      stats.open += 1;
    }
    if (row.pid !== null) {
      stats.holding += 1;
      stats.rssBytes += row.rssBytes ?? 0;
      if (row.status !== "running") {
        stats.idle += 1;
      }
    }
    if (row.status === "running") {
      stats.running += 1;
    }
  }
  return stats;
}

export function workspaceLabel(row: WorkspaceRow): string {
  const name = row.name ?? row.cwd.split("/").filter(Boolean).pop() ?? row.workspaceId.slice(0, 7);
  return name;
}

export function normalizePath(value: string): string {
  return value.replace(/\/+$/, "");
}

export function pathRows(rows: readonly WorkspaceRow[], row: WorkspaceRow): WorkspaceRow[] {
  return rows.filter(
    (candidate) =>
      candidate.projectId === row.projectId && normalizePath(candidate.cwd) === normalizePath(row.cwd),
  );
}

export function activeAtPath(rows: readonly WorkspaceRow[], row: WorkspaceRow): WorkspaceRow[] {
  return pathRows(rows, row).filter((candidate) => candidate.archivedAt === null);
}

export function isLastActiveAtPath(rows: readonly WorkspaceRow[], row: WorkspaceRow): boolean {
  const active = activeAtPath(rows, row);
  return active.length === 1 && active[0]?.workspaceId === row.workspaceId;
}

export function reopenCandidate(rows: readonly WorkspaceRow[], row: WorkspaceRow): WorkspaceRow | null {
  const candidates = pathRows(rows, row)
    .filter((candidate) => candidate.archivedAt !== null || candidate.workspaceId === row.workspaceId)
    .sort(
      (left, right) =>
        (left.createdAt ?? "").localeCompare(right.createdAt ?? "") ||
        left.workspaceId.localeCompare(right.workspaceId),
    );
  return candidates[0] ?? null;
}

export function jobText(job: JobSnapshot): string {
  if (job.phase === "failed") {
    return job.message ?? "Failed";
  }
  if (job.phase === "done") {
    return job.message ?? "Done";
  }
  if (job.phase === "workspace") {
    return job.message ?? "Restoring workspace…";
  }
  const current = job.current ? ` · ${job.current}` : "";
  return `Reopening tabs ${Math.min(job.done + 1, job.total)}/${job.total}${current}`;
}

export function jobFailure(job: JobSnapshot): string | null {
  const first = job.failed[0];
  return first ? `${first.agentId.slice(0, 7)}: ${first.error}` : null;
}

export function JobLine({
  job,
  error,
  busy,
  theme,
}: {
  job: JobSnapshot | null;
  error: string | null;
  busy: boolean;
  theme: { colors: { foreground: string; foregroundMuted: string; accent: string; statusWarning: string; statusDanger: string } };
}) {
  if (error) {
    return <Text style={{ color: theme.colors.statusDanger, fontSize: 11 }}>{error}</Text>;
  }
  if (!job) {
    return null;
  }
  const failure = jobFailure(job);
  const color =
    job.phase === "failed" ? theme.colors.statusDanger : job.phase === "done" ? theme.colors.foreground : theme.colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {busy ? <ActivityIndicator color={theme.colors.accent} size="small" /> : null}
      <Text style={{ color, fontSize: 11, flexShrink: 1 }} numberOfLines={2}>
        {jobText(job)}
        {failure ? ` · ${failure}` : ""}
      </Text>
    </View>
  );
}


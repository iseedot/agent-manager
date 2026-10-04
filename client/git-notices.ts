import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

import { gitNoticesRpc, type GitNotice } from "../shared/contracts";

/**
 * Project-git notices come from the server hook that prepares a project directory before a
 * workspace is created. One store feeds both the pill label and the popover, so dismissing a
 * notice clears the pill warning immediately.
 */
const POLL_MS = 60000;

let snapshot: GitNotice[] = [];
let context: PluginClientContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      continue;
    }
  }
}

export function subscribeGitNotices(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startGitNotices(client: PluginClientContext): () => void {
  context = client;
  void refreshGitNotices();
  timer = setInterval(() => {
    void refreshGitNotices();
  }, POLL_MS);
  return () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
    context = null;
    snapshot = [];
    emit();
  };
}

async function refreshGitNotices(): Promise<void> {
  const active = context;
  if (!active) {
    return;
  }
  try {
    const result = await active.rpc(gitNoticesRpc, {});
    snapshot = result.notices;
  } catch {
    // Advisory only: a failed read keeps the last known list.
    return;
  }
  emit();
}

/**
 * Runs one of a notice's actions (for example removing an archived workspace's worktree).
 * Returns an error message for the caller to show, or null when the action was applied.
 */
export async function runGitNoticeAction(id: number, actionId: string): Promise<string | null> {
  const active = context;
  if (!active) {
    return "This client is not connected";
  }
  try {
    const result = await active.rpc(gitNoticesRpc, { action: { id, actionId } });
    snapshot = result.notices;
    emit();
    return null;
  } catch (error) {
    void refreshGitNotices();
    return error instanceof Error ? error.message : String(error);
  }
}

export function dismissGitNotice(id: number): void {
  snapshot = snapshot.filter((notice) => notice.id !== id);
  emit();
  const active = context;
  if (!active) {
    return;
  }
  void active.rpc(gitNoticesRpc, { dismissIds: [id] }).catch(() => undefined);
}

export function gitNoticesSnapshot(): GitNotice[] {
  return snapshot;
}

/**
 * The one line the pill carries in its title. Informational notes (a created worktree, an
 * initialized repository) only appear in the popover; anything the user must act on flags the pill.
 */
export function gitNoticeWarning(notices: readonly GitNotice[]): string | null {
  const actionable = notices.find(
    (notice) => notice.level !== "info" || (notice.actions?.length ?? 0) > 0,
  );
  return actionable ? actionable.title : null;
}

const NOTICE_PRIORITY: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Actionable notices first, then newest first — the popover only shows a couple of rows. */
export function sortNotices(notices: readonly GitNotice[]): GitNotice[] {
  return [...notices].sort((left, right) => {
    const leftRank = (NOTICE_PRIORITY[left.level] ?? 3) - ((left.actions?.length ?? 0) > 0 ? 0.5 : 0);
    const rightRank = (NOTICE_PRIORITY[right.level] ?? 3) - ((right.actions?.length ?? 0) > 0 ? 0.5 : 0);
    return leftRank - rightRank || right.id - left.id;
  });
}

export function useGitNotices(): GitNotice[] {
  return useSyncExternalStore(subscribeGitNotices, gitNoticesSnapshot, gitNoticesSnapshot);
}

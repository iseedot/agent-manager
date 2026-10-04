/**
 * Advisory messages for the pill popover.
 *
 * A notice carries a short `title` — that is all the popover renders, one line, so keep it tiny
 * (`<name> · what happened`) — plus the long `message`, which only goes to the plugin log. Notices
 * can also carry actions the user picks in the popover: that is the only place a plugin can ask the
 * user anything.
 */
export interface NoticeAction {
  id: string;
  label: string;
  tone?: "primary" | "danger";
}

export interface Notice {
  id: number;
  at: string;
  level: "info" | "warning" | "error";
  kind: string;
  directory: string;
  title: string;
  message: string;
  actions?: NoticeAction[];
}

interface NoticeActionResult {
  message?: string;
  title?: string;
  actions?: NoticeAction[] | null;
  dismissed?: boolean;
}

type NoticeActionHandler = (
  notice: Notice,
  actionId: string,
) => NoticeActionResult | Promise<NoticeActionResult>;

const MAX_NOTICES = 20;

let sequence = 0;
const notices: Notice[] = [];
const actionHandlers = new Map<string, NoticeActionHandler>();

export function registerNoticeAction(kind: string, handler: NoticeActionHandler): void {
  actionHandlers.set(kind, handler);
}

export function listNotices(): Notice[] {
  return notices.map((notice) => ({
    id: notice.id,
    at: notice.at,
    level: notice.level,
    kind: notice.kind,
    directory: notice.directory,
    title: notice.title,
    message: notice.message,
    ...(notice.actions ? { actions: notice.actions } : {}),
  }));
}

export function dismissNotices(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const dropped = new Set(ids);
  for (let index = notices.length - 1; index >= 0; index -= 1) {
    const notice = notices[index];
    if (notice && dropped.has(notice.id)) {
      notices.splice(index, 1);
    }
  }
}

export function recordNotice(entry: Omit<Notice, "id" | "at">): Notice {
  logNotice(entry);
  const existing = notices.find(
    (notice) => notice.kind === entry.kind && notice.directory === entry.directory,
  );
  if (existing) {
    existing.at = new Date().toISOString();
    existing.level = entry.level;
    existing.title = entry.title;
    existing.message = entry.message;
    existing.actions = entry.actions;
    return existing;
  }
  const notice: Notice = { id: (sequence += 1), at: new Date().toISOString(), ...entry };
  notices.unshift(notice);
  while (notices.length > MAX_NOTICES) {
    notices.pop();
  }
  return notice;
}

export async function runNoticeAction(id: number, actionId: string): Promise<void> {
  const notice = notices.find((candidate) => candidate.id === id);
  if (!notice) {
    throw new Error("That notice is no longer available");
  }
  const handler = actionHandlers.get(notice.kind);
  if (!handler) {
    throw new Error(`No action handler for ${notice.kind}`);
  }
  const result = await handler(notice, actionId);
  if (result.dismissed) {
    dismissNotices([notice.id]);
    console.log(`agent-manager ${notice.kind} ${notice.directory}: ${result.message ?? "done"}`);
    return;
  }
  if (typeof result.message === "string") {
    notice.message = result.message;
  }
  if (typeof result.title === "string") {
    notice.title = result.title;
  }
  if (result.actions !== undefined) {
    if (result.actions === null) delete notice.actions;
    else notice.actions = result.actions;
  }
  notice.at = new Date().toISOString();
  logNotice(notice);
}

function logNotice(entry: Omit<Notice, "id" | "at"> | Notice): void {
  const line = `agent-manager ${entry.kind} [${entry.title}] ${entry.directory}: ${entry.message}`;
  if (entry.level === "error") {
    console.error(line);
  } else if (entry.level === "warning") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function noticeName(directory: string): string {
  const parts = directory.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

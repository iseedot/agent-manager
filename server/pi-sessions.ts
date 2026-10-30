import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { paseoHome } from "./daemon";
import { describe, str } from "./util";

/**
 * pi's own session files, and the only provider files this plugin ever deletes.
 *
 * pi keeps one JSONL transcript per session at `<sessionDir>/<cwd-slug>/<timestamp>_<uuid>.jsonl`.
 * `sessionDir` is `<agent-dir>/sessions` by default, where the agent dir is `~/.pi/agent` unless
 * `PI_CODING_AGENT_DIR` moves it; `PI_CODING_AGENT_SESSION_DIR` and the `sessionDir` setting can move
 * it too, so the sweep also trusts any root it can infer from the paths Paseo recorded.
 *
 * pi is the only provider with an exact path in the agent record (`persistence.nativeHandle`). The
 * others either name a session id instead (claude, codex) or keep the file where this plugin cannot
 * know (opencode, the ACP agents), so guessing would risk deleting a file that is not ours. Adding
 * one means teaching `sessionFileFor` and `sweepOrphanSessions` about it, not changing the cleanup.
 */

/** pi's state directory: `~/.pi/agent`, or wherever `PI_CODING_AGENT_DIR` points. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

/** The two fields a session lookup needs; an `AgentRecord` satisfies this. */
export interface AgentRef {
  id: string;
  cwd: string | null;
}

export interface TranscriptOutcome {
  /** agent id → the transcript path that was removed. */
  deleted: Map<string, string>;
  failed: Array<{ agentId: string; error: string }>;
}

export interface OrphanSweepOutcome {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

interface AgentRecordLike {
  provider?: unknown;
  persistence?: { sessionId?: unknown; nativeHandle?: unknown } | null;
}

/** Deletes the transcript each agent record points at. Used before the records themselves go. */
export async function deleteAgentTranscripts(
  agents: readonly AgentRef[],
): Promise<TranscriptOutcome> {
  const deleted = new Map<string, string>();
  const failed: TranscriptOutcome["failed"] = [];
  for (const agent of agents) {
    try {
      const path = await sessionFileFor(agent);
      if (path) {
        await rm(path, { force: true });
        deleted.set(agent.id, path);
      }
    } catch (error) {
      failed.push({ agentId: agent.id, error: describe(error) });
    }
  }
  return { deleted, failed };
}

/**
 * Deletes every pi transcript no Paseo agent record references — sessions started by running pi
 * directly, outside Paseo. A file is kept when either its path or its session id is recorded.
 */
export async function sweepOrphanSessions(): Promise<OrphanSweepOutcome> {
  const known = await recordedPiSessions();
  const deleted: string[] = [];
  const failed: OrphanSweepOutcome["failed"] = [];
  for (const file of await listSessionFiles(known.handles)) {
    const sessionId = sessionIdOf(file);
    if (known.handles.has(file) || (sessionId !== null && known.sessionIds.has(sessionId))) {
      continue;
    }
    try {
      await rm(file, { force: true });
      deleted.push(file);
    } catch (error) {
      failed.push({ path: file, error: describe(error) });
    }
  }
  return { deleted, failed };
}

/** The transcript an agent's own record names, when it is a plausible pi session file. */
async function sessionFileFor(agent: AgentRef): Promise<string | null> {
  const record = (await readAgentRecord(agent)) as AgentRecordLike | null;
  if (!record || str(record.provider) !== "pi") {
    return null;
  }
  const handle = str(record.persistence?.nativeHandle);
  return handle && isAbsolute(handle) && handle.endsWith(".jsonl") ? handle : null;
}

/** Every handle and session id pi agents have on disk, the keep-set of the orphan sweep. */
async function recordedPiSessions(): Promise<{
  handles: Set<string>;
  sessionIds: Set<string>;
}> {
  const handles = new Set<string>();
  const sessionIds = new Set<string>();
  for (const record of await readAllAgentRecords()) {
    if (str(record.provider) !== "pi") {
      continue;
    }
    const handle = str(record.persistence?.nativeHandle);
    const sessionId = str(record.persistence?.sessionId);
    if (handle) handles.add(handle);
    if (sessionId) sessionIds.add(sessionId);
  }
  return { handles, sessionIds };
}

async function listSessionFiles(recorded: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = [];
  for (const root of await sessionRoots(recorded)) {
    await walk(root, files);
  }
  return files;
}

/** Candidate session roots: the configured one, the default one, and any root a record implies. */
async function sessionRoots(recorded: ReadonlySet<string>): Promise<string[]> {
  const roots = new Set<string>();
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (configured) {
    roots.add(configured);
  }
  const agentDir = piAgentDir();
  roots.add(join(agentDir, "sessions"));
  const setting = await absoluteSessionDirSetting(join(agentDir, "settings.json"));
  if (setting) {
    roots.add(setting);
  }
  for (const handle of recorded) {
    // <sessionDir>/<cwd-slug>/<file>.jsonl → <sessionDir>
    roots.add(dirname(dirname(handle)));
  }
  return [...roots];
}

async function absoluteSessionDirSetting(settingsPath: string): Promise<string | null> {
  const parsed = (await readJson(settingsPath)) as { sessionDir?: unknown } | null;
  const value = typeof parsed?.sessionDir === "string" ? parsed.sessionDir.trim() : "";
  return value.length > 0 && isAbsolute(value) ? value : null;
}

async function walk(root: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

/** The daemon writes one record per agent under the path slug of its cwd; scan only as a fallback. */
async function readAgentRecord(agent: AgentRef): Promise<unknown> {
  if (agent.cwd) {
    const slug = agent.cwd.replace(/^\/+/, "").replace(/\/+/g, "-");
    const direct = await readJson(join(paseoHome(), "agents", slug, `${agent.id}.json`));
    if (direct !== null) {
      return direct;
    }
  }
  for (const entry of await agentDirectories()) {
    const found = await readJson(join(paseoHome(), "agents", entry, `${agent.id}.json`));
    if (found !== null) {
      return found;
    }
  }
  return null;
}

async function readAllAgentRecords(): Promise<AgentRecordLike[]> {
  const records: AgentRecordLike[] = [];
  for (const directory of await agentDirectories()) {
    for (const file of await agentRecordFiles(directory)) {
      const record = await readJson(join(paseoHome(), "agents", directory, file));
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record as AgentRecordLike);
      }
    }
  }
  return records;
}

async function agentDirectories(): Promise<string[]> {
  try {
    return await readdir(join(paseoHome(), "agents"));
  } catch {
    return [];
  }
}

async function agentRecordFiles(directory: string): Promise<string[]> {
  try {
    const files = await readdir(join(paseoHome(), "agents", directory));
    return files.filter((file) => file.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function sessionIdOf(file: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    basename(file),
  );
  return match ? match[1] : null;
}

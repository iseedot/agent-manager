import { readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

import { describe } from "./util";

/**
 * pi keeps one JSONL transcript per session at
 * `<sessionDir>/<cwd-slug>/<timestamp>_<uuid>.jsonl`.
 *
 * `sessionDir` is `<agent-dir>/sessions` by default, where the agent dir is `~/.pi/agent` unless
 * `PI_CODING_AGENT_DIR` moves it. `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting and the
 * `--session-dir` flag can each change it, so the sweep also trusts any root it can infer from the
 * absolute paths Paseo recorded.
 *
 * Everything pi-specific stays in this file: the dispatcher only ever calls the two exported
 * functions, so another provider is a new sibling module and one `case`.
 */

export interface KnownPiSessions {
  /** Absolute transcript paths named by a Paseo agent record. */
  handles: Set<string>;
  /** pi session ids named by a Paseo agent record. */
  sessionIds: Set<string>;
}

export interface PiOrphanOutcome {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

/** Deletes the transcript an agent record points at, when it is a plausible pi session file. */
export async function deletePiAgentSession(nativeHandle: string | null): Promise<string | null> {
  if (!nativeHandle || !isAbsolute(nativeHandle) || !nativeHandle.endsWith(".jsonl")) {
    return null;
  }
  await rm(nativeHandle, { force: true });
  return nativeHandle;
}

/**
 * Deletes every pi transcript no Paseo agent record references — sessions started by running pi
 * directly. A file is kept when either its absolute path or its session id is recorded.
 */
export async function deleteOrphanPiSessions(known: KnownPiSessions): Promise<PiOrphanOutcome> {
  const deleted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const file of await listPiSessionFiles(known.handles)) {
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

async function listPiSessionFiles(recorded: ReadonlySet<string>): Promise<string[]> {
  const files: string[] = [];
  for (const root of await piSessionRoots(recorded)) {
    await walk(root, files);
  }
  return files;
}

/** Candidate session roots: the configured one, the default one, and any root a record implies. */
async function piSessionRoots(recorded: ReadonlySet<string>): Promise<string[]> {
  const roots = new Set<string>();
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  if (configured) {
    roots.add(configured);
  }
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
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
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { sessionDir?: unknown };
    const value = typeof parsed?.sessionDir === "string" ? parsed.sessionDir.trim() : "";
    return value.length > 0 && isAbsolute(value) ? value : null;
  } catch {
    return null;
  }
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
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
}

function sessionIdOf(file: string): string | null {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    basename(file),
  );
  return match ? match[1] : null;
}

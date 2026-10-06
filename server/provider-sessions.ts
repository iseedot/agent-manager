import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { paseoHome } from "./daemon-mcp";
import {
  deleteOrphanPiSessions,
  deletePiAgentSession,
  type KnownPiSessions,
  type PiOrphanOutcome,
} from "./provider-sessions-pi";
import { describe, str } from "./util";

export interface AgentRef {
  id: string;
  cwd: string | null;
}

export interface SessionFileOutcome {
  deleted: string[];
  failed: Array<{ agentId: string; error: string }>;
}

export interface OrphanSessionOutcome {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

interface AgentSessionRef {
  agentId: string;
  provider: string;
  sessionId: string | null;
  nativeHandle: string | null;
}

interface AgentRecordLike {
  provider?: unknown;
  persistence?: { sessionId?: unknown; nativeHandle?: unknown } | null;
}

/**
 * Deletes the provider's own session for each agent whose record names one. Used while purging
 * archived workspaces, before the records themselves are removed.
 *
 * The provider is dispatched through one `switch`; every provider keeps its own module, so adding
 * one is a new file and a new `case` and nothing else here changes.
 */
export async function deleteAgentSessionFiles(
  agents: readonly AgentRef[],
): Promise<SessionFileOutcome> {
  const deleted: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  for (const agent of agents) {
    try {
      const ref = await readAgentSessionRef(agent);
      if (!ref) {
        continue;
      }
      const removed = await deleteProviderSession(ref);
      if (removed) {
        deleted.push(removed);
      }
    } catch (error) {
      failed.push({ agentId: agent.id, error: describe(error) });
    }
  }
  return { deleted, failed };
}

async function deleteProviderSession(ref: AgentSessionRef): Promise<string | null> {
  switch (ref.provider) {
    case "pi":
      return deletePiAgentSession(ref.nativeHandle);
    default:
      return null;
  }
}

/** Providers the orphan sweep knows how to enumerate. Only pi today. */
const ORPHAN_PROVIDERS = ["pi"] as const;

/**
 * Deletes provider sessions that no Paseo agent record references — the ones a provider created and
 * keeps on its own, outside Paseo's management. Destructive and irreversible; it is off by default.
 *
 * The known set is built once from every agent record on disk, then each provider's sweep runs
 * against it. Everything provider-specific lives behind the `case`.
 */
export async function deleteOrphanProviderSessions(): Promise<OrphanSessionOutcome> {
  const known = await collectKnownSessions();
  const deleted: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];
  for (const provider of ORPHAN_PROVIDERS) {
    let outcome: PiOrphanOutcome;
    switch (provider) {
      case "pi":
        outcome = await deleteOrphanPiSessions(known.pi);
        break;
      default:
        continue;
    }
    deleted.push(...outcome.deleted);
    failed.push(...outcome.failed);
  }
  return { deleted, failed };
}

interface KnownSessions {
  pi: KnownPiSessions;
}

async function collectKnownSessions(): Promise<KnownSessions> {
  const pi: KnownPiSessions = { handles: new Set(), sessionIds: new Set() };
  for (const record of await readAllAgentRecords()) {
    if (str(record.provider) !== "pi") {
      continue;
    }
    const handle = str(record.persistence?.nativeHandle);
    if (handle) {
      pi.handles.add(handle);
    }
    const sessionId = str(record.persistence?.sessionId);
    if (sessionId) {
      pi.sessionIds.add(sessionId);
    }
  }
  return { pi };
}

async function readAgentSessionRef(agent: AgentRef): Promise<AgentSessionRef | null> {
  const record = (await readAgentRecord(agent)) as AgentRecordLike | null;
  const provider = str(record?.provider);
  if (!record || !provider) {
    return null;
  }
  return {
    agentId: agent.id,
    provider,
    sessionId: str(record.persistence?.sessionId),
    nativeHandle: str(record.persistence?.nativeHandle),
  };
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
  try {
    for (const entry of await readdir(join(paseoHome(), "agents"))) {
      const found = await readJson(join(paseoHome(), "agents", entry, `${agent.id}.json`));
      if (found !== null) {
        return found;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Every agent record the daemon has on disk, for the orphan sweep's known set. */
async function readAllAgentRecords(): Promise<AgentRecordLike[]> {
  const records: AgentRecordLike[] = [];
  const root = join(paseoHome(), "agents");
  let directories: string[];
  try {
    directories = await readdir(root);
  } catch {
    return records;
  }
  for (const directory of directories) {
    let files: string[];
    try {
      files = await readdir(join(root, directory));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const record = await readJson(join(root, directory, file));
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record as AgentRecordLike);
      }
    }
  }
  return records;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

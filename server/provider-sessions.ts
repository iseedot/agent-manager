import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { paseoHome } from "./daemon-mcp";
import { describe, str } from "./util";

export interface AgentRef {
  id: string;
  cwd: string | null;
}

export interface SessionFileOutcome {
  deleted: string[];
  failed: Array<{ agentId: string; error: string }>;
}

interface AgentRecordLike {
  provider?: unknown;
  persistence?: { nativeHandle?: unknown } | null;
}

/**
 * Deletes the provider's own session file for the given agents. pi only.
 *
 * pi writes the absolute path of its transcript into `persistence.nativeHandle` of the agent
 * record, so the file can be removed without guessing a layout. Every other provider either keeps
 * its transcript somewhere this plugin cannot know or names it with an id instead of a path, and a
 * guess there would risk deleting a file that was never ours.
 */
export async function deleteAgentSessionFiles(
  agents: readonly AgentRef[],
): Promise<SessionFileOutcome> {
  const deleted: string[] = [];
  const failed: Array<{ agentId: string; error: string }> = [];
  for (const agent of agents) {
    try {
      const file = await piSessionFile(agent);
      if (!file) {
        continue;
      }
      await rm(file, { force: true });
      deleted.push(file);
    } catch (error) {
      failed.push({ agentId: agent.id, error: describe(error) });
    }
  }
  return { deleted, failed };
}

async function piSessionFile(agent: AgentRef): Promise<string | null> {
  const record = (await readAgentRecord(agent)) as AgentRecordLike | null;
  if (!record || str(record.provider) !== "pi") {
    return null;
  }
  const handle = str(record.persistence?.nativeHandle);
  if (!handle || !isAbsolute(handle) || !handle.endsWith(".jsonl")) {
    return null;
  }
  return handle;
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

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

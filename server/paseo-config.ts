import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** The `worktree` scripts of a project's paseo.json — Paseo only runs them for its own worktrees. */
export interface WorktreeScripts {
  setup: string[];
  teardown: string[];
}

export async function readWorktreeScripts(repoRoot: string): Promise<WorktreeScripts> {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, "paseo.json"), "utf8")) as {
      worktree?: { setup?: unknown; teardown?: unknown };
    };
    return {
      setup: commandList(parsed?.worktree?.setup),
      teardown: commandList(parsed?.worktree?.teardown),
    };
  } catch {
    return { setup: [], teardown: [] };
  }
}

function commandList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

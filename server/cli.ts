import { execCommand } from "@getpaseo/plugin/server";

import { paseoHome } from "./daemon";

/**
 * Hard deletes go through the `paseo` CLI, so the daemon's own registries stay consistent. 0.11's
 * `execCommand` handles Windows `paseo.cmd`/`.bat` launchers and argv quoting for us.
 */

export function deleteAgent(agentId: string): Promise<void> {
  return runCli(["agent", "delete", agentId]);
}

/** `paseo project delete` removes the project and the workspace records it owns. */
export function deleteProject(projectId: string): Promise<void> {
  return runCli(["project", "delete", projectId]);
}

async function runCli(args: string[]): Promise<void> {
  const binary = process.env.PASEO_AGENT_MANAGER_CLI?.trim() || "paseo";
  const home = paseoHome();
  try {
    await execCommand(binary, [...args, "--home", home], {
      env: { ...process.env, PASEO_HOME: home },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(describeFailure(binary, error));
  }
}

function describeFailure(binary: string, error: unknown): string {
  const failure = error as {
    code?: string;
    stdout?: string;
    stderr?: string;
    message?: string;
  };
  if (failure.code === "ENOENT") {
    return `Command not found: ${binary}. Hard delete needs the paseo CLI on the daemon host PATH.`;
  }
  return (
    `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || "Delete failed"
  );
}

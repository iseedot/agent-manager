import { execCommand } from "@getpaseo/plugin/server";

import { paseoHome } from "./daemon-mcp";

interface CliResult {
  ok: boolean;
  output: string;
}

function resolveCliBinary(): string {
  const configured = process.env.PASEO_AGENT_MANAGER_CLI?.trim();
  return configured && configured.length > 0 ? configured : "paseo";
}

/**
 * Hard delete goes through the `paseo` CLI. 0.11 ships `execCommand`, which handles Windows
 * `paseo.cmd`/`.bat` launchers and argv quoting, so this no longer hand-rolls `spawn` and a
 * stdout/stderr promise.
 */
export async function deleteAgentViaCli(agentId: string): Promise<CliResult> {
  const binary = resolveCliBinary();
  const home = paseoHome();
  try {
    const { stdout, stderr } = await execCommand(binary, ["agent", "delete", agentId, "--home", home], {
      env: { ...process.env, PASEO_HOME: home },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const failure = error as {
      code?: string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (failure.code === "ENOENT") {
      return {
        ok: false,
        output: `Command not found: ${binary}. Hard delete needs the paseo CLI on the daemon host PATH.`,
      };
    }
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() || failure.message || "";
    return { ok: false, output: output || "Delete failed" };
  }
}

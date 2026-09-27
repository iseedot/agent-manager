import { spawn } from "node:child_process";

import { paseoHome } from "./daemon-mcp";

export interface CliResult {
  ok: boolean;
  output: string;
}

interface CliRun {
  code: number | null;
  output: string;
  error: Error | null;
}

function resolveCliBinary(): string {
  const configured = process.env.PASEO_AGENT_MANAGER_CLI?.trim();
  return configured && configured.length > 0 ? configured : "paseo";
}

export async function deleteAgentViaCli(agentId: string): Promise<CliResult> {
  const binary = resolveCliBinary();
  const run = await runCli(["agent", "delete", agentId, "--home", paseoHome()]);
  if (run.error) {
    return {
      ok: false,
      output:
        (run.error as NodeJS.ErrnoException).code === "ENOENT"
          ? `Command not found: ${binary}. Hard delete needs the paseo CLI on the daemon host PATH.`
          : run.error.message,
    };
  }
  return { ok: run.code === 0, output: run.output };
}

export async function isCliAvailable(): Promise<boolean> {
  cachedCliAvailability ??= runCli(["--version"]).then(
    (run) => !run.error && run.code === 0,
    () => false,
  );
  return cachedCliAvailability;
}

let cachedCliAvailability: Promise<boolean> | null = null;

function runCli(args: string[]): Promise<CliRun> {
  const binary = resolveCliBinary();
  const home = paseoHome();

  return new Promise<CliRun>((resolve) => {
    let settled = false;
    const finish = (value: CliRun) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = spawn(binary, args, {
        env: { ...process.env, PASEO_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ code: null, output: "", error: error as Error });
      return;
    }

    let output = "";
    const append = (chunk: unknown) => {
      output += String(chunk);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => finish({ code: null, output: output.trim(), error }));
    child.on("close", (code) => finish({ code, output: output.trim(), error: null }));
  });
}

import { spawn } from "node:child_process";

import { paseoHome } from "./daemon-mcp";

export interface CliResult {
  ok: boolean;
  output: string;
}

export function resolveCliBinary(): string {
  const configured = process.env.PASEO_AGENT_MANAGER_CLI?.trim();
  return configured && configured.length > 0 ? configured : "paseo";
}

export async function deleteAgentViaCli(agentId: string): Promise<CliResult> {
  const binary = resolveCliBinary();
  const home = paseoHome();
  const args = ["agent", "delete", agentId, "--home", home];

  return new Promise<CliResult>((resolve) => {
    let settled = false;
    const finish = (result: CliResult) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn(binary, args, {
        env: { ...process.env, PASEO_HOME: home },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ ok: false, message: describe(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        output:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? `Command not found: ${binary}. Hard delete needs the paseo CLI on the daemon host PATH.`
            : describe(error),
      });
    });
    child.on("close", (code) => {
      const combined = `${stdout}${stderr}`.trim();
      finish({ ok: code === 0, output: combined });
    });
  });
}

export async function isCliAvailable(): Promise<boolean> {
  cachedCliAvailability ??= probeCli();
  return cachedCliAvailability;
}

let cachedCliAvailability: Promise<boolean> | null = null;

async function probeCli(): Promise<boolean> {
  const binary = resolveCliBinary();
  const home = paseoHome();
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(binary, ["--version"], {
        env: { ...process.env, PASEO_HOME: home },
        stdio: "ignore",
      });
    } catch {
      finish(false);
      return;
    }
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

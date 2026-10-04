import { execFile } from "node:child_process";

/**
 * Runs a worktree script with the same environment Paseo gives its own scripts. Commands run
 * sequentially and stop at the first failure.
 */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface WorktreeScriptEnv {
  repoRoot: string;
  worktreePath: string;
  branch: string;
}

export interface WorktreeScriptResult {
  ok: boolean;
  failedCommand?: string;
  detail?: string;
}

export async function runWorktreeScripts(
  commands: readonly string[],
  env: WorktreeScriptEnv,
): Promise<WorktreeScriptResult> {
  const scriptEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PASEO_SOURCE_CHECKOUT_PATH: env.repoRoot,
    PASEO_ROOT_PATH: env.repoRoot,
    PASEO_WORKTREE_PATH: env.worktreePath,
    PASEO_BRANCH_NAME: env.branch,
  };
  for (const command of commands) {
    try {
      await runOne(command, env.worktreePath, scriptEnv);
    } catch (error) {
      return { ok: false, failedCommand: command, detail: describe(error) };
    }
  }
  return { ok: true };
}

function runOne(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, env, timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise();
          return;
        }
        const detail = [String(stdout ?? ""), String(stderr ?? "")]
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .join(" ")
          .slice(0, 300);
        rejectPromise(new Error(detail || describe(error)));
      },
    );
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

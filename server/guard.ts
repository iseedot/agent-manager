import { describe, serializeWrite, writeJsonAtomic } from "./util";
import { join } from "node:path";
import { paseoHome } from "./daemon-mcp";

const CRASH_PATH = "agent-manager/last-crash.json";

let installed = false;

export function installCrashGuards(): () => void {
  if (installed) {
    return () => {};
  }
  installed = true;

  const report = (kind: string, error: unknown) => {
    const payload = { kind, at: new Date().toISOString(), error: describe(error) };
    console.log(`agent-manager ${kind}: ${payload.error}`);
    void serializeWrite(() => writeJsonAtomic(join(paseoHome(), CRASH_PATH), payload)).catch(() => undefined);
  };

  const onRejection = (reason: unknown) => report("unhandled rejection", reason);
  const onException = (error: unknown) => report("uncaught exception", error);

  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);

  return () => {
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
    installed = false;
  };
}

export function fireAndForget(work: Promise<unknown>, label: string): void {
  void work.catch((error) => {
    console.log(`agent-manager ${label} failed: ${describe(error)}`);
  });
}

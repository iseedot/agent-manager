import { join } from "node:path";

import { paseoHome } from "./daemon";
import { describe, serializeWrite, writeJsonAtomic } from "./util";

const CRASH_PATH = "agent-manager/last-crash.json";

let installed = false;

/**
 * A plugin must never die silently: an unhandled rejection or exception is logged to the plugin log
 * and remembered in `last-crash.json` so there is something to read after the fact.
 */
export function installCrashGuards(): () => void {
  if (installed) {
    return () => {};
  }
  installed = true;

  const report = (kind: string, error: unknown) => {
    const message = describe(error);
    console.log(`agent-manager ${kind}: ${message}`);
    void serializeWrite(() =>
      writeJsonAtomic(join(paseoHome(), CRASH_PATH), {
        kind,
        at: new Date().toISOString(),
        error: message,
      }),
    ).catch(() => undefined);
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

import type { FactsPayload } from "../shared/contracts";
import type { PaseoLike } from "./agents";
import { readAutoReleaseStatus } from "./auto-release";
import { readSystemStats } from "./system";
import { listAllTerminals, summarizeTerminalPresence, type TerminalLister } from "./terminals";

/** The host line and terminal counts the pill popover shows. */
export async function buildFacts(paseo: PaseoLike): Promise<FactsPayload> {
  const [system, terminals, autoRelease] = await Promise.all([
    readSystemStats(),
    listAllTerminals(paseo as unknown as TerminalLister).catch(() => []),
    readAutoReleaseStatus().catch(() => null),
  ]);
  return {
    system,
    terminals: summarizeTerminalPresence(terminals),
    autoRelease: autoRelease ?? {
      lastRunAt: null,
      released: 0,
      skipped: 0,
      removedWorkspaces: 0,
      error: "auto-release status unavailable",
      nextRunAt: null,
      dueAt: null,
      running: false,
      idleMinutes: 10,
    },
  };
}

import type { FactsPayload } from "../shared/contracts";
import type { PaseoLike } from "./agents";
import { readSystemStats } from "./system";
import { listAllTerminals, summarizeTerminalPresence, type TerminalLister } from "./terminals";

/** The host line and terminal counts the pill popover shows. */
export async function buildFacts(paseo: PaseoLike): Promise<FactsPayload> {
  const [system, terminals] = await Promise.all([
    readSystemStats(),
    listAllTerminals(paseo as unknown as TerminalLister).catch(() => []),
  ]);
  return { system, terminals: summarizeTerminalPresence(terminals) };
}

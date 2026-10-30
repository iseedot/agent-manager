import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import {
  hashAccountKey,
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";

import { piAgentDir } from "./pi-sessions";
import { usageInputSchema, type UsageInput } from "../shared/usage-input";

/**
 * An OpenCode Go quota card for the subscription used through pi.
 *
 * Paseo ships an `opencode-go` source, but it only reads the OpenCode CLI store
 * (`~/.local/share/opencode/auth.json`, entry `{ type: "api", key }`). pi keeps the same provider in
 * its own store (`<agent-dir>/auth.json`, entry `{ type: "api_key", key }`), so it is invisible to
 * the built-in source. This closes that gap. Merged here from the separate `pi-opencode-go-usage`
 * plugin: one process for both features, and the source id is unchanged so cached accounts still
 * match.
 */

export const usageSourceId = "pi-opencode-go";

const authSchema = z
  .object({
    "opencode-go": z
      .object({ type: z.literal("api_key"), key: z.string().min(1) })
      .passthrough()
      .optional(),
  })
  .passthrough();

const windowSchema = z.object({
  status: z.enum(["ok", "rate-limited"]),
  percent: z.number().finite(),
  resetsAt: z.iso.datetime(),
});
const responseSchema = z.object({
  usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }),
});

/** pi keeps its per-agent state under `~/.pi/agent`; `PI_CODING_AGENT_DIR` overrides the base. */
export function piAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.PI_CODING_AGENT_DIR?.trim() || piAgentDir();
  return join(base, "auth.json");
}

export async function readPiOpenCodeGoKey(path = piAuthPath()): Promise<string | null> {
  try {
    const auth = authSchema.parse(JSON.parse(await readFile(path, "utf8")));
    return auth["opencode-go"]?.key ?? null;
  } catch {
    return null;
  }
}

/** The quota is account-wide, not per session, so only a global discovery is offered. */
export async function discoverPiOpenCodeGoAccounts(): Promise<UsageAccount[]> {
  const path = piAuthPath();
  return (await readPiOpenCodeGoKey(path)) ? [{ key: hashAccountKey(path), input: { path } }] : [];
}

export async function fetchPiOpenCodeGoUsage(
  input: UsageInput,
  fetchApi: typeof fetch = fetch,
): Promise<UsageReport> {
  // Re-read on every fetch so a pi re-login (token rotation) takes effect without rediscovery.
  const apiKey = await readPiOpenCodeGoKey(input.path);
  if (!apiKey) {
    throw new Error("Pi OpenCode Go login store no longer exists");
  }
  const response = await fetchApi("https://opencode.ai/zen/go/v1/usage", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    return unavailable({ kind: "rejected", status: response.status, refreshedBy: "pi" });
  }
  if (!response.ok) {
    throw new Error(`OpenCode Go usage API returned ${response.status}`);
  }
  const data = responseSchema.parse(await response.json());
  const windows = (
    [
      // The rolling window does not report its length, so its percent stands without a name.
      ["rolling", "Rolling", "", data.usage.rolling],
      ["weekly", "Weekly", "wk", data.usage.weekly],
      ["monthly", "Monthly", "mo", data.usage.monthly],
    ] as const
  ).map(([id, label, shortLabel, value]) =>
    windowFromUsedPct({
      id,
      label,
      shortLabel,
      utilizationPct: value.percent,
      resetsAt: value.resetsAt,
      tone: toneFromUsedPct(value.percent),
    }),
  );
  return { status: "available", planLabel: "Go", windows };
}

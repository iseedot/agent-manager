import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";

import { factsRpc, type FactsPayload } from "../shared/contracts";

/**
 * Host metrics for the pill: the sheet heading on a phone and the popover body read the same
 * snapshot, so the numbers are fetched once a minute by one poll instead of on every open.
 */
const POLL_MS = 60000;

let snapshot: FactsPayload | null = null;
let context: PluginClientContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      continue;
    }
  }
}

export function subscribeHostFacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function startHostFacts(client: PluginClientContext): () => void {
  context = client;
  void refreshHostFacts();
  timer = setInterval(() => {
    void refreshHostFacts();
  }, POLL_MS);
  return () => {
    if (timer) {
      clearInterval(timer);
    }
    timer = null;
    context = null;
    snapshot = null;
    emit();
  };
}

async function refreshHostFacts(): Promise<void> {
  const active = context;
  if (!active) {
    return;
  }
  try {
    snapshot = await active.rpc(factsRpc, {});
  } catch {
    // Keep the last snapshot: one failed read should not blank the popover.
    return;
  }
  emit();
}

export function hostFactsSnapshot(): FactsPayload | null {
  return snapshot;
}

export function useHostFacts(): FactsPayload | null {
  return useSyncExternalStore(subscribeHostFacts, hostFactsSnapshot, hostFactsSnapshot);
}

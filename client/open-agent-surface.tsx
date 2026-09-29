import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";

import { message } from "./format";
import { consumeNewAgentRequest, resolveNewAgentConfig } from "./new-agent-button";

const NAVIGATE_RETRY_MS = [400, 1200, 2400];

export function OpenAgentSurface({ navigation, host, theme }: PluginSurfaceProps) {
  const request = useRef(consumeNewAgentRequest()).current;
  const [agentId, setAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const config = await resolveNewAgentConfig(request.paseo, request.workspaceId);
        const handle = await request.paseo.workspaces.ref(request.workspaceId).agents.create({ config });
        const created = typeof handle?.id === "string" && handle.id.length > 0 ? handle.id : null;
        if (!cancelled) {
          if (created) {
            setAgentId(created);
          } else {
            setError("The daemon did not return a session id.");
          }
        }
      } catch (createError) {
        if (!cancelled) {
          setError(message(createError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    const hasDom = typeof (globalThis as { document?: unknown }).document !== "undefined";
    if (!hasDom) {
      void openDeepLink(host.id, agentId);
    }
    const timers = NAVIGATE_RETRY_MS.map((delay) =>
      setTimeout(() => {
        try {
          navigation?.openAgent({ agentId });
        } catch {
          return;
        }
      }, delay),
    );
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [agentId, host.id, navigation]);

  const text = error
    ? `Could not create the session: ${error}`
    : agentId
      ? "Opening the new session…"
      : "Creating the session…";

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      {error ? null : <ActivityIndicator />}
      <Text style={{ color: theme?.colors?.foregroundMuted, fontSize: 12, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

async function openDeepLink(serverId: string, agentId: string): Promise<void> {
  const link = (Linking ?? {}) as {
    canOpenURL?: (url: string) => Promise<boolean>;
    openURL?: (url: string) => Promise<unknown>;
  };
  if (typeof link.openURL !== "function") {
    return;
  }
  try {
    if (typeof link.canOpenURL === "function" && !(await link.canOpenURL("paseo:"))) {
      return;
    }
    await link.openURL(`paseo:/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`);
  } catch {
    return;
  }
}

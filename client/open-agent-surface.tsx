import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";

import { message } from "./format";
import {
  consumeAgentFocus,
  consumeNewAgentRequest,
  markFocusSurfaceMounted,
  resolveNewAgentConfig,
  subscribeComposerRequests,
  unmarkFocusSurfaceMounted,
  type NewAgentRequest,
} from "./new-agent-button";

const NAVIGATE_RETRY_MS = [400, 1200, 2400];

interface Pending {
  agentId: string | null;
  request: NewAgentRequest | null;
}

function takePending(): Pending {
  const agentId = consumeAgentFocus();
  const request = consumeNewAgentRequest();
  return { agentId, request: agentId ? null : request };
}

export function OpenAgentSurface({ navigation, host, theme }: PluginSurfaceProps) {
  const [initial] = useState(takePending);
  const [agentId, setAgentId] = useState<string | null>(initial.agentId);
  const [request, setRequest] = useState<NewAgentRequest | null>(initial.request);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () => {
      markFocusSurfaceMounted();
      const unsubscribe = subscribeComposerRequests(() => {
        const next = takePending();
        if (next.agentId) {
          setError(null);
          setRequest(null);
          setCreated(false);
          setAgentId(next.agentId);
          return;
        }
        if (next.request) {
          setError(null);
          setCreated(false);
          setRequest(next.request);
        }
      });
      return () => {
        unsubscribe();
        unmarkFocusSurfaceMounted();
      };
    },
    [],
  );

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const config = await resolveNewAgentConfig(request.paseo, request.workspaceId);
        const handle = await request.paseo.workspaces.ref(request.workspaceId).agents.create({ config });
        const createdId = typeof handle?.id === "string" && handle.id.length > 0 ? handle.id : null;
        if (!cancelled) {
          if (createdId) {
            setCreated(true);
            setAgentId(createdId);
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

  let text: string;
  if (error) {
    text = `Could not create the session: ${error}`;
  } else if (agentId) {
    text = navigation
      ? created
        ? "Opening the new session…"
        : "Switching to the tab…"
      : "This host cannot switch sessions.";
  } else if (request) {
    text = "Creating the session…";
  } else {
    text = "Nothing to open.";
  }

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      {error || (!agentId && !request) ? null : <ActivityIndicator />}
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

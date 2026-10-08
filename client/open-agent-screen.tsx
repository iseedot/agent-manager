import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Text, View } from "react-native";

import { resolveNewAgentConfig, type AgentConfig } from "./new-agent-button";

const NAVIGATE_RETRY_MS = [400, 1200, 2400];

/**
 * New in 0.11: a screen receives its `params` from the URL, so the agent id (or the workspace to
 * create in) travels with the navigation instead of through module state. `usePaseo()` supplies the
 * SDK that the deprecated surface had to receive through a callback.
 */
export function OpenAgentScreen({ navigation, host, theme, params }: PluginScreenProps) {
  const paseo = usePaseo();
  const requestedAgentId = params.agentId ?? null;
  const workspaceId = params.workspaceId ?? null;
  const nonce = params.nonce ?? "";
  const [agentId, setAgentId] = useState<string | null>(requestedAgentId);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    if (requestedAgentId) {
      setError(null);
      setCreated(false);
      setAgentId(requestedAgentId);
      return;
    }
    if (!workspaceId) {
      setError("Nothing to open.");
      return;
    }
    let cancelled = false;
    setError(null);
    setCreated(false);
    setAgentId(null);
    void createSession(paseo, workspaceId, `${workspaceId}:${nonce}`)
      .then((createdId) => {
        if (cancelled) {
          return;
        }
        if (!createdId) {
          setError("The daemon did not return a session id.");
          return;
        }
        setCreated(true);
        setAgentId(createdId);
      })
      .catch((createError: unknown) => {
        if (!cancelled) {
          setError(createError instanceof Error ? createError.message : String(createError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [paseo, requestedAgentId, workspaceId, nonce]);

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
  } else if (workspaceId) {
    text = "Creating the session…";
  } else {
    text = "Nothing to open.";
  }

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 }}>
      {error || !agentId ? null : <ActivityIndicator />}
      <Text style={{ color: theme?.colors?.foregroundMuted, fontSize: 12, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

/**
 * One in-flight creation per params key, so React's development double-invoke cannot create two
 * sessions for the same press.
 */
const creations = new Map<string, Promise<string | null>>();

function createSession(
  paseo: ReturnType<typeof usePaseo>,
  workspaceId: string,
  key: string,
): Promise<string | null> {
  const existing = creations.get(key);
  if (existing) {
    return existing;
  }
  const promise = (async () => {
    const config: AgentConfig = await resolveNewAgentConfig(paseo, workspaceId);
    const handle = (await paseo.workspaces.ref(workspaceId).agents.create({ config })) as
      | { id?: unknown }
      | null;
    return typeof handle?.id === "string" && handle.id.length > 0 ? handle.id : null;
  })().finally(() => {
    creations.delete(key);
  });
  creations.set(key, promise);
  return promise;
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

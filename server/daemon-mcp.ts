import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_LISTEN = "127.0.0.1:6767";

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".paseo");
}

export interface DaemonConfig { 
  listen: string | null;
  version: string | null;
  password: string | null;
}

export interface DaemonAddress {
  host: string;
  port: string;
}

export async function readDaemonConfig(): Promise<DaemonConfig> {
  try {
    const raw = await readFile(join(paseoHome(), "config.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      daemon?: { listen?: unknown; password?: unknown };
    };
    return {
      listen: trim(parsed.daemon?.listen),
      version: trim(parsed.version),
      password: trim(parsed.daemon?.password),
    };
  } catch {
    return { listen: null, version: null, password: null };
  }
}

export async function resolveDaemonAddress(): Promise<DaemonAddress | null> {
  const config = await readDaemonConfig();
  return normalizeListenAddress(config.listen ?? DEFAULT_LISTEN);
}

export async function resolveMcpEndpoint(): Promise<string> {
  const override = process.env.PASEO_AGENT_MANAGER_MCP_URL?.trim();
  if (override) {
    return override;
  }

  const address = await resolveDaemonAddress();
  if (!address) {
    throw new Error("Cannot reach the daemon over HTTP: daemon.listen is not a host:port");
  }
  return `http://${address.host}:${address.port}/mcp/agents`;
}

function trim(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeListenAddress(listen: string): DaemonAddress | null {
  if (listen.startsWith("/") || listen.startsWith(".")) {
    return null;
  }
  const withoutScheme = listen.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const [host, port] = withoutScheme.split(":");
  if (!host || !port || !/^\d+$/.test(port)) {
    return null;
  }
  const reachableHost =
    host === "0.0.0.0" || host === "::" || host === "[::]" || host === "::0" ? "127.0.0.1" : host;
  return { host: reachableHost, port };
}

export async function killAgentViaDaemonMcp(agentId: string): Promise<void> {
  const endpoint = await resolveMcpEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "kill_agent", arguments: { agentId } },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(describeHttpFailure(response.status, text));
  }

  const payload = parseJsonRpcPayload(text);
  if (!payload) {
    throw new Error(`Unexpected daemon MCP response: ${text.slice(0, 200)}`);
  }
  const error = payload.error as { message?: unknown } | undefined;
  if (error) {
    throw new Error(typeof error.message === "string" ? error.message : "kill_agent failed");
  }
  const result = payload.result as { isError?: unknown; content?: unknown } | undefined;
  if (result?.isError === true) {
    throw new Error(readTextContent(result.content) ?? "kill_agent reported an error");
  }
}

function describeHttpFailure(status: number, body: string): string {
  if (status === 401) {
    return "The daemon rejected the MCP call (401). This daemon has a password set, so the capability-token route is unavailable.";
  }
  if (status === 404) {
    return "The daemon MCP route is disabled (404). Enable daemon.mcp in the daemon config.";
  }
  return `Daemon MCP call failed (${status}): ${body.slice(0, 200)}`;
}

function parseJsonRpcPayload(text: string): { error?: unknown; result?: unknown } | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as { error?: unknown; result?: unknown };
    } catch {
      return null;
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    const data = line.startsWith("data:") ? line.slice("data:".length).trim() : "";
    if (!data.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(data) as { error?: unknown; result?: unknown };
    } catch {
      continue;
    }
  }
  return null;
}

function readTextContent(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  const parts = content
    .map((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? ((part as { text: string }).text ?? "")
        : "",
    )
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
}

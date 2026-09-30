import { beginDaemonClientUse, endDaemonClientUse, getDaemonClient } from "./daemon-client";
import { describe } from "./util";

export async function restoreAgent(agentId: string): Promise<{ ok: boolean; message: string }> {
  beginDaemonClientUse();
  try {
    const client = await getDaemonClient();
    await client.refreshAgent(agentId);
    return { ok: true, message: "Session restored and opened." };
  } catch (error) {
    return { ok: false, message: describe(error) };
  } finally {
    endDaemonClientUse();
  }
}

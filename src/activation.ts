import type { PluginServerContext } from "@getpaseo/plugin/server";
import { lookbackHours, watchDiscovery } from "./discovery.js";
import { errorMessage } from "./errors.js";
import { AGENT_ID_ENV, PROVIDER_ID } from "./ids.js";
import { connectPaseoHost } from "./paseo-client.js";
import { createGrokProvider } from "./provider.js";
import { TitleSync } from "./title-sync.js";

export function registerBridge(server: PluginServerContext): () => Promise<void> {
  const paseoHome = process.env["PASEO_HOME"];
  if (!paseoHome) throw new Error("Paseo must supply PASEO_HOME for Grok session discovery");
  const hours = lookbackHours();
  const controller = new AbortController();
  const titles = new TitleSync(async (batch) => {
    const connection = await connectPaseoHost(paseoHome, controller.signal);
    try {
      for (const [agentId, title] of batch) {
        try {
          await connection.setTitle(agentId, title);
        } catch (error) {
          console.error(`Grok title for agent ${agentId} not applied:`, errorMessage(error));
        }
      }
    } finally {
      await connection.close();
    }
  });
  server.registerProvider(createGrokProvider({ onTitle: titles.update }));
  // The provider learns which Paseo agent a session belongs to from its environment.
  const removeBefore = server.before("agent.session_open", ({ request }) => {
    if (request.provider !== PROVIDER_ID) return;
    return { ...request, env: { ...request.env, [AGENT_ID_ENV]: request.agentId } };
  });
  // Registration must return before Paseo publishes this provider and accepts connections.
  const discovery = watchDiscovery(
    () => connectPaseoHost(paseoHome, controller.signal),
    controller.signal,
    (error) => {
      console.error("Grok discovery failed; retrying:", errorMessage(error));
    },
    { lookbackHours: hours },
  );
  void discovery.catch((error) => {
    console.error("Grok discovery stopped:", error);
  });
  return async () => {
    controller.abort();
    try {
      await discovery;
      await titles.stop();
    } finally {
      removeBefore();
    }
  };
}

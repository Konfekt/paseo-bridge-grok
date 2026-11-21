import { randomUUID } from "node:crypto";
import { createHostClient } from "@getpaseo/client/node";
// FALLBACK: Paseo's daemon-control export pulls createRequire(import.meta.url)
// into its CommonJS plugin bundle. Import the pinned owning modules until that export is bundle-safe.
import { readLocalCredentialForTarget } from "../node_modules/@getpaseo/server/dist/server/server/local-credential.js";
import { resolvePaseoHome } from "../node_modules/@getpaseo/server/dist/server/server/paseo-home.js";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
} from "../node_modules/@getpaseo/server/dist/server/server/pid-lock.js";
import type { AttachedAgent, DiscoveryClient } from "./discovery.js";
import { PROVIDER_ID } from "./ids.js";
import {
  importIntoSessionWorkspace,
  sessionWorkspaceTitle,
  WORKSPACE_LABEL,
} from "./session-workspace.js";
import { warnTentativePaseo } from "./versions.js";

const DIRECTORY_PAGE_SIZE = 200;
const MAX_DIRECTORY_PAGES = 100;
const MAX_DISCOVERED_SESSIONS = 200;
const CONNECTION_TIMEOUT_MS = 10_000;

export type HostClient = ReturnType<typeof createHostClient>;

export interface PaseoHostConnection {
  client: HostClient;
  discovery: DiscoveryClient;
  /** Show Grok's session title on the agent and on the workspace the bridge created for it. */
  setTitle(agentId: string, title: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connect to the Paseo daemon of `home` the way Paseo's CLI does: its address comes from
 * `paseo.pid` (any TCP or Unix-socket listener), and a password-protected daemon admits the
 * local credential file, so no password is configured.
 */
export async function connectPaseoHost(
  home?: string,
  signal?: AbortSignal,
): Promise<PaseoHostConnection> {
  const paseoHome = resolvePaseoHome(home ? { PASEO_HOME: home } : process.env);
  signal?.throwIfAborted();
  const instance = await getPidLockInfo(paseoHome);
  signal?.throwIfAborted();
  if (!instance || !isPidLockOwnerRunning(instance))
    throw new Error(`Paseo is not running for ${paseoHome}`);
  const { listen } = instance;
  if (!listen) throw new Error(`Paseo is not ready for ${paseoHome}`);
  const client = createHostClient(listen, {
    clientId: randomUUID(),
    clientType: "cli",
    localCredential: () => readLocalCredentialForTarget(paseoHome, listen) ?? undefined,
    connectTimeoutMs: CONNECTION_TIMEOUT_MS,
    reconnect: { enabled: false },
  });
  const abort = () => {
    void client.close();
  };
  signal?.addEventListener("abort", abort, { once: true });
  const close = async () => {
    signal?.removeEventListener("abort", abort);
    await client.close();
  };
  try {
    await client.connect();
    signal?.throwIfAborted();
    warnTentativePaseo(client.getLastServerInfoMessage()?.version);
    return {
      client,
      close,
      async setTitle(agentId, title) {
        const text = sessionWorkspaceTitle({ title });
        if (!text) return;
        const result = await client.fetchAgent(agentId);
        const agent = result?.agent as
          | { title?: string | null; workspaceId?: string | null; labels?: Record<string, string> }
          | undefined;
        if (!agent) return;
        if (agent.title !== text) await client.updateAgent(agentId, { name: text });
        const workspaceId = agent.labels?.[WORKSPACE_LABEL];
        if (workspaceId && agent.workspaceId === workspaceId)
          await client.setWorkspaceTitle(workspaceId, text);
      },
      discovery: {
        async warmProvider() {
          // Requesting the snapshot makes Paseo load stale provider entries, which
          // connects this provider's runtime and enables its session listing.
          const provider = (await client.getProvidersSnapshot()).entries.find(
            (entry) => entry.provider === PROVIDER_ID,
          );
          if (provider?.status === "error" || provider?.status === "unavailable")
            throw new Error(
              `Grok Terminal provider is ${provider.status}${provider.error ? `: ${provider.error}` : ""}`,
            );
        },
        async sessions(since) {
          const response = await client.fetchRecentProviderSessions({
            providers: [PROVIDER_ID],
            since,
            limit: MAX_DISCOVERED_SESSIONS,
          });
          const providerError = response.providerErrors?.find(
            (error) => error.provider === PROVIDER_ID,
          );
          if (providerError) throw new Error(providerError.message);
          return response.entries;
        },
        async agents() {
          const agents: AttachedAgent[] = [];
          let cursor: string | undefined;
          for (let pageIndex = 0; pageIndex < MAX_DIRECTORY_PAGES; pageIndex++) {
            const response = await client.fetchAgents({
              filter: { includeArchived: true, includeBackground: true },
              page: { limit: DIRECTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
            });
            agents.push(...response.entries.map((entry) => entry.agent as AttachedAgent));
            if (!response.pageInfo.hasMore) return agents;
            const nextCursor = response.pageInfo.nextCursor;
            if (!nextCursor || nextCursor === cursor)
              throw new Error("Paseo directory pagination did not advance");
            cursor = nextCursor;
          }
          throw new Error("Paseo directory page limit reached");
        },
        async importSession(session) {
          return (await importIntoSessionWorkspace(
            {
              importAgent: (input) => client.importAgent(input),
              createWorkspace: (input) => client.createWorkspace(input),
            },
            session,
          )) as AttachedAgent;
        },
        async load(agentId) {
          await client.fetchAgentTimeline(agentId, { direction: "tail", limit: 1 });
        },
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

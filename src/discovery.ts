import { setTimeout as delay } from "node:timers/promises";
import { errorMessage } from "./errors.js";
import { PROVIDER_ID } from "./ids.js";
import { ArchivedWorkspaceError } from "./session-workspace.js";

export interface DiscoverableSession {
  providerId: string;
  providerHandleId: string;
  cwd: string;
  title?: string | null | undefined;
  firstPromptPreview?: string | null | undefined;
}
export interface AttachedAgent {
  id: string;
  provider: string;
  persistence: { sessionId?: string; nativeHandle?: string } | null;
  archivedAt?: string | null | undefined;
}
export interface DiscoveryClient {
  /** Paseo lists a plugin provider's sessions only after its runtime has connected,
   * which otherwise happens only when an app refreshes providers or opens an agent. */
  warmProvider(): Promise<void>;
  /** Sessions Paseo has not imported yet, active since `since`. */
  sessions(since: string): Promise<DiscoverableSession[]>;
  agents(): Promise<AttachedAgent[]>;
  importSession(session: DiscoverableSession): Promise<AttachedAgent>;
  /** Make Paseo load an agent, which attaches it to Grok's leader again. */
  load(agentId: string): Promise<void>;
}

export interface DiscoveryState {
  /** Sessions whose own workspace was archived; they are not imported again. */
  skipped: Set<string>;
}

/** Default import window: sessions active in the last day. */
export const DEFAULT_LOOKBACK_HOURS = 24;

export function lookbackHours(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env["PASEO_BRIDGE_GROK_LOOKBACK_HOURS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_LOOKBACK_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0)
    throw new Error(`PASEO_BRIDGE_GROK_LOOKBACK_HOURS must be a positive number; got ${raw}`);
  return hours;
}

function decodeHandle(handle: string): string | undefined {
  if (!handle.startsWith("plugin:")) return undefined;
  try {
    const data = (JSON.parse(handle.slice("plugin:".length)) as { data?: { sessionId?: unknown } })
      .data;
    return typeof data?.sessionId === "string" ? data.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function attachedTo(agent: AttachedAgent, session: DiscoverableSession): boolean {
  if (agent.provider !== PROVIDER_ID || !agent.persistence) return false;
  const handles = [agent.persistence.sessionId, agent.persistence.nativeHandle].filter(Boolean);
  if (handles.includes(session.providerHandleId)) return true;
  const native = decodeHandle(session.providerHandleId);
  return (
    native !== undefined &&
    handles.some((handle) => handle === native || decodeHandle(handle ?? "") === native)
  );
}

export async function discoverOnce(
  client: DiscoveryClient,
  options: { since: string; state?: DiscoveryState },
  signal?: AbortSignal,
): Promise<{ imported: string[] }> {
  const state = options.state ?? { skipped: new Set<string>() };
  signal?.throwIfAborted();
  await client.warmProvider();
  signal?.throwIfAborted();
  const sessions = await client.sessions(options.since);
  signal?.throwIfAborted();
  const agents = await client.agents();
  const failures: Error[] = [];
  const imported: string[] = [];
  const recordFailure = (identity: string, cause: unknown) => {
    signal?.throwIfAborted();
    failures.push(new Error(`${identity}: ${errorMessage(cause)}`, { cause }));
  };
  for (const agent of agents) {
    signal?.throwIfAborted();
    if (agent.provider !== PROVIDER_ID || agent.archivedAt || !agent.persistence) continue;
    try {
      await client.load(agent.id);
    } catch (error) {
      recordFailure(`Agent ${agent.id}`, error);
    }
  }
  for (const session of sessions) {
    signal?.throwIfAborted();
    if (session.providerId !== PROVIDER_ID || state.skipped.has(session.providerHandleId)) continue;
    if (agents.some((agent) => attachedTo(agent, session))) continue;
    try {
      const agent = await client.importSession(session);
      agents.push(agent);
      imported.push(agent.id);
    } catch (error) {
      if (error instanceof ArchivedWorkspaceError) {
        state.skipped.add(session.providerHandleId);
        console.warn(error.message);
        continue;
      }
      // An import can succeed before its response is lost, or race another worker.
      let reconciled: AttachedAgent | undefined;
      try {
        reconciled = (await client.agents()).find((agent) => attachedTo(agent, session));
      } catch {
        // The original import error is the actionable one; later sessions still proceed.
      }
      if (!reconciled) recordFailure(`Session ${session.providerHandleId}`, error);
      else agents.push(reconciled);
    }
  }
  if (failures.length)
    throw new AggregateError(
      failures,
      `Grok discovery failures: ${failures.map((error) => error.message).join("; ")}`,
    );
  return { imported };
}

const POLL_INTERVAL_MS = 3_000;
const MAX_RETRY_DELAY_MS = 30_000;

export async function watchDiscovery(
  connect: () => Promise<{ discovery: DiscoveryClient; close(): Promise<void> }>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
  options: { lookbackHours?: number; pollIntervalMs?: number } = {},
): Promise<void> {
  const state: DiscoveryState = { skipped: new Set() };
  const lookbackMs = (options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  let retryDelayMs = pollIntervalMs;
  while (!signal.aborted) {
    let connection: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      connection = await connect();
      const since = new Date(Date.now() - lookbackMs).toISOString();
      await discoverOnce(connection.discovery, { since, state }, signal);
      retryDelayMs = pollIntervalMs;
    } catch (error) {
      if (!signal.aborted) {
        onError(error);
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    } finally {
      // A failed close must not end the loop; the next pass opens a fresh connection.
      await connection?.close().catch((error: unknown) => {
        if (!signal.aborted) onError(error);
      });
    }
    if (signal.aborted) return;
    try {
      await delay(retryDelayMs, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}

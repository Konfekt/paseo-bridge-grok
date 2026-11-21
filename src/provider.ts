import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { AGENT_ID_ENV, PROVIDER_ID } from "./ids.js";
import type { BridgeSignal } from "./interceptor.js";
import { agentLaunch, DEFAULT_COMMAND, grokStatus } from "./launch.js";
import { enrichCatalog, type ModelState } from "./models.js";
import { type GrokStream, spawnGrokStream } from "./stream.js";

export { AGENT_ID_ENV, PROVIDER_ID };

export const PROVIDER_LABEL = "Grok Terminal";

/** Delay before a terminal turn's end is reported, so Paseo applies its last streamed
 * updates first: Paseo's ACP client dispatches session updates asynchronously. */
const TURN_END_DELAY_MS = 50;

export interface GrokProviderOptions {
  /** Grok renamed the session of a Paseo agent. */
  onTitle?(agentId: string, title: string): void;
  warn?(message: string): void;
}

type Listener = (event: ProviderEvent) => void;

function nativeSessionId(persistence: unknown): string | undefined {
  const data = (persistence as { data?: { sessionId?: unknown } } | undefined)?.data;
  return typeof data?.sessionId === "string" ? data.sessionId : undefined;
}

/**
 * Attaching to an existing session keeps the session's own model, effort and mode: the
 * terminal owns them, and the values Paseo stored at an earlier open may be stale.
 */
function keepNativeSettings(input: ProviderInput): ProviderInput {
  if (input.type !== "session.open" || !input.persistence) return input;
  const {
    model: _model,
    mode: _mode,
    thinkingOption: _thinking,
    providerOptions: _options,
    ...config
  } = input.config;
  return { ...input, config: { ...config, settings: {} } };
}

/**
 * Wrap Paseo's ACP connection: synthesize turn events for turns the terminal starts,
 * which ACP does not report to other clients, and pass title changes on.
 */
export function wrapConnection(
  inner: ProviderConnection,
  streams: Set<GrokStream>,
  subscribe: (listener: (signal: BridgeSignal) => void) => void,
  options: GrokProviderOptions,
): ProviderConnection {
  const listeners = new Set<Listener>();
  const boundaryByNative = new Map<string, string>();
  const ready = new Set<string>();
  const agentByBoundary = new Map<string, string>();
  const turnByBoundary = new Map<string, string>();
  const timers = new Set<NodeJS.Timeout>();
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };
  const startTurn = (
    sessionId: string,
    turnId: string,
    userMessage?: { id: string; text: string },
  ) => {
    if (turnByBoundary.get(sessionId) === turnId) return;
    turnByBoundary.set(sessionId, turnId);
    if (userMessage)
      emit({
        type: "timeline.item",
        sessionId,
        item: { type: "user_message", id: userMessage.id, text: userMessage.text },
      });
    emit({ type: "session.turn", sessionId, turnId, state: "started" });
  };
  subscribe((signal) => {
    const sessionId = boundaryByNative.get(signal.nativeSessionId);
    if (signal.type === "title") {
      const agentId = sessionId ? agentByBoundary.get(sessionId) : undefined;
      if (agentId) options.onTitle?.(agentId, signal.title);
      return;
    }
    if (!sessionId || !ready.has(sessionId)) return;
    if (signal.type === "turn.started") {
      startTurn(sessionId, signal.turnId, signal.userMessage);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (turnByBoundary.get(sessionId) !== signal.turnId) return;
      turnByBoundary.delete(sessionId);
      emit({
        type: "session.turn",
        sessionId,
        turnId: signal.turnId,
        state: signal.state,
        ...(signal.error ? { error: { message: signal.error } } : {}),
      });
    }, TURN_END_DELAY_MS);
    timers.add(timer);
  });
  const forget = (sessionId: string) => {
    ready.delete(sessionId);
    turnByBoundary.delete(sessionId);
    agentByBoundary.delete(sessionId);
    for (const [native, boundary] of boundaryByNative)
      if (boundary === sessionId) boundaryByNative.delete(native);
  };
  inner.onEvent((event) => {
    if (event.type === "session.opened") {
      const native = nativeSessionId(event.persistence);
      if (native) boundaryByNative.set(native, event.sessionId);
    }
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      const turnId = turnByBoundary.get(event.sessionId);
      if (turnId)
        emit({
          type: "session.turn",
          sessionId: event.sessionId,
          turnId,
          state: "failed",
          error: { message: "Detached from Grok Build while a terminal turn was running" },
        });
      forget(event.sessionId);
    }
    emit(event);
    if (event.type === "session.ready") {
      ready.add(event.sessionId);
      // A terminal turn that was already running when Paseo attached.
      for (const stream of streams) {
        const native = stream.interceptor.nativeSessionId;
        const foreign = stream.interceptor.foreignTurn;
        if (native && foreign && boundaryByNative.get(native) === event.sessionId)
          startTurn(event.sessionId, foreign.turnId);
      }
    }
  });
  return {
    version: inner.version,
    capabilities: inner.capabilities,
    async send(input) {
      if (input.type === "session.open") {
        const agentId = input.config.env[AGENT_ID_ENV];
        if (agentId) agentByBoundary.set(input.sessionId, agentId);
      }
      await inner.send(keepNativeSettings(input));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await inner.close();
    },
  };
}

/** The **Grok Terminal** provider: Paseo's ACP client attached through Grok's shared leader. */
export function createGrokProvider(options: GrokProviderOptions = {}): ProviderRegistration {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let modelState: ModelState | null = null;
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    description: "Grok Build sessions shared with a terminal through Grok's leader",
    command: [...DEFAULT_COMMAND],
    status: (request) => grokStatus(request.launch),
    async connect(request) {
      const launch = agentLaunch(request.launch);
      const streams = new Set<GrokStream>();
      const subscribers = new Set<(signal: BridgeSignal) => void>();
      const acp = runAcpProvider({
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        acpOptions: { startupTimeoutMs: 30_000 },
        transformers: [{ discover: (catalog) => enrichCatalog(catalog, modelState) }],
        async connector() {
          let stream: GrokStream | undefined;
          stream = await spawnGrokStream(
            launch,
            {
              signal: (signal) => {
                for (const subscriber of subscribers) subscriber(signal);
              },
              modelState: (state) => {
                modelState = state;
              },
              warn,
            },
            () => {
              if (stream) streams.delete(stream);
            },
          );
          streams.add(stream);
          return stream;
        },
      });
      const inner = await acp.connect(request);
      return wrapConnection(inner, streams, (listener) => subscribers.add(listener), options);
    },
  };
}

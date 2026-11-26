import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { CommandRunner, isPlanOff } from "./command-runner.js";
import {
  BRIDGE_COMMANDS,
  parseSlashCommand,
  readDocumentedCommands,
  routeCommand,
  TERMINAL_COMMANDS,
  terminalOnlyText,
} from "./commands.js";
import { AGENT_ID_ENV, PROVIDER_ID } from "./ids.js";
import type { BridgeSignal } from "./interceptor.js";
import { agentLaunch, DEFAULT_COMMAND, type GrokCli, grokCli, grokStatus } from "./launch.js";
import { enrichCatalog, type ModelState } from "./models.js";
import { type GrokStream, spawnGrokStream } from "./stream.js";

export { AGENT_ID_ENV, PROVIDER_ID };

export const PROVIDER_LABEL = "Grok Terminal";

/** Delay before a terminal turn's end is reported, so Paseo applies its last streamed
 * updates first: Paseo's ACP client dispatches session updates asynchronously. */
const TURN_END_DELAY_MS = 50;

export interface GrokProviderOptions {
  /** Grok terminal commands the bridge rejects instead of sending them to the model. */
  terminalCommands?: ReadonlySet<string>;
  /** The Grok CLI, for bridge commands that Grok offers only as subcommands. */
  cli?: GrokCli;
  /** Grok renamed the session of a Paseo agent. */
  onTitle?(agentId: string, title: string): void;
  warn?(message: string): void;
}

type Listener = (event: ProviderEvent) => void;
type PromptInput = Extract<ProviderInput, { type: "session.prompt" }>;

/** Terminal-only command names: the built-in list plus those in Grok's installed reference. */
export function terminalCommandSet(grokHome?: string): Set<string> {
  const bridge = new Set(BRIDGE_COMMANDS.flatMap((entry) => [entry.name, ...entry.aliases]));
  return new Set(
    [...TERMINAL_COMMANDS, ...readDocumentedCommands(grokHome)].filter((name) => !bridge.has(name)),
  );
}

/** The typed text of a prompt, when it is text only. */
function promptText(input: PromptInput): string | null {
  const prompt = input.prompt.input;
  if (prompt.type === "command")
    return `/${prompt.name}${prompt.arguments ? ` ${prompt.arguments}` : ""}`;
  if (!prompt.content.every((part) => part.type === "text")) return null;
  return prompt.content.map((part) => (part as { text: string }).text).join("\n");
}

function withText(input: PromptInput, text: string): PromptInput {
  return {
    ...input,
    prompt: { ...input.prompt, input: { type: "message", content: [{ type: "text", text }] } },
  };
}

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
  const activeTurn = new Map<string, string>();
  const commandsSeen = new Set<string>();
  const terminalCommands = options.terminalCommands ?? new Set(TERMINAL_COMMANDS);
  let closed = false;
  const emit = (event: ProviderEvent) => {
    if (closed) return;
    if (event.type === "session.turn") {
      if (event.state === "started") activeTurn.set(event.sessionId, event.turnId);
      else if (activeTurn.get(event.sessionId) === event.turnId) activeTurn.delete(event.sessionId);
    }
    for (const listener of listeners) listener(event);
  };
  const streamFor = (sessionId: string): GrokStream | undefined => {
    for (const [native, boundary] of boundaryByNative)
      if (boundary === sessionId)
        for (const stream of streams)
          if (stream.interceptor.nativeSessionId === native) return stream;
    return undefined;
  };
  /** Paseo lists Grok's commands plus the bridge's, unless Grok offers a command itself. */
  const withBridgeCommands = (
    commands: readonly { name: string; description: string; argumentHint?: string }[],
  ) => {
    const native = new Set(commands.map((command) => command.name.toLowerCase()));
    return [
      ...commands,
      ...BRIDGE_COMMANDS.filter((command) => !native.has(command.name)).map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
      })),
    ];
  };
  /**
   * Run a slash command the bridge handles itself, and report whether it did. A command
   * typed while a turn runs is answered beside that turn when it leaves the conversation
   * alone (Paseo's steer delivery); otherwise Paseo replaces the turn as usual.
   */
  const handlePrompt = async (input: PromptInput): Promise<boolean> => {
    const text = promptText(input);
    const command = text === null ? null : parseSlashCommand(text);
    const stream = command ? streamFor(input.sessionId) : undefined;
    if (!command || !stream) return false;
    const route = routeCommand(command, stream.interceptor.advertisedCommands, terminalCommands);
    const steer = input.prompt.delivery === "steer";
    const aside = route.kind === "terminal" || (route.kind === "bridge" && route.command.aside);
    if (route.kind === "message" || (route.kind === "grok" && !route.text)) return false;
    if (route.kind === "grok") {
      if (steer) return false;
      await inner.send(withText(input, route.text));
      return true;
    }
    const { sessionId } = input;
    const clientMessageId = input.prompt.clientMessageId;
    const running = activeTurn.get(sessionId);
    if (steer && (!aside || !running)) {
      emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId,
        result: {
          type: "failed",
          error: { message: `/${command.name} cannot run beside the current turn` },
        },
      });
      return true;
    }
    const runner = new CommandRunner(stream, terminalCommands, options.cli);
    // `/plan <task>` switches the mode, then runs the task as the prompt itself.
    if (
      route.kind === "bridge" &&
      route.command.name === "plan" &&
      route.args &&
      !isPlanOff(route.args) &&
      !steer
    ) {
      const outcome = await runner.run(route.command, route.args);
      if (outcome.type === "prompt") {
        emit({
          type: "session.notice",
          sessionId,
          notice: {
            id: `grok-command-notice:${clientMessageId}`,
            severity: "info",
            title: outcome.notice,
          },
        });
        await inner.send(withText(input, outcome.text));
        return true;
      }
      emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId,
        result: { type: "failed", error: { message: outcome.text } },
      });
      return true;
    }
    emit({
      type: "timeline.item",
      sessionId,
      item: { type: "user_message", id: clientMessageId, text: text ?? "", clientMessageId },
    });
    const turnId = steer && running ? running : `grok-command:${clientMessageId}`;
    emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: steer ? "steer" : "turn", turnId },
    });
    const reply = (message: string) =>
      emit({
        type: "timeline.item",
        sessionId,
        item: {
          type: "assistant_message",
          id: `grok-command-reply:${clientMessageId}`,
          text: message,
        },
      });
    if (route.kind === "terminal") {
      if (!steer) emit({ type: "session.turn", sessionId, turnId, state: "started" });
      reply(terminalOnlyText(route.name));
      if (!steer) emit({ type: "session.turn", sessionId, turnId, state: "completed" });
      return true;
    }
    if (!steer) emit({ type: "session.turn", sessionId, turnId, state: "started" });
    void runner.run(route.command, route.args).then((outcome) => {
      reply(outcome.type === "reply" ? outcome.text : outcome.notice);
      if (!steer) emit({ type: "session.turn", sessionId, turnId, state: "completed" });
    });
    return true;
  };
  const startTurn = (
    sessionId: string,
    turnId: string,
    userMessage?: { id: string; text: string },
  ) => {
    const previous = turnByBoundary.get(sessionId);
    if (previous === turnId) return;
    // Grok runs one turn at a time, so a new turn means the previous one has ended,
    // even when its delayed end has not been reported yet.
    if (previous) emit({ type: "session.turn", sessionId, turnId: previous, state: "completed" });
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
    if (signal.type === "notice") {
      emit({
        type: "session.notice",
        sessionId,
        notice: { id: signal.id, severity: "warning", title: signal.title },
      });
      return;
    }
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
    activeTurn.delete(sessionId);
    commandsSeen.delete(sessionId);
    turnByBoundary.delete(sessionId);
    agentByBoundary.delete(sessionId);
    for (const [native, boundary] of boundaryByNative)
      if (boundary === sessionId) boundaryByNative.delete(native);
  };
  inner.onEvent((event) => {
    if (event.type === "session.opened") {
      const native = nativeSessionId(event.persistence);
      if (native) boundaryByNative.set(native, event.sessionId);
      if (!event.capabilities.includes("prompt.steer"))
        event = { ...event, capabilities: [...event.capabilities, "prompt.steer"] };
    }
    if (event.type === "session.commands") {
      commandsSeen.add(event.sessionId);
      event = { ...event, commands: withBridgeCommands(event.commands) };
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
      if (!commandsSeen.has(event.sessionId))
        emit({
          type: "session.commands",
          sessionId: event.sessionId,
          commands: withBridgeCommands([]),
        });
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
    capabilities: inner.capabilities.includes("prompt.steer")
      ? inner.capabilities
      : [...inner.capabilities, "prompt.steer"],
    async send(input) {
      if (input.type === "session.prompt" && (await handlePrompt(input))) return;
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
      const terminalCommands =
        options.terminalCommands ?? terminalCommandSet(launch.env["GROK_HOME"]);
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
      return wrapConnection(inner, streams, (listener) => subscribers.add(listener), {
        ...options,
        terminalCommands,
        cli: grokCli(launch),
      });
    },
  };
}

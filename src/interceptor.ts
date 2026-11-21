import { catalogConfigOptions, type ModelState, readModelState } from "./models.js";
import { grokSupport, grokVersionRequirement, warnTentativeGrok } from "./versions.js";

/** A JSON-RPC 2.0 message as it crosses the ACP stream. */
export type JsonRpcMessage = { jsonrpc: "2.0" } & Record<string, unknown>;

export type TurnEndState = "completed" | "canceled" | "failed";

/** What the stream reveals beyond ACP about the shared session. */
export type BridgeSignal =
  | {
      type: "turn.started";
      nativeSessionId: string;
      turnId: string;
      userMessage?: { id: string; text: string };
    }
  | {
      type: "turn.ended";
      nativeSessionId: string;
      turnId: string;
      state: TurnEndState;
      error?: string;
    }
  | { type: "title"; nativeSessionId: string; title: string };

export interface InterceptorHooks {
  signal(signal: BridgeSignal): void;
  modelState?(state: ModelState): void;
  warn?(message: string): void;
}

/** Prefix of the session ID answered locally for Paseo's catalog requests. */
export const CATALOG_SESSION_PREFIX = "paseo-bridge-grok-catalog-";

const CHUNK_KINDS = new Set(["agent_message_chunk", "agent_thought_chunk", "user_message_chunk"]);

type Id = string | number;

interface Pending {
  method: string;
  params: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isId(value: unknown): value is Id {
  return typeof value === "string" || typeof value === "number";
}

function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (record(block)["type"] === "text" ? (text(record(block)["text"]) ?? "") : ""))
    .join("\n");
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function turnEndState(stopReason: unknown): { state: TurnEndState; error?: string } {
  if (stopReason === "cancelled" || stopReason === "canceled") return { state: "canceled" };
  if (stopReason === "refusal") return { state: "failed", error: "Grok Build refused the request" };
  return { state: "completed" };
}

/**
 * Rewrites one ACP stream between Paseo's generic ACP client and `grok agent --leader stdio`
 * so that a session shared with a terminal behaves like a Paseo session:
 *
 * - Catalog requests (`session/new` without Paseo's metadata) are answered from the models
 *   Grok reports in `initialize`, instead of creating a throwaway Grok session.
 * - `session/close` is answered locally. Grok's leader closes a session for every attached
 *   client, so forwarding it would detach the terminal. Ending the process detaches only Paseo.
 * - `session/load` attaches without Paseo's MCP servers, so the terminal's tool set is kept.
 * - Streamed chunks get message IDs from Grok's prompt IDs, so replies of separate turns do
 *   not merge into one timeline item.
 * - Turns started by another client (the terminal) are reported as signals with the prompt
 *   text, from Grok's queue notifications; ACP itself only reports a client's own turns.
 */
export class GrokStreamInterceptor {
  private readonly pending = new Map<Id, Pending>();
  private readonly catalogSessions = new Map<string, Record<string, unknown>[]>();
  private readonly ownPrompts = new Map<Id, { text: string; claimed: boolean }>();
  private readonly claimedPromptIds = new Set<string>();
  private modelState: ModelState | null = null;
  private native: string | null = null;
  private loading = false;
  private foreign: { promptId: string; turnId: string } | null = null;
  private segment = 0;
  private lastChunk: { kind: string; key: string } | null = null;
  private catalogCounter = 0;

  constructor(private readonly hooks: InterceptorHooks) {}

  get nativeSessionId(): string | null {
    return this.native;
  }

  /** The turn another client is running in this session, if any. */
  get foreignTurn(): { promptId: string; turnId: string } | null {
    return this.foreign;
  }

  /** Client to agent. `forward` goes to Grok; `replies` go straight back to the client. */
  outbound(message: JsonRpcMessage): { forward: JsonRpcMessage | null; replies: JsonRpcMessage[] } {
    const method = text(message["method"]);
    const id = message["id"];
    if (!method) return { forward: message, replies: [] };
    const params = record(message["params"]);
    const reply = (result: unknown): { forward: null; replies: JsonRpcMessage[] } => ({
      forward: null,
      replies: isId(id) ? [{ jsonrpc: "2.0", id, result }] : [],
    });
    if (method === "session/close") return reply({});
    const sessionId = text(params["sessionId"]);
    if (sessionId && this.catalogSessions.has(sessionId)) {
      if (method === "session/set_config_option") {
        const options = this.catalogSessions.get(sessionId) ?? [];
        for (const option of options)
          if (option["id"] === params["configId"]) option["currentValue"] = params["value"];
        return reply({ configOptions: options });
      }
      if (method === "session/cancel") return { forward: null, replies: [] };
      return {
        forward: null,
        replies: isId(id)
          ? [
              {
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `${method} is not available for catalog requests` },
              },
            ]
          : [],
      };
    }
    if (method === "session/new" && !("_paseo" in record(params["_meta"])) && this.modelState) {
      const catalogId = `${CATALOG_SESSION_PREFIX}${++this.catalogCounter}`;
      const configOptions = catalogConfigOptions(this.modelState);
      this.catalogSessions.set(catalogId, configOptions);
      return reply({ sessionId: catalogId, configOptions });
    }
    let forward = message;
    if (method === "session/load") {
      this.attach(text(params["sessionId"]) ?? null);
      this.loading = true;
      forward = { ...message, params: { ...params, mcpServers: [] } };
    }
    if (method === "session/prompt" && isId(id))
      this.ownPrompts.set(id, { text: normalize(promptText(params["prompt"])), claimed: false });
    if (isId(id)) this.pending.set(id, { method, params });
    return { forward, replies: [] };
  }

  /** Agent to client. Returns the messages to deliver, possibly rewritten. */
  inbound(message: JsonRpcMessage): JsonRpcMessage[] {
    const method = text(message["method"]);
    if (!method) return [this.response(message)];
    if ("id" in message) return [message];
    const params = record(message["params"]);
    // Grok's session index carries no top-level session ID; it names sessions per entry.
    if (method === "_x.ai/sessions/changed") {
      if (!this.loading) this.vendor(method, params);
      return [message];
    }
    if (text(params["sessionId"]) !== this.native || !this.native) return [message];
    const replay = this.loading || record(params["_meta"])["isReplay"] === true;
    if (method === "session/update") return [this.sessionUpdate(message, params, replay)];
    if (!replay) this.vendor(method, params);
    return [message];
  }

  private attach(sessionId: string | null): void {
    this.native = sessionId;
    this.foreign = null;
    this.segment = 0;
    this.lastChunk = null;
    this.claimedPromptIds.clear();
  }

  private response(message: JsonRpcMessage): JsonRpcMessage {
    const id = message["id"];
    if (!isId(id)) return message;
    const pending = this.pending.get(id);
    if (!pending) return message;
    this.pending.delete(id);
    const result = record(message["result"]);
    switch (pending.method) {
      case "initialize": {
        const meta = record(result["_meta"]);
        const version = text(meta["agentVersion"]);
        if (version && grokSupport(version) === "unsupported")
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32603, message: grokVersionRequirement(version) },
          };
        if (version) warnTentativeGrok(version, this.hooks.warn);
        const state = readModelState(meta["modelState"]);
        if (state) {
          this.modelState = state;
          this.hooks.modelState?.(state);
        }
        return message;
      }
      case "session/new": {
        const sessionId = text(result["sessionId"]);
        if (sessionId) this.attach(sessionId);
        return message;
      }
      case "session/load":
        this.loading = false;
        if (message["error"]) this.attach(null);
        return message;
      case "session/prompt":
        this.ownPrompts.delete(id);
        return message;
      default:
        return message;
    }
  }

  private sessionUpdate(
    message: JsonRpcMessage,
    params: Record<string, unknown>,
    replay: boolean,
  ): JsonRpcMessage {
    const update = record(params["update"]);
    const kind = text(update["sessionUpdate"]) ?? "";
    if (kind === "session_info_update" && typeof update["title"] === "string" && this.native) {
      const title = normalize(update["title"]);
      if (title) this.hooks.signal({ type: "title", nativeSessionId: this.native, title });
    }
    if (!CHUNK_KINDS.has(kind)) {
      this.lastChunk = null;
      return message;
    }
    if (update["messageId"]) return message;
    const updateMeta = record(update["_meta"]);
    const meta = record(params["_meta"]);
    let messageId: string | undefined;
    if (kind === "user_message_chunk") {
      const index = updateMeta["promptIndex"];
      if (replay && (typeof index === "number" || typeof index === "string"))
        messageId = `grok-user:${index}`;
      this.lastChunk = null;
    } else {
      const key = text(meta["promptId"]) ?? text(updateMeta["promptId"]);
      if (key) {
        if (!this.lastChunk || this.lastChunk.kind !== kind || this.lastChunk.key !== key)
          this.segment++;
        this.lastChunk = { kind, key };
        messageId = `grok:${key}:${this.segment}`;
      }
    }
    if (!messageId) return message;
    return { ...message, params: { ...params, update: { ...update, messageId } } };
  }

  private vendor(method: string, params: Record<string, unknown>): void {
    const native = this.native;
    if (!native) return;
    if (method === "_x.ai/queue/changed") {
      const running = text(params["runningPromptId"]);
      if (!running || running === this.foreign?.promptId || this.claimedPromptIds.has(running))
        return;
      const runningText = text(params["runningText"]);
      if (this.claimOwn(running, runningText)) return;
      this.endForeign("completed");
      const turnId = `grok-turn:${running}`;
      this.foreign = { promptId: running, turnId };
      const userText = runningText?.trim();
      this.hooks.signal({
        type: "turn.started",
        nativeSessionId: native,
        turnId,
        ...(userText && (params["runningKind"] ?? "prompt") === "prompt"
          ? { userMessage: { id: `grok-user-live:${running}`, text: userText } }
          : {}),
      });
      return;
    }
    if (method === "_x.ai/session/prompt_complete") {
      this.finish(text(params["promptId"]), params["stopReason"]);
      return;
    }
    if (method === "_x.ai/session_notification" || method === "_x.ai/session/update") {
      const update = record(params["update"]);
      if (update["sessionUpdate"] === "turn_completed")
        this.finish(text(update["prompt_id"]), update["stop_reason"]);
      return;
    }
    if (method === "_x.ai/sessions/changed" && this.foreign) {
      const upserted = Array.isArray(params["upserted"]) ? params["upserted"] : [];
      for (const entry of upserted.map(record))
        if (entry["sessionId"] === native && entry["activity"] === "idle")
          this.endForeign("completed");
    }
  }

  /** A running prompt whose text matches one this client sent is this client's own turn. */
  private claimOwn(promptId: string, runningText: string | undefined): boolean {
    const unclaimed = [...this.ownPrompts.values()].filter((prompt) => !prompt.claimed);
    if (!unclaimed.length) return false;
    const wanted = runningText === undefined ? undefined : normalize(runningText);
    const match =
      wanted === undefined ? unclaimed[0] : unclaimed.find((prompt) => prompt.text === wanted);
    if (!match) return false;
    match.claimed = true;
    this.claimedPromptIds.add(promptId);
    return true;
  }

  private finish(promptId: string | undefined, stopReason: unknown): void {
    if (!promptId) return;
    if (this.claimedPromptIds.delete(promptId)) return;
    if (this.foreign?.promptId !== promptId) return;
    const { state, error } = turnEndState(stopReason);
    this.endForeign(state, error);
  }

  private endForeign(state: TurnEndState, error?: string): void {
    const foreign = this.foreign;
    if (!foreign || !this.native) return;
    this.foreign = null;
    this.hooks.signal({
      type: "turn.ended",
      nativeSessionId: this.native,
      turnId: foreign.turnId,
      state,
      ...(error ? { error } : {}),
    });
  }
}

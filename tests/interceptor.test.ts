import { describe, expect, test } from "vitest";
import {
  type BridgeSignal,
  CATALOG_SESSION_PREFIX,
  GrokStreamInterceptor,
  type JsonRpcMessage,
  turnEndState,
} from "../src/interceptor.js";

const modelState = {
  currentModelId: "grok-a",
  availableModels: [
    {
      modelId: "grok-a",
      name: "Grok A",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEfforts: [{ value: "low" }, { value: "high", default: true }],
      },
    },
    { modelId: "grok-b", name: "Grok B" },
  ],
};

function rpc(fields: Record<string, unknown>): JsonRpcMessage {
  return { jsonrpc: "2.0", ...fields };
}

function setup(agentVersion = "1.0.92") {
  const signals: BridgeSignal[] = [];
  const warnings: string[] = [];
  const interceptor = new GrokStreamInterceptor({
    signal: (signal) => signals.push(signal),
    warn: (message) => warnings.push(message),
  });
  interceptor.outbound(rpc({ id: 0, method: "initialize", params: {} }));
  const initialized = interceptor.inbound(
    rpc({ id: 0, result: { _meta: { agentVersion, modelState } } }),
  );
  return { interceptor, signals, warnings, initialized };
}

function load(interceptor: GrokStreamInterceptor, sessionId = "native-1") {
  const sent = interceptor.outbound(
    rpc({ id: 1, method: "session/load", params: { sessionId, cwd: "/p", mcpServers: [{}] } }),
  );
  interceptor.inbound(rpc({ id: 1, result: {} }));
  return sent;
}

function vendor(method: string, params: Record<string, unknown>): JsonRpcMessage {
  return rpc({ method, params: { sessionId: "native-1", ...params } });
}

describe("GrokStreamInterceptor", () => {
  test("answers catalog requests locally from Grok's model state", () => {
    const { interceptor } = setup();
    const created = interceptor.outbound(
      rpc({ id: 2, method: "session/new", params: { cwd: "/p", mcpServers: [] } }),
    );
    expect(created.forward).toBeNull();
    const result = created.replies[0]?.["result"] as {
      sessionId: string;
      configOptions: { id: string; currentValue: string }[];
    };
    expect(result.sessionId.startsWith(CATALOG_SESSION_PREFIX)).toBe(true);
    expect(result.configOptions.map((option) => [option.id, option.currentValue])).toEqual([
      ["model", "grok-a"],
      ["reasoning_effort", "high"],
    ]);
    const changed = interceptor.outbound(
      rpc({
        id: 3,
        method: "session/set_config_option",
        params: { sessionId: result.sessionId, configId: "model", value: "grok-b" },
      }),
    );
    expect(changed.forward).toBeNull();
    expect(JSON.stringify(changed.replies)).toContain('"currentValue":"grok-b"');
    const prompted = interceptor.outbound(
      rpc({ id: 4, method: "session/prompt", params: { sessionId: result.sessionId, prompt: [] } }),
    );
    expect(prompted.replies[0]?.["error"]).toBeDefined();
  });

  test("forwards Paseo's own session/new and attaches to the created session", () => {
    const { interceptor } = setup();
    const sent = interceptor.outbound(
      rpc({ id: 2, method: "session/new", params: { cwd: "/p", _meta: { _paseo: {} } } }),
    );
    expect(sent.forward).not.toBeNull();
    interceptor.inbound(rpc({ id: 2, result: { sessionId: "native-9" } }));
    expect(interceptor.nativeSessionId).toBe("native-9");
  });

  test("never forwards session/close, which would detach every leader client", () => {
    const { interceptor } = setup();
    const closed = interceptor.outbound(
      rpc({ id: 5, method: "session/close", params: { sessionId: "native-1" } }),
    );
    expect(closed).toEqual({ forward: null, replies: [{ jsonrpc: "2.0", id: 5, result: {} }] });
  });

  test("loads without Paseo's MCP servers", () => {
    const { interceptor } = setup();
    const sent = load(interceptor);
    expect(sent.forward?.["params"]).toMatchObject({ mcpServers: [] });
    expect(interceptor.nativeSessionId).toBe("native-1");
  });

  test("rejects an unsupported Grok release and warns once for a newer one", () => {
    const old = setup("1.0.1");
    expect(old.initialized[0]?.["error"]).toMatchObject({
      message: expect.stringContaining("or newer is required"),
    });
    const newer = setup("9.0.0");
    expect(newer.initialized[0]?.["error"]).toBeUndefined();
    expect(newer.warnings).toHaveLength(1);
    expect(setup("9.0.0").warnings).toHaveLength(0);
  });

  test("gives streamed chunks message IDs per prompt and segment", () => {
    const { interceptor } = setup();
    load(interceptor);
    const chunk = (kind: string, promptId: string) =>
      interceptor.inbound(
        rpc({
          method: "session/update",
          params: {
            sessionId: "native-1",
            _meta: { promptId },
            update: { sessionUpdate: kind, content: { type: "text", text: "x" } },
          },
        }),
      )[0] as unknown as { params: { update: { messageId?: string } } };
    const first = chunk("agent_message_chunk", "p1").params.update.messageId;
    expect(chunk("agent_message_chunk", "p1").params.update.messageId).toBe(first);
    const thought = chunk("agent_thought_chunk", "p1").params.update.messageId;
    expect(thought).not.toBe(first);
    expect(chunk("agent_message_chunk", "p2").params.update.messageId).toMatch(/^grok:p2:/);
  });

  test("names replayed user messages by their prompt index", () => {
    const { interceptor } = setup();
    interceptor.outbound(
      rpc({ id: 1, method: "session/load", params: { sessionId: "native-1", cwd: "/p" } }),
    );
    const [replayed] = interceptor.inbound(
      rpc({
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: { sessionUpdate: "user_message_chunk", _meta: { promptIndex: 3 }, content: {} },
        },
      }),
    );
    expect(JSON.stringify(replayed)).toContain('"messageId":"grok-user:3"');
  });

  test("reports a turn another client runs, with its prompt, until it completes", () => {
    const { interceptor, signals } = setup();
    load(interceptor);
    interceptor.inbound(
      vendor("_x.ai/queue/changed", { runningPromptId: "t1", runningText: "from terminal" }),
    );
    expect(signals).toEqual([
      {
        type: "turn.started",
        nativeSessionId: "native-1",
        turnId: "grok-turn:t1",
        userMessage: { id: "grok-user-live:t1", text: "from terminal" },
      },
    ]);
    expect(interceptor.foreignTurn?.promptId).toBe("t1");
    interceptor.inbound(
      vendor("_x.ai/session/prompt_complete", { promptId: "t1", stopReason: "cancelled" }),
    );
    expect(signals[1]).toEqual({
      type: "turn.ended",
      nativeSessionId: "native-1",
      turnId: "grok-turn:t1",
      state: "canceled",
    });
    expect(interceptor.foreignTurn).toBeNull();
  });

  test("ends a foreign turn when Grok's session index reports the session idle", () => {
    const { interceptor, signals } = setup();
    load(interceptor);
    interceptor.inbound(vendor("_x.ai/queue/changed", { runningPromptId: "t2", runningText: "x" }));
    interceptor.inbound(
      rpc({
        method: "_x.ai/sessions/changed",
        params: { upserted: [{ sessionId: "native-1", activity: "idle" }] },
      }),
    );
    expect(signals.at(-1)).toMatchObject({ type: "turn.ended", state: "completed" });
  });

  test("does not report its own prompt as a foreign turn", () => {
    const { interceptor, signals } = setup();
    load(interceptor);
    interceptor.outbound(
      rpc({
        id: 7,
        method: "session/prompt",
        params: { sessionId: "native-1", prompt: [{ type: "text", text: "from  paseo" }] },
      }),
    );
    interceptor.inbound(
      vendor("_x.ai/queue/changed", { runningPromptId: "p7", runningText: "from paseo" }),
    );
    interceptor.inbound(
      vendor("_x.ai/session/prompt_complete", { promptId: "p7", stopReason: "end_turn" }),
    );
    expect(signals).toEqual([]);
  });

  test("ignores replayed vendor events and other sessions", () => {
    const { interceptor, signals } = setup();
    load(interceptor);
    interceptor.inbound(
      vendor("_x.ai/queue/changed", { runningPromptId: "r", _meta: { isReplay: true } }),
    );
    interceptor.inbound(
      rpc({ method: "_x.ai/queue/changed", params: { sessionId: "other", runningPromptId: "o" } }),
    );
    expect(signals).toEqual([]);
  });

  test("reports Grok's session title", () => {
    const { interceptor, signals } = setup();
    load(interceptor);
    interceptor.inbound(
      rpc({
        method: "session/update",
        params: {
          sessionId: "native-1",
          update: { sessionUpdate: "session_info_update", title: "  Fix   the build " },
        },
      }),
    );
    expect(signals).toEqual([
      { type: "title", nativeSessionId: "native-1", title: "Fix the build" },
    ]);
  });
});

test("turnEndState maps Grok stop reasons", () => {
  expect(turnEndState("end_turn")).toEqual({ state: "completed" });
  expect(turnEndState("cancelled")).toEqual({ state: "canceled" });
  expect(turnEndState("refusal").state).toBe("failed");
});

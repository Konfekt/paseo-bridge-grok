import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { expect, test, vi } from "vitest";
import { AGENT_ID_ENV } from "../src/ids.js";
import type { BridgeSignal } from "../src/interceptor.js";
import { wrapConnection } from "../src/provider.js";
import type { GrokStream } from "../src/stream.js";

function fakeInner() {
  let listener: ((event: ProviderEvent) => void) | undefined;
  const sent: ProviderInput[] = [];
  const inner = {
    version: 1,
    capabilities: {},
    send: async (input: ProviderInput) => {
      sent.push(input);
    },
    onEvent: (next: (event: ProviderEvent) => void) => {
      listener = next;
      return () => undefined;
    },
    close: async () => undefined,
  } as unknown as ProviderConnection;
  return { inner, sent, fire: (event: unknown) => listener?.(event as ProviderEvent) };
}

function setup(streams = new Set<GrokStream>()) {
  const fake = fakeInner();
  let signal: ((signal: BridgeSignal) => void) | undefined;
  const titles: [string, string][] = [];
  const connection = wrapConnection(
    fake.inner,
    streams,
    (listener) => {
      signal = listener;
    },
    { onTitle: (agentId, title) => titles.push([agentId, title]) },
  );
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  const open = async () => {
    await connection.send({
      type: "session.open",
      sessionId: "b1",
      persistence: { version: 1, data: { sessionId: "n1" } },
      config: { env: { [AGENT_ID_ENV]: "agent-1" }, model: "m", mode: "x", cwd: "/p" },
    } as unknown as ProviderInput);
    fake.fire({
      type: "session.opened",
      sessionId: "b1",
      persistence: { version: 1, data: { sessionId: "n1" } },
    });
    fake.fire({ type: "session.ready", sessionId: "b1" });
  };
  return { fake, connection, events, titles, open, signal: (s: BridgeSignal) => signal?.(s) };
}

test("attaching keeps the session's own model and mode", async () => {
  const { fake, open } = setup();
  await open();
  const config = (fake.sent[0] as unknown as { config: Record<string, unknown> }).config;
  expect(config["model"]).toBeUndefined();
  expect(config["mode"]).toBeUndefined();
  expect(config["cwd"]).toBe("/p");
});

test("a terminal turn becomes a Paseo turn with its user message", async () => {
  vi.useFakeTimers();
  try {
    const { events, open, signal } = setup();
    await open();
    signal({
      type: "turn.started",
      nativeSessionId: "n1",
      turnId: "t",
      userMessage: { id: "u", text: "hi" },
    });
    signal({ type: "turn.ended", nativeSessionId: "n1", turnId: "t", state: "completed" });
    expect(events.filter((event) => event.type === "session.turn")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    expect(events.slice(-3)).toEqual([
      {
        type: "timeline.item",
        sessionId: "b1",
        item: { type: "user_message", id: "u", text: "hi" },
      },
      { type: "session.turn", sessionId: "b1", turnId: "t", state: "started" },
      { type: "session.turn", sessionId: "b1", turnId: "t", state: "completed" },
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("a running terminal turn fails when Paseo detaches", async () => {
  const { events, fake, open, signal } = setup();
  await open();
  signal({ type: "turn.started", nativeSessionId: "n1", turnId: "t" });
  fake.fire({ type: "session.closed", sessionId: "b1" });
  expect(events.at(-2)).toMatchObject({ type: "session.turn", turnId: "t", state: "failed" });
});

test("a turn already running at attach is reported", async () => {
  const stream = {
    interceptor: { nativeSessionId: "n1", foreignTurn: { promptId: "p", turnId: "grok-turn:p" } },
  } as unknown as GrokStream;
  const { events, open } = setup(new Set([stream]));
  await open();
  expect(events.at(-1)).toEqual({
    type: "session.turn",
    sessionId: "b1",
    turnId: "grok-turn:p",
    state: "started",
  });
});

test("titles go to the agent that opened the session", async () => {
  const { titles, open, signal } = setup();
  await open();
  signal({ type: "title", nativeSessionId: "n1", title: "New" });
  signal({ type: "title", nativeSessionId: "unknown", title: "Other" });
  expect(titles).toEqual([["agent-1", "New"]]);
});

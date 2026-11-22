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
    capabilities: ["session.load"],
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
      capabilities: [],
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

function commandStream(advertised = [{ name: "session-info", description: "Show session" }]) {
  const requests: [string, unknown][] = [];
  const stream = {
    interceptor: {
      nativeSessionId: "n1",
      advertisedCommands: advertised,
      configOptions: [],
      cwd: "/p",
      title: "T",
    },
    async request(method: string, params: unknown) {
      requests.push([method, params]);
      return method === "_x.ai/btw" ? { result: { answer: "aside" } } : {};
    },
    onNotification: () => () => undefined,
    hideSession: () => undefined,
  } as unknown as GrokStream;
  return { stream, requests };
}

const prompt = (text: string, delivery: "auto" | "steer" = "auto", id = "c1") =>
  ({
    type: "session.prompt",
    sessionId: "b1",
    prompt: {
      clientMessageId: id,
      delivery,
      input: { type: "message", content: [{ type: "text", text }] },
    },
  }) as unknown as ProviderInput;
const sentText = (input: ProviderInput | undefined) =>
  (input as unknown as { prompt: { input: { content: { text: string }[] } } }).prompt.input
    .content[0]?.text;

test("Paseo is offered steering and the bridge's commands next to Grok's", async () => {
  const { connection, events, fake, open } = setup();
  expect(connection.capabilities).toEqual(["session.load", "prompt.steer"]);
  await open();
  expect(events[0]).toMatchObject({ type: "session.opened", capabilities: ["prompt.steer"] });
  const names = (event: ProviderEvent | undefined) =>
    (event as { commands: { name: string }[] }).commands.map((command) => command.name);
  // Grok sent no commands before the session was ready: the bridge's are listed meanwhile.
  expect(names(events.at(-1))).toContain("btw");
  fake.fire({
    type: "session.commands",
    sessionId: "b1",
    commands: [
      { name: "compact", description: "" },
      { name: "btw", description: "native" },
    ],
  });
  const listed = names(events.at(-1));
  expect(listed.filter((name) => name === "btw")).toHaveLength(1);
  expect(listed).toEqual(expect.arrayContaining(["compact", "model", "rename", "help"]));
});

test("a terminal-only command is answered in Paseo without reaching Grok", async () => {
  const { stream } = commandStream();
  const { connection, events, fake, open } = setup(new Set([stream]));
  await open();
  const before = events.length;
  await connection.send(prompt("/theme dark"));
  expect(fake.sent).toHaveLength(1);
  expect(events.slice(before)).toEqual([
    {
      type: "timeline.item",
      sessionId: "b1",
      item: { type: "user_message", id: "c1", text: "/theme dark", clientMessageId: "c1" },
    },
    {
      type: "session.prompt_result",
      sessionId: "b1",
      clientMessageId: "c1",
      result: { type: "turn", turnId: "grok-command:c1" },
    },
    { type: "session.turn", sessionId: "b1", turnId: "grok-command:c1", state: "started" },
    {
      type: "timeline.item",
      sessionId: "b1",
      item: {
        type: "assistant_message",
        id: "grok-command-reply:c1",
        text: expect.stringContaining("/theme only works in the Grok terminal"),
      },
    },
    { type: "session.turn", sessionId: "b1", turnId: "grok-command:c1", state: "completed" },
  ]);
});

test("messages and Grok's own commands pass through; aliases are rewritten", async () => {
  const { stream } = commandStream();
  const { connection, fake, open } = setup(new Set([stream]));
  await open();
  await connection.send(prompt("hello /there"));
  await connection.send(prompt("/session-info"));
  await connection.send(prompt("/status"));
  expect(fake.sent.slice(1).map(sentText)).toEqual([
    "hello /there",
    "/session-info",
    "/session-info",
  ]);
});

test("an aside command answers beside a running turn when Paseo steers", async () => {
  const { stream, requests } = commandStream();
  const { connection, events, fake, open, signal } = setup(new Set([stream]));
  await open();
  signal({ type: "turn.started", nativeSessionId: "n1", turnId: "t" });
  const before = events.length;
  await connection.send(prompt("/btw why?", "steer"));
  await expect
    .poll(() => events.slice(before).map((event) => event.type))
    .toEqual(["timeline.item", "session.prompt_result", "timeline.item"]);
  expect(events[before + 1]).toMatchObject({ result: { type: "steer", turnId: "t" } });
  expect(events.at(-1)).toMatchObject({ item: { text: expect.stringContaining("aside") } });
  expect(requests).toEqual([["_x.ai/btw", { sessionId: "n1", question: "why?" }]]);

  // A command that changes the session cannot run beside the turn; Paseo then replaces it.
  await connection.send(prompt("/model b", "steer", "c2"));
  expect(events.at(-1)).toMatchObject({ clientMessageId: "c2", result: { type: "failed" } });
  expect(fake.sent).toHaveLength(1);
});

test("/plan with a task enters plan mode and sends the task as the prompt", async () => {
  const { stream, requests } = commandStream();
  const { connection, events, fake, open } = setup(new Set([stream]));
  await open();
  await connection.send(prompt("/plan sketch it"));
  expect(requests).toEqual([["session/set_mode", { sessionId: "n1", modeId: "plan" }]]);
  expect(events.at(-1)).toMatchObject({
    type: "session.notice",
    notice: { title: "Plan mode is on" },
  });
  expect(sentText(fake.sent.at(-1))).toBe("sketch it");
});

test("a new terminal turn ends the previous one whose end is still pending", async () => {
  vi.useFakeTimers();
  try {
    const { events, open, signal } = setup();
    await open();
    signal({ type: "turn.started", nativeSessionId: "n1", turnId: "t1" });
    signal({ type: "turn.ended", nativeSessionId: "n1", turnId: "t1", state: "completed" });
    signal({ type: "turn.started", nativeSessionId: "n1", turnId: "t2" });
    await vi.advanceTimersByTimeAsync(60);
    expect(
      events
        .filter((event) => event.type === "session.turn")
        .map((event) => [event.turnId, event.state]),
    ).toEqual([
      ["t1", "started"],
      ["t1", "completed"],
      ["t2", "started"],
    ]);
  } finally {
    vi.useRealTimers();
  }
});

import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type BridgeSignal,
  GrokStreamInterceptor,
  type JsonRpcMessage,
  updateKey,
} from "../src/interceptor.js";
import { grokHome, SessionLogFollower, sessionLogPath } from "../src/session-log.js";

function rpc(fields: Record<string, unknown>): JsonRpcMessage {
  return { jsonrpc: "2.0", ...fields };
}

function setup() {
  const signals: BridgeSignal[] = [];
  const warnings: string[] = [];
  const interceptor = new GrokStreamInterceptor({
    signal: (signal) => signals.push(signal),
    warn: (message) => warnings.push(message),
  });
  interceptor.outbound(rpc({ id: 0, method: "initialize", params: {} }));
  interceptor.inbound(rpc({ id: 0, result: { _meta: { agentVersion: "1.0.92" } } }));
  interceptor.outbound(
    rpc({ id: 1, method: "session/load", params: { sessionId: "s1", cwd: "/p", mcpServers: [] } }),
  );
  interceptor.inbound(rpc({ id: 1, result: {} }));
  return { interceptor, signals, warnings };
}

/** A session update as Grok streams it and logs it. */
function update(n: number, sessionUpdate: string, text: string, promptId = "p1"): JsonRpcMessage {
  return rpc({
    method: "session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate, content: { type: "text", text } },
      _meta: { eventId: `s1-${n}`, agentTimestampMs: 1000 + n, promptId },
    },
  });
}

function turnCompleted(n: number, promptId = "p1"): JsonRpcMessage {
  return rpc({
    method: "_x.ai/session/update",
    params: {
      sessionId: "s1",
      update: { sessionUpdate: "turn_completed", prompt_id: promptId, stop_reason: "end_turn" },
      _meta: { eventId: `s1-${n}`, agentTimestampMs: 1000 + n },
    },
  });
}

describe("updateKey", () => {
  test("keys an update by event ID and agent timestamp", () => {
    expect(
      updateKey(update(3, "agent_message_chunk", "x")["params"] as Record<string, unknown>),
    ).toBe("s1-3@1003");
    expect(updateKey({ sessionId: "s1" })).toBeUndefined();
  });
});

describe("GrokStreamInterceptor.followed", () => {
  test("skips logged entries that arrived live", () => {
    const { interceptor, signals, warnings } = setup();
    interceptor.inbound(update(1, "agent_message_chunk", "live"));
    expect(interceptor.followed(update(0, "user_message_chunk", "hi"))).toEqual([]);
    expect(interceptor.followed(update(1, "agent_message_chunk", "live"))).toEqual([]);
    expect(interceptor.followed(turnCompleted(2))).toEqual([]);
    expect(signals).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("turns a missed turn into a Paseo turn with its prompt, once noticed", () => {
    const { interceptor, signals, warnings } = setup();
    expect(interceptor.startsLoggedTurn(update(1, "agent_thought_chunk", "t"))).toBe(true);
    expect(interceptor.followed(update(0, "user_message_chunk", "outside"))).toEqual([]);
    expect(interceptor.followed(update(1, "agent_thought_chunk", "think"))).toHaveLength(1);
    expect(interceptor.followed(update(2, "agent_message_chunk", "reply"))).toHaveLength(1);
    expect(interceptor.startsLoggedTurn(update(3, "agent_message_chunk", "more"))).toBe(false);
    interceptor.followed(turnCompleted(3));
    expect(signals.map((signal) => signal.type)).toEqual(["notice", "turn.started", "turn.ended"]);
    expect(signals[1]).toMatchObject({
      turnId: "grok-turn:p1",
      userMessage: { text: "outside" },
    });
    // A second missed turn starts again without another notice.
    interceptor.followed(update(4, "user_message_chunk", "again", "p2"));
    interceptor.followed(update(5, "agent_message_chunk", "reply", "p2"));
    expect(signals.map((signal) => signal.type)).toEqual([
      "notice",
      "turn.started",
      "turn.ended",
      "turn.started",
    ]);
    expect(warnings).toHaveLength(1);
  });

  test("ignores entries of other sessions", () => {
    const { interceptor } = setup();
    const other = update(1, "agent_message_chunk", "x");
    (other["params"] as Record<string, unknown>)["sessionId"] = "s2";
    expect(interceptor.followed(other)).toEqual([]);
  });
});

describe("SessionLogFollower", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("resolves Grok's home and session log path", () => {
    expect(grokHome({ GROK_HOME: "/g" })).toBe("/g");
    expect(grokHome({ HOME: "/h" })).toBe(join("/h", ".grok"));
    expect(sessionLogPath("/g", "/a b", "s1")).toBe(
      join("/g", "sessions", "%2Fa%20b", "s1", "updates.jsonl"),
    );
  });

  test("delivers only entries appended after attaching, after their grace, one turn per poll", async () => {
    const home = mkdtempSync(join(tmpdir(), "pbg-log-"));
    dirs.push(home);
    const path = sessionLogPath(home, "/p", "s1");
    mkdirSync(dirname(path), { recursive: true });
    const log = (message: JsonRpcMessage) =>
      appendFileSync(
        path,
        `${JSON.stringify({ timestamp: "t", ...message, jsonrpc: undefined })}\n`,
      );
    log(update(0, "agent_message_chunk", "before attaching"));

    const { interceptor, signals } = setup();
    const delivered: JsonRpcMessage[] = [];
    let now = 0;
    const follower = new SessionLogFollower(home, interceptor, (m) => delivered.push(m), {
      pollMs: 60_000,
      graceMs: 2_000,
      now: () => now,
    });
    try {
      follower.sync();
      await follower.poll();
      interceptor.inbound(update(1, "agent_message_chunk", "live"));
      log(update(1, "agent_message_chunk", "live"));
      log(update(2, "user_message_chunk", "first"));
      log(update(3, "agent_message_chunk", "missed one"));
      log(turnCompleted(4));
      log(update(5, "user_message_chunk", "second", "p2"));
      log(update(6, "agent_message_chunk", "missed two", "p2"));
      appendFileSync(path, "{torn");
      await follower.poll();
      expect(delivered).toEqual([]);
      now = 2_000;
      await follower.poll();
      expect(delivered).toHaveLength(1);
      expect(signals.filter((s) => s.type === "turn.started")).toHaveLength(1);
      await follower.poll();
      expect(delivered).toHaveLength(2);
      expect(signals.map((s) => s.type)).toEqual([
        "notice",
        "turn.started",
        "turn.ended",
        "turn.started",
      ]);
    } finally {
      follower.stop();
    }
  });
});

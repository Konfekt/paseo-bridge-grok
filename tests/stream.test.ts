import { expect, test } from "vitest";
import { spawnGrokStream } from "../src/stream.js";

/** A stand-in agent: echoes each request's method as its result, then fails on "die". */
const ECHO = `
const rl = require("node:readline").createInterface({ input: process.stdin });
process.stdout.write("not json\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "die") { process.stderr.write("boom"); process.exit(3); }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { method: message.method } }) + "\\n");
});`;

function launch() {
  return {
    command: process.execPath,
    args: ["-e", ECHO],
    env: { PATH: process.env["PATH"] ?? "" },
  };
}

test("passes ACP messages through and answers session/close locally", async () => {
  const warnings: string[] = [];
  let exited = false;
  const stream = await spawnGrokStream(
    launch(),
    { signal: () => undefined, warn: (message) => warnings.push(message) },
    () => {
      exited = true;
    },
  );
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  await writer.write({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} } as never);
  expect((await reader.read()).value).toEqual({
    jsonrpc: "2.0",
    id: 1,
    result: { method: "session/list" },
  });
  await writer.write({ jsonrpc: "2.0", id: 2, method: "session/close", params: {} } as never);
  expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  expect(warnings[0]).toContain("non-JSON");
  await reader.cancel();
  await expect.poll(() => exited).toBe(true);
});

test("an unexpected exit errors the stream with Grok's stderr", async () => {
  const stream = await spawnGrokStream(launch(), { signal: () => undefined });
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  await writer.write({ jsonrpc: "2.0", id: 1, method: "die" } as never);
  await expect(reader.read()).rejects.toThrow("Grok Build exited (3): boom");
});

test("a missing executable is named", async () => {
  await expect(
    spawnGrokStream(
      { command: "/nonexistent/grok", args: [], env: {} },
      { signal: () => undefined },
    ),
  ).rejects.toThrow("Grok Build executable not found: /nonexistent/grok");
});

/** A stand-in agent for bridge requests: notifies before answering, and fails on "fail". */
const NOTIFYING = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "fail") return send({ id: message.id, error: { code: -32601, message: "nope" } });
  send({ method: "session/update", params: { sessionId: message.params?.sessionId, update: {} } });
  send({ id: message.id, result: { method: message.method } });
});`;

test("bridge requests get their own answers, which never reach Paseo", async () => {
  const stream = await spawnGrokStream(
    {
      command: process.execPath,
      args: ["-e", NOTIFYING],
      env: { PATH: process.env["PATH"] ?? "" },
    },
    { signal: () => undefined },
  );
  const seen: unknown[] = [];
  const stop = stream.onNotification((message) => seen.push(message["params"]));
  const reader = stream.readable.getReader();
  const forwarded: unknown[] = [];
  void (async () => {
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (next.done) return;
      forwarded.push(next.value);
    }
  })();

  expect(await stream.request("_x.ai/btw", { sessionId: "s1" })).toEqual({ method: "_x.ai/btw" });
  await expect(stream.request("fail", {})).rejects.toThrow("nope");
  stream.hideSession("hidden");
  await stream.request("ping", { sessionId: "hidden" });
  stop();
  await stream.request("ping", { sessionId: "s2" });

  await expect.poll(() => forwarded.length).toBe(2);
  // Paseo sees the notifications of visible sessions only, and none of the answers.
  expect(forwarded).toEqual([
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: {} } },
    { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s2", update: {} } },
  ]);
  // Listeners see every notification until they stop listening.
  expect(seen).toEqual([
    { sessionId: "s1", update: {} },
    { sessionId: "hidden", update: {} },
  ]);
  await reader.cancel();
});

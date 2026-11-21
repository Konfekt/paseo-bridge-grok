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

import { expect, test } from "vitest";
import { CommandRunner, isPlanOff } from "../src/command-runner.js";
import { BRIDGE_COMMANDS } from "../src/commands.js";
import type { GrokCommand } from "../src/interceptor.js";
import type { GrokStream } from "../src/stream.js";

type Notification = Record<string, unknown>;

function fakeStream(answers: Record<string, unknown> = {}) {
  const requests: [string, Record<string, unknown>][] = [];
  const listeners = new Set<(message: Notification) => void>();
  const hidden: string[] = [];
  const interceptor = {
    nativeSessionId: "s1",
    cwd: "/project",
    title: "Work",
    advertisedCommands: [{ name: "compact", description: "Compress" }] as GrokCommand[],
    configOptions: [
      {
        id: "model",
        currentValue: "a",
        options: [
          { value: "a", name: "A" },
          { value: "b", name: "B" },
        ],
      },
      {
        id: "reasoning_effort",
        currentValue: "high",
        options: [{ value: "low" }, { value: "high" }],
      },
    ] as Record<string, unknown>[],
  };
  const stream = {
    interceptor,
    async request(method: string, params: Record<string, unknown>) {
      requests.push([method, params]);
      const answer = answers[method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return (answer as (p: unknown) => unknown)(params);
      return answer ?? {};
    },
    onNotification(listener: (message: Notification) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hideSession(sessionId: string) {
      hidden.push(sessionId);
    },
  };
  const notify = (message: Notification) => {
    for (const listener of [...listeners]) listener(message);
  };
  return { stream: stream as unknown as GrokStream, requests, notify, hidden, interceptor };
}

const command = (name: string) => {
  const found = BRIDGE_COMMANDS.find((entry) => entry.name === name);
  if (!found) throw new Error(name);
  return found;
};
const run = (stream: GrokStream, name: string, args = "") =>
  new CommandRunner(stream, new Set(["theme"])).run(command(name), args);

test("/model lists the models, and switches model and effort", async () => {
  const fake = fakeStream({
    "session/set_config_option": (params: { configId: string }) => ({
      configOptions: params.configId === "model" ? fake.interceptor.configOptions : [],
    }),
  });
  expect((await run(fake.stream, "model")).text).toContain("`a` (A) — current");
  const outcome = await run(fake.stream, "model", "B low");
  expect(outcome.text).toBe("Model set to `b` for this session. Reasoning effort set to low.");
  expect(fake.requests).toEqual([
    ["session/set_config_option", { sessionId: "s1", configId: "model", value: "b" }],
    ["session/set_config_option", { sessionId: "s1", configId: "reasoning_effort", value: "low" }],
  ]);
  expect((await run(fake.stream, "model", "c")).text).toContain('Unknown model "c"');
});

test("/effort shows and validates the level", async () => {
  const fake = fakeStream();
  expect((await run(fake.stream, "effort")).text).toContain("Reasoning effort: high");
  expect((await run(fake.stream, "effort", "max")).text).toContain(
    'Unknown reasoning effort "max"',
  );
  expect(fake.requests).toEqual([]);
});

test("/rename renames the Grok session, but not to Grok's automatic titles", async () => {
  const fake = fakeStream();
  expect(await run(fake.stream, "rename", "  New   name ")).toEqual({
    type: "reply",
    text: 'Renamed the session to "New name".',
  });
  expect(fake.requests).toEqual([["_x.ai/session/rename", { sessionId: "s1", title: "New name" }]]);
  expect(await run(fake.stream, "rename", "--auto")).toMatchObject({ error: true });
  expect(await run(fake.stream, "rename")).toMatchObject({ error: true });
});

test("/btw quotes the question and marks the answer as a side answer", async () => {
  const fake = fakeStream({ "_x.ai/btw": { result: { answer: " Teal. " } } });
  const outcome = await run(fake.stream, "btw", "which colour?");
  expect(outcome.text).toBe(
    "> btw: which colour?\n\nTeal.\n\n_Side answer: not added to the conversation._",
  );
  expect(fake.requests).toEqual([["_x.ai/btw", { sessionId: "s1", question: "which colour?" }]]);
});

test("/recap waits for Grok's recap of this session", async () => {
  const fake = fakeStream({
    "_x.ai/recap": () => {
      queueMicrotask(() => {
        const update = (sessionId: string, summary: string, auto = false) =>
          fake.notify({
            method: "_x.ai/session_notification",
            params: { sessionId, update: { sessionUpdate: "session_recap", summary, auto } },
          });
        update("other", "not this one");
        update("s1", "automatic", true);
        update("s1", "Fixed the bug.");
      });
      return { result: { ok: true } };
    },
  });
  expect((await run(fake.stream, "recap")).text).toBe("**Recap:** Fixed the bug.");
});

test("/plan sets Grok's mode and hands a task on as the prompt", async () => {
  const fake = fakeStream();
  expect(await run(fake.stream, "plan", "sketch it")).toEqual({
    type: "prompt",
    text: "sketch it",
    notice: "Plan mode is on",
  });
  expect((await run(fake.stream, "plan")).text).toContain("Plan mode is on");
  expect((await run(fake.stream, "plan", "off")).text).toBe("Left plan mode.");
  expect(fake.requests.map(([, params]) => params["modeId"])).toEqual(["plan", "plan", "default"]);
  expect(isPlanOff(" EXIT ")).toBe(true);
  expect(isPlanOff("off the cuff")).toBe(false);
});

test("/fork copies the session and titles the copy", async () => {
  const fake = fakeStream({ "_x.ai/session/fork": { newSessionId: "s2" } });
  expect((await run(fake.stream, "fork")).text).toContain('Forked this session as "Work (fork)"');
  expect(fake.requests).toEqual([
    ["_x.ai/session/fork", { sourceSessionId: "s1", sourceCwd: "/project", newCwd: "/project" }],
    ["_x.ai/session/rename", { sessionId: "s2", title: "Work (fork)" }],
  ]);
});

test("/new starts a hidden session with the prompt, and needs a prompt", async () => {
  const fake = fakeStream({ "session/new": { sessionId: "s3" } });
  expect(await run(fake.stream, "new")).toMatchObject({ error: true });
  expect((await run(fake.stream, "new", "start over")).text).toContain(
    "Started a new Grok session",
  );
  expect(fake.hidden).toEqual(["s3"]);
  expect(fake.requests).toEqual([
    ["session/new", { cwd: "/project", mcpServers: [] }],
    ["session/prompt", { sessionId: "s3", prompt: [{ type: "text", text: "start over" }] }],
  ]);
});

test("failures become a reply instead of an exception", async () => {
  const fake = fakeStream({ "_x.ai/btw": new Error("Method not found") });
  expect(await run(fake.stream, "btw", "q")).toEqual({
    type: "reply",
    text: "/btw failed: Method not found",
    error: true,
  });
  expect((await run(fake.stream, "help")).text).toContain(
    "**Terminal only** (rejected here): /theme",
  );
});

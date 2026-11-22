import { expect, test } from "vitest";
import { findGrok, startLive } from "./fixtures/live.js";

const grok = findGrok();

test.skipIf(!grok)(
  "slash commands typed in Paseo run in the shared Grok session",
  { timeout: 300_000 },
  async () => {
    if (!grok) return;
    const live = await startLive(grok, "my favourite colour is teal");
    const { client, terminal, sessionId, model } = live;
    try {
      await expect.poll(async () => (await live.agents()).length, { timeout: 30_000 }).toBe(1);
      const agentId = (await live.agents())[0]?.id as string;
      const timeline = () => live.timeline(agentId);
      // Grok also writes background status lines with the model; count only conversation calls.
      const modelCalls = () =>
        model.requests.filter((request) => !JSON.stringify(request).includes("dashboard line"))
          .length;
      const send = async (text: string) => {
        await client.sendMessage(agentId, text);
        await expect.poll(() => live.activeTurn(agentId), { timeout: 60_000 }).toBeNull();
      };

      // Paseo lists Grok's own commands and the bridge's.
      await expect
        .poll(
          async () => (await client.listCommands(agentId)).commands.map((entry) => entry.name),
          {
            timeout: 15_000,
          },
        )
        .toEqual(
          expect.arrayContaining(["compact", "context", "btw", "model", "rename", "help", "plan"]),
        );

      // /help and terminal-only commands answer in Paseo without a model call.
      let calls = modelCalls();
      await send("/help");
      await expect.poll(timeline, { timeout: 15_000 }).toContain("Bridge commands");
      expect(await timeline()).toContain("/status runs /session-info");
      await send("/theme dark");
      await expect
        .poll(timeline, { timeout: 15_000 })
        .toContain("/theme only works in the Grok terminal");
      expect(modelCalls()).toBe(calls);

      // /model lists and switches the shared session's model.
      await send("/model");
      await expect.poll(timeline, { timeout: 15_000 }).toContain("Switch with");
      const beforeModel = terminal.notifications.length;
      await send("/model Local B");
      await expect
        .poll(() => terminal.streamed(beforeModel), { timeout: 15_000 })
        .toContain('"currentValue":"local-b"');
      await expect
        .poll(async () => (await live.agents())[0]?.runtimeInfo?.model, { timeout: 15_000 })
        .toBe("local-b");

      // /rename renames the Grok session; the title reaches the terminal and Paseo.
      const beforeRename = terminal.notifications.length;
      await send("/rename Teal talk");
      await expect
        .poll(() => terminal.streamed(beforeRename), { timeout: 15_000 })
        .toContain('"title":"Teal talk"');
      await expect
        .poll(async () => (await live.agents())[0]?.title, { timeout: 15_000 })
        .toBe("Teal talk");

      // /btw answers with the session's context but stays out of the conversation.
      calls = modelCalls();
      await send("/btw which colour did I name?");
      await expect.poll(timeline, { timeout: 60_000 }).toContain("Side answer");
      const btwRequest = JSON.stringify(model.requests.slice(calls));
      expect(btwRequest).toContain("which colour did I name?");
      expect(btwRequest).toContain("teal");
      await terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "next step" }],
      });
      const next = JSON.stringify(
        model.requests.filter((request) => JSON.stringify(request).includes("next step")),
      );
      expect(next).not.toContain("which colour did I name?");

      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toBeNull();

      // A side question while the terminal's turn runs leaves that turn running.
      const slow = terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "slow terminal work" }],
      });
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toMatch(/^grok-turn:/);
      await client.sendMessage(agentId, "/btw are you busy?", { activeTurnBehavior: "steer" });
      expect((await slow)["stopReason"]).toBe("end_turn");
      await expect.poll(timeline, { timeout: 60_000 }).toContain("are you busy?");
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toBeNull();

      // /recap shows Grok's one-line recap.
      await send("/recap");
      await expect.poll(timeline, { timeout: 60_000 }).toContain("**Recap:**");

      // /status runs Grok's /session-info, its advertised name.
      calls = modelCalls();
      await send("/status");
      await expect.poll(timeline, { timeout: 15_000 }).toContain("local-model-b");
      expect(modelCalls()).toBe(calls);

      // /plan switches Grok into plan mode and runs the task there; /plan off leaves it.
      const beforePlan = terminal.notifications.length;
      await send("/plan sketch the change");
      await expect
        .poll(() => terminal.streamed(beforePlan), { timeout: 15_000 })
        .toContain('"currentModeId":"plan"');
      await expect.poll(timeline, { timeout: 30_000 }).toContain("reply to: sketch the change");
      await send("/plan off");
      await expect
        .poll(() => terminal.streamed(beforePlan), { timeout: 15_000 })
        .toContain('"currentModeId":"default"');

      // /fork and /new create Grok sessions that Paseo imports as new agents.
      await send("/fork");
      await expect
        .poll(async () => (await live.agents()).map((agent) => agent.title), { timeout: 30_000 })
        .toContain("Teal talk (fork)");
      await send("/new start fresh");
      await expect.poll(async () => (await live.agents()).length, { timeout: 60_000 }).toBe(3);
      const fresh = (await live.agents()).find(
        (agent) => agent.id !== agentId && agent.title !== "Teal talk (fork)",
      );
      await expect
        .poll(() => live.timeline(fresh?.id as string), { timeout: 30_000 })
        .toContain("reply to: start fresh");
    } finally {
      await live.stop();
    }
  },
);

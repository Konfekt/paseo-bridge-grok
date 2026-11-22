import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { findGrok, startLive } from "./fixtures/live.js";

const grok = findGrok();

test.skipIf(!grok)(
  "real Grok Build and Paseo share a terminal session through Grok's leader",
  { timeout: 180_000 },
  async () => {
    if (!grok) return;
    const live = await startLive(grok, "hello from the terminal");
    const { client, daemon, terminal, sessionId, grokHome, project } = live;
    const connected = client;
    try {
      // Discovery imports the terminal session into its own workspace.
      await expect
        .poll(async () => (await connected.fetchAgents()).entries.length, { timeout: 30_000 })
        .toBe(1);
      const agent = (await client.fetchAgents()).entries[0]?.agent;
      if (!agent) throw new Error("Terminal session was not imported");
      const agentId = agent.id;
      expect(agent.provider).toBe("grok-terminal");
      expect(agent.workspaceId).toMatch(/^wks_/);
      expect(agent.labels["bridge.workspace"]).toBe(agent.workspaceId);
      expect(agent.persistence?.sessionId ?? "").toContain(sessionId);
      const workspace = await connected.findWorkspace(agent.workspaceId as string);
      expect(workspace?.title).toBe("hello from the terminal");
      expect(workspace?.workspaceDirectory).toBe(project);
      await expect
        .poll(
          async () =>
            (await connected.fetchAgents()).entries.find((entry) => entry.agent.id === agentId)
              ?.agent.title,
          { timeout: 15_000 },
        )
        .toBe("hello from the terminal");
      const timeline = async () => JSON.stringify(await connected.fetchAgentTimeline(agentId));
      await expect.poll(timeline, { timeout: 15_000 }).toContain("hello from the terminal");
      expect(await timeline()).toContain("reply to: hello from the terminal");

      // A turn the terminal runs appears live in Paseo, with its prompt and running state.
      const before = terminal.notifications.length;
      const slow = terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "slow terminal work" }],
      });
      await expect
        .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId, { timeout: 15_000 })
        .toMatch(/^grok-turn:/);
      await slow;
      await expect.poll(timeline, { timeout: 15_000 }).toContain("reply to: slow terminal work");
      expect(await timeline()).toContain('"slow terminal work"');
      await expect
        .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId ?? null, {
          timeout: 15_000,
        })
        .toBeNull();
      expect(terminal.streamed(before)).toContain("reply to: slow terminal work");

      // A message sent from Paseo runs in the same native session; the terminal sees it.
      const fromPaseo = terminal.notifications.length;
      await client.sendMessage(agentId, "hello from paseo");
      await expect
        .poll(() => terminal.streamed(fromPaseo), { timeout: 30_000 })
        .toContain("reply to: hello from paseo");
      await expect.poll(timeline, { timeout: 15_000 }).toContain("reply to: hello from paseo");

      // The model picker offers Grok's models, and a choice reaches the shared session.
      const listed = await client.listProviderModels("grok-terminal", { cwd: project });
      expect(listed.models?.map((entry) => entry.id)).toEqual(
        expect.arrayContaining(["local-a", "local-b"]),
      );
      const fromModel = terminal.notifications.length;
      await client.setAgentModel(agentId, "local-b");
      await expect
        .poll(() => terminal.streamed(fromModel), { timeout: 15_000 })
        .toContain('"currentValue":"local-b"');
      // A model the terminal picks shows up in Paseo.
      await terminal.call("session/set_config_option", {
        sessionId,
        configId: "model",
        value: "local-a",
      });
      await expect
        .poll(
          async () =>
            (await connected.fetchAgents()).entries.find((entry) => entry.agent.id === agentId)
              ?.agent.runtimeInfo?.model,
          { timeout: 15_000 },
        )
        .toBe("local-a");

      // Stopping in Paseo cancels a turn the terminal started.
      const stopped = terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "slow work to stop" }],
      });
      await expect
        .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId, { timeout: 15_000 })
        .toMatch(/^grok-turn:/);
      await client.cancelAgent(agentId);
      expect((await stopped)["stopReason"]).toBe("cancelled");
      await expect
        .poll(() => daemon.agentManager.getAgent(agentId)?.activeTurnId ?? null, {
          timeout: 15_000,
        })
        .toBeNull();

      // Catalog requests answer from Grok's model list; no extra Grok session was created.
      const stored = await readdir(join(grokHome, "sessions"), { recursive: true });
      expect(stored.filter((entry) => entry.endsWith("summary.json"))).toHaveLength(1);

      // Paseo detaching never closes the session for the terminal.
      await live.closeClient();
      await daemon.stop();
      const afterDetach = terminal.notifications.length;
      await terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "still attached" }],
      });
      expect(terminal.streamed(afterDetach)).toContain("reply to: still attached");
    } finally {
      await live.stop();
    }
  },
);

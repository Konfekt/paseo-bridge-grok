import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { findGrok, startLive } from "./fixtures/live.js";

const grok = findGrok();

test.skipIf(!grok)(
  "a session created in Paseo continues in a Grok terminal, and Paseo follows",
  { timeout: 180_000 },
  async () => {
    if (!grok) return;
    const live = await startLive(grok, "hello from the terminal");
    const { client, terminal, project, sessionId: terminalSession } = live;
    try {
      await expect.poll(async () => (await live.agents()).length, { timeout: 30_000 }).toBe(1);

      // New agent in Paseo, as the app's new-agent button does: a session on Grok's leader.
      const created = await client.createAgent({ provider: "grok-terminal", cwd: project });
      const agentId = created.id;
      await client.sendMessage(agentId, "hello from the paseo app");
      await expect
        .poll(() => live.timeline(agentId), { timeout: 30_000 })
        .toContain("reply to: hello from the paseo app");
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toBeNull();

      // Grok lists the session once it has a message, so a terminal can find and resume it.
      const listed = await terminal.call("session/list", { cwd: project });
      const sessions = (listed["sessions"] as { sessionId: string }[]).map(
        (entry) => entry.sessionId,
      );
      const paseoSession = sessions.find((id) => id !== terminalSession);
      if (!paseoSession) throw new Error(`Paseo's session is not listed: ${sessions.join(", ")}`);
      const agent = (await live.agents()).find((entry) => entry.id === agentId);
      expect(agent?.persistence?.sessionId ?? "").toContain(paseoSession);

      // Commands a phone user needs: the ID for the terminal, usage, and a transcript file.
      await client.sendMessage(agentId, "/status");
      await client.sendMessage(agentId, "/usage");
      await client.sendMessage(agentId, "/export");
      const exported = join(project, `grok-session-${paseoSession}.md`);
      await expect
        .poll(() => readFile(exported, "utf8").catch(() => ""), { timeout: 30_000 })
        .toContain("hello from the paseo app");
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toBeNull();
      const answers = await live.timeline(agentId);
      expect(answers).toContain(`**Session ID:** ${paseoSession}`);
      expect(answers).toMatch(/\*\*Session:\*\* \d[\d,]* tokens \(/);
      expect(answers).toContain("Exported the transcript to");

      // `grok --leader -r <session>`: the terminal joins the live session with its history.
      const beforeLoad = terminal.notifications.length;
      await terminal.call("session/load", {
        sessionId: paseoSession,
        cwd: project,
        mcpServers: [],
      });
      expect(JSON.stringify(terminal.notifications.slice(beforeLoad))).toContain(
        "hello from the paseo app",
      );

      // A terminal turn on the Paseo-created session shows in Paseo as a running turn.
      const slow = terminal.call("session/prompt", {
        sessionId: paseoSession,
        prompt: [{ type: "text", text: "slow work from the terminal" }],
      });
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toMatch(/^grok-turn:/);
      await slow;
      await expect
        .poll(() => live.timeline(agentId), { timeout: 15_000 })
        .toContain("reply to: slow work from the terminal");
      await expect.poll(() => live.activeTurn(agentId), { timeout: 15_000 }).toBeNull();

      // Paseo keeps driving the session the terminal now also shows, without closing either.
      const fromPaseo = terminal.notifications.length;
      await client.sendMessage(agentId, "back on the phone");
      await expect
        .poll(() => terminal.streamed(fromPaseo), { timeout: 30_000 })
        .toContain("reply to: back on the phone");

      // Discovery recognises the Paseo-created session and does not import it a second time.
      await delay(8_000);
      expect(
        (await live.agents()).filter((entry) => entry.provider === "grok-terminal"),
      ).toHaveLength(2);
    } finally {
      await live.stop();
    }
  },
);

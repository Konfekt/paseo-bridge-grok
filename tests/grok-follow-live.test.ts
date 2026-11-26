import { expect, test } from "vitest";
import { AcpClient } from "./fixtures/acp-client.js";
import { findGrok, startLive } from "./fixtures/live.js";

const grok = findGrok();

// `[features] shared_daemon = true` lets terminals share the leader without `--leader`, but a
// window whose model turns don't go to Grok's hosted backend (as with these local models), or
// whose environment differs from the leader's, still runs on its own: Paseo must follow it.
test.skipIf(!grok).each([
  { setup: "default config", sharedDaemon: false },
  { setup: "features.shared_daemon", sharedDaemon: true },
])(
  "every turn reaches Paseo, also from a terminal that is not on Grok's leader ($setup)",
  { timeout: 240_000 },
  async ({ sharedDaemon }) => {
    if (!grok) return;
    const live = await startLive(grok, "first terminal prompt", { reasoning: true, sharedDaemon });
    const { client, terminal, sessionId, grokEnv, project } = live;
    let outsider: AcpClient | undefined;
    try {
      await expect.poll(async () => (await live.agents()).length, { timeout: 30_000 }).toBe(1);
      const agentId = (await live.agents())[0]?.id as string;
      const items = async () =>
        (
          JSON.parse(await live.timeline(agentId)) as {
            entries: { item: { type: string; text?: string } }[];
          }
        ).entries.map((entry) => `${entry.item.type}: ${entry.item.text ?? ""}`);
      const turn = (prompt: string) => [
        `user_message: ${prompt}`,
        `reasoning: thinking about ${prompt}`,
        `assistant_message: reply to: ${prompt}`,
      ];
      const idle = () =>
        expect.poll(() => live.activeTurn(agentId), { timeout: 30_000 }).toBeNull();

      // Through the leader: every later turn's reasoning and reply, from Paseo and the terminal.
      await client.sendMessage(agentId, "second from paseo");
      await idle();
      await terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "third from the terminal" }],
      });
      await expect
        .poll(items, { timeout: 30_000 })
        .toEqual([
          ...turn("first terminal prompt"),
          ...turn("second from paseo"),
          ...turn("third from the terminal"),
        ]);
      await idle();

      // A terminal started without `--leader` writes the session from its own process; the
      // leader never streams its turns, so Paseo follows them from the session log.
      // With shared_daemon, the window asks to share but runs in an environment of its own.
      const outsiderEnv = sharedDaemon
        ? { ...grokEnv, GROK_SHARED_DAEMON: "1", SHELL_ONLY_SETTING: "1" }
        : grokEnv;
      outsider = new AcpClient(grok, ["agent", "stdio"], outsiderEnv, project);
      await outsider.initialize();
      await outsider.call("session/load", { sessionId, cwd: project, mcpServers: [] });
      for (const prompt of ["fourth outside the leader", "fifth outside the leader"])
        await outsider.call("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
      const turns = async () => (await items()).filter((item) => item !== "notification: ");
      await expect
        .poll(turns, { timeout: 30_000 })
        .toEqual([
          ...turn("first terminal prompt"),
          ...turn("second from paseo"),
          ...turn("third from the terminal"),
          ...turn("fourth outside the leader"),
          ...turn("fifth outside the leader"),
        ]);
      // At most once, telling the user to share the session through `grok --leader`.
      expect((await items()).filter((item) => item === "notification: ").length).toBeLessThan(2);
      await idle();

      // `/bridge` shows what to compare with the terminal's setup.
      await client.sendMessage(agentId, "/bridge");
      await expect
        .poll(() => live.timeline(agentId), { timeout: 30_000 })
        .toContain("Session log:");
      const report = await live.timeline(agentId);
      expect(report).toContain(`features.shared_daemon = ${sharedDaemon ? "true" : "unset"}`);
      expect(report).toContain("Leader socket:");
      expect(report).toMatch(/[1-9]\d* entries followed from it/);
    } finally {
      outsider?.close();
      await live.stop();
    }
  },
);

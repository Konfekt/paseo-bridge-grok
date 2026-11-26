import { expect, test } from "vitest";
import { AcpClient } from "./fixtures/acp-client.js";
import { findGrok, startLive } from "./fixtures/live.js";

const grok = findGrok();

test.skipIf(!grok)(
  "every turn reaches Paseo, also from a terminal that is not on Grok's leader",
  { timeout: 240_000 },
  async () => {
    if (!grok) return;
    const live = await startLive(grok, "first terminal prompt", { reasoning: true });
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
      outsider = new AcpClient(grok, ["agent", "stdio"], grokEnv, project);
      await outsider.initialize();
      await outsider.call("session/load", { sessionId, cwd: project, mcpServers: [] });
      for (const prompt of ["fourth outside the leader", "fifth outside the leader"])
        await outsider.call("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: prompt }],
        });
      await expect.poll(items, { timeout: 30_000 }).toEqual([
        ...turn("first terminal prompt"),
        ...turn("second from paseo"),
        ...turn("third from the terminal"),
        // Once, telling the user to share the session through `grok --leader`.
        "notification: ",
        ...turn("fourth outside the leader"),
        ...turn("fifth outside the leader"),
      ]);
      await idle();
    } finally {
      outsider?.close();
      await live.stop();
    }
  },
);

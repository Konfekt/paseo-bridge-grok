import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoDaemon, createRootLogger } from "@getpaseo/server";
import { expect, test, vi } from "vitest";
import { AcpClient } from "./fixtures/acp-client.js";
import { grokConfig, startModelServer } from "./fixtures/model-server.js";

/** The real Grok Build executable: GROK_BIN, else `grok` on PATH. */
function findGrok(): string | null {
  const candidate = process.env["GROK_BIN"] ?? "grok";
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 15_000 });
    return candidate;
  } catch {
    return null;
  }
}

const grok = findGrok();

test.skipIf(!grok)(
  "real Grok Build and Paseo share a terminal session through Grok's leader",
  { timeout: 180_000 },
  async () => {
    if (!grok) return;
    const root = await mkdtemp(join(tmpdir(), "pbg-live-"));
    const grokHome = join(root, "grok");
    const paseoHome = join(root, "paseo");
    const project = join(root, "project");
    await Promise.all([mkdir(grokHome), mkdir(paseoHome), mkdir(project)]);
    const model = await startModelServer({ slowMs: 2_500 });
    await writeFile(join(grokHome, "config.toml"), grokConfig(model.url));
    const grokEnv = {
      ...process.env,
      GROK_HOME: grokHome,
      GROK_DISABLE_AUTOUPDATER: "1",
      XAI_API_KEY: "",
    };
    const terminal = new AcpClient(grok, ["agent", "--leader", "stdio"], grokEnv, project);
    const { dependencies } = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const paseoVersion = dependencies["@getpaseo/server"];
    if (!paseoVersion) throw new Error("Missing @getpaseo/server dependency");
    const daemon = await createPaseoDaemon(
      {
        listen: "127.0.0.1:0",
        paseoHome,
        daemonVersion: paseoVersion,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        browserToolsEnabled: false,
        staticDir: root,
        mcpDebug: false,
        agentClients: {},
        agentStoragePath: join(paseoHome, "agents"),
        relayEnabled: false,
        pluginsEnabled: true,
        providerOverrides: {
          "grok-terminal": {
            command: [grok],
            env: { GROK_HOME: grokHome, GROK_DISABLE_AUTOUPDATER: "1", XAI_API_KEY: "" },
          },
        },
      },
      createRootLogger({ level: "error" }),
    );
    vi.stubEnv("PASEO_HOME", paseoHome);
    let client: ReturnType<typeof createHostClient> | undefined;
    try {
      // The terminal starts a session and saves its first message before Paseo looks.
      await terminal.initialize();
      const created = await terminal.call("session/new", { cwd: project, mcpServers: [] });
      const sessionId = created["sessionId"] as string;
      await terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "hello from the terminal" }],
      });

      await daemon.start();
      const address = daemon.getListenTarget();
      if (address?.type !== "tcp") throw new Error("No bound Paseo listener");
      await writeFile(
        join(paseoHome, "paseo.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: hostname(),
          uid: process.getuid?.() ?? 0,
          listen: `127.0.0.1:${address.port}`,
        }),
      );
      client = createHostClient(`127.0.0.1:${address.port}`, {
        clientId: "grok-live",
        clientType: "cli",
        reconnect: { enabled: false },
      });
      await client.connect();
      const connected = client;
      const pluginDirectory = process.env["PASEO_BRIDGE_TEST_PLUGIN_DIR"] ?? resolve(".");
      expect(await client.installDirectoryPlugin(pluginDirectory)).toMatchObject({
        id: "paseo-bridge-grok",
        status: "running",
      });

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
      await client.close();
      client = undefined;
      await daemon.stop();
      const afterDetach = terminal.notifications.length;
      await terminal.call("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "still attached" }],
      });
      expect(terminal.streamed(afterDetach)).toContain("reply to: still attached");
    } finally {
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      terminal.close();
      try {
        execFileSync(grok, ["leader", "kill"], { env: grokEnv, stdio: "ignore", timeout: 15_000 });
      } catch {
        // No leader left to stop.
      }
      await model.close();
    }
  },
);

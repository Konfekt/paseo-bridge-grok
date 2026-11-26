import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHostClient } from "@getpaseo/client/node";
import { createPaseoDaemon, createRootLogger } from "@getpaseo/server";
import { expect, vi } from "vitest";
import { AcpClient } from "./acp-client.js";
import { grokConfig, startModelServer } from "./model-server.js";

/** The real Grok Build executable: GROK_BIN, else `grok` on PATH. */
export function findGrok(): string | null {
  const candidate = process.env["GROK_BIN"] ?? "grok";
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore", timeout: 15_000 });
    return candidate;
  } catch {
    return null;
  }
}

export type HostClient = ReturnType<typeof createHostClient>;

/**
 * Real Grok Build in a throwaway home with a local fake model, a terminal stand-in that has
 * saved a first prompt, and the released Paseo server with this plugin installed.
 */
export async function startLive(
  grok: string,
  firstPrompt: string,
  options: { reasoning?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "pbg-live-"));
  const grokHome = join(root, "grok");
  const paseoHome = join(root, "paseo");
  const project = join(root, "project");
  await Promise.all([mkdir(grokHome), mkdir(paseoHome), mkdir(project)]);
  const model = await startModelServer({ slowMs: 2_500, ...options });
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
  let client: HostClient | undefined;
  const stop = async () => {
    await client?.close().catch(() => undefined);
    client = undefined;
    await daemon.stop().catch(() => undefined);
    terminal.close();
    try {
      execFileSync(grok, ["leader", "kill"], { env: grokEnv, stdio: "ignore", timeout: 15_000 });
    } catch {
      // No leader left to stop.
    }
    await model.close();
  };
  try {
    await terminal.initialize();
    const created = await terminal.call("session/new", { cwd: project, mcpServers: [] });
    const sessionId = created["sessionId"] as string;
    await terminal.call("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: firstPrompt }],
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
    expect(await connected.installDirectoryPlugin(pluginDirectory)).toMatchObject({
      id: "paseo-bridge-grok",
      status: "running",
    });
    return {
      grokHome,
      grokEnv,
      project,
      model,
      terminal,
      sessionId,
      daemon,
      client: connected,
      /** Disconnect the client only, leaving the daemon to `stop`. */
      async closeClient() {
        await client?.close().catch(() => undefined);
        client = undefined;
      },
      agents: async () => (await connected.fetchAgents()).entries.map((entry) => entry.agent),
      timeline: async (agentId: string) =>
        JSON.stringify(await connected.fetchAgentTimeline(agentId)),
      activeTurn: (agentId: string) => daemon.agentManager.getAgent(agentId)?.activeTurnId ?? null,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

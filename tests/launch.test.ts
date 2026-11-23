import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AGENT_ARGS, agentLaunch, grokCli, grokStatus } from "../src/launch.js";

function launch(command: string, args: string[] = []) {
  return { command, args, env: { PATH: process.env["PATH"] ?? "" } };
}

async function fakeGrok(output: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "pbg-launch-")), "grok");
  await writeFile(path, `#!/bin/sh\necho '${output}'\n`);
  await chmod(path, 0o755);
  return path;
}

test("launches grok's ACP agent through the shared leader", () => {
  expect(agentLaunch(undefined).args).toEqual([...AGENT_ARGS]);
  expect(agentLaunch(launch("/opt/grok", ["--leader-socket", "/s"])).args).toEqual([
    "--leader-socket",
    "/s",
    ...AGENT_ARGS,
  ]);
  expect(agentLaunch(launch("grok", ["agent", "stdio"])).args).toEqual(["agent", "stdio"]);
});

test("status reports supported, newer and too old releases", async () => {
  expect(await grokStatus(launch(await fakeGrok("grok 1.0.92 (abc)")))).toEqual({
    available: true,
  });
  const newer = await grokStatus(launch(await fakeGrok("grok 5.0.0 (abc)")));
  expect(newer).toMatchObject({
    available: true,
    diagnostic: expect.stringContaining("tentatively"),
  });
  const old = await grokStatus(launch(await fakeGrok("grok 0.9.0")));
  expect(old).toMatchObject({ available: false, diagnostic: expect.stringContaining("or newer") });
  const missing = await grokStatus(launch("/nonexistent/grok"));
  expect(missing).toMatchObject({
    available: false,
    diagnostic: expect.stringContaining("install.sh"),
  });
});

test("the Grok CLI keeps the launch's executable, environment and global options", async () => {
  const cli = grokCli({
    command: process.execPath,
    args: [
      "-e",
      "console.log(JSON.stringify([process.argv.slice(1), process.env.GROK_HOME]))",
      "agent",
      "--leader",
      "stdio",
    ],
    env: { GROK_HOME: "/grok-home" },
  });
  expect(JSON.parse(await cli(["usage", "s1"]))).toEqual([["usage", "s1"], "/grok-home"]);
  const failing = grokCli({
    command: process.execPath,
    args: ["-e", "console.error('no session'); process.exit(3)"],
    env: {},
  });
  await expect(failing(["usage", "s1"])).rejects.toThrow("grok usage failed: no session");
});

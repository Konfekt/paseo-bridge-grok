import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { bridgeReport, leaderSocketPath, tomlBoolean } from "../src/diagnostics.js";
import { sessionLogPath } from "../src/session-log.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("diagnostics", () => {
  test("reads boolean keys of a TOML table", () => {
    const text = '[cli]\nuse_leader = false # off\n\n[features]\nshared_daemon = true\nx = "y"\n';
    expect(tomlBoolean(text, "features", "shared_daemon")).toBe(true);
    expect(tomlBoolean(text, "cli", "use_leader")).toBe(false);
    expect(tomlBoolean(text, "features", "missing")).toBeUndefined();
    expect(tomlBoolean("features.shared_daemon = true", "features", "shared_daemon")).toBe(true);
  });

  test("finds the leader socket of a launch", () => {
    const env = { GROK_HOME: "/g" };
    expect(leaderSocketPath({ command: "grok", args: ["agent", "--leader", "stdio"], env })).toBe(
      join("/g", "leader.sock"),
    );
    expect(
      leaderSocketPath({ command: "grok", args: ["--leader-socket", "/s.sock", "agent"], env }),
    ).toBe("/s.sock");
    expect(leaderSocketPath({ command: "grok", args: ["--leader-socket=/t.sock"], env })).toBe(
      "/t.sock",
    );
  });

  test("reports sockets, settings, environment, the session log and open windows", async () => {
    const home = mkdtempSync(join(tmpdir(), "pbg-diag-"));
    dirs.push(home);
    writeFileSync(join(home, "config.toml"), "[features]\nshared_daemon = true\n");
    writeFileSync(join(home, "leader.sock"), "");
    writeFileSync(
      join(home, "active_sessions.json"),
      JSON.stringify([
        { session_id: "s1", pid: 11 },
        { session_id: "s1", pid: 12 },
        { session_id: "other", pid: 13 },
      ]),
    );
    const log = sessionLogPath(home, "/p", "s1");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "{}\n");
    const report = await bridgeReport({
      launch: {
        command: "grok",
        args: ["agent", "--leader", "stdio"],
        env: { GROK_HOME: home, XAI_API_KEY: "secret-value", PATH: "/bin" },
      },
      sessionId: "s1",
      cwd: "/p",
      follow: { path: log, followed: 3 },
      commandLine: async (pid) => (pid === 11 ? "grok --leader" : null),
    });
    expect(report).toContain(`\`${join(home, "leader.sock")}\` (present)`);
    expect(report).toContain(".daemon` (absent)");
    expect(report).toContain("features.shared_daemon = true, cli.use_leader = unset");
    expect(report).toContain(`GROK_HOME=${home}, GROK_CONFIG_PATH=(unset)`);
    expect(report).toContain("also set: XAI_API_KEY");
    expect(report).not.toContain("secret-value");
    expect(report).toContain("(3 bytes, modified ");
    expect(report).toContain("3 entries followed from it");
    expect(report).toContain("Grok window 11: `grok --leader`");
    expect(report).toContain("Grok window 12: not running");
    expect(report).not.toContain("window 13");
  });

  test("says when the session log is missing", async () => {
    const home = mkdtempSync(join(tmpdir(), "pbg-diag-"));
    dirs.push(home);
    const report = await bridgeReport({
      launch: { command: "grok", args: [], env: { GROK_HOME: home } },
      sessionId: "s1",
      cwd: "/p",
      follow: { path: null, followed: 0 },
    });
    expect(report).toContain("(missing; turns of Grok windows outside");
    expect(report).toContain("Grok windows with this session open: none listed");
  });
});

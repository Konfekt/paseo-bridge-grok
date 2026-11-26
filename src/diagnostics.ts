import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GrokLaunch } from "./launch.js";
import { grokHome, sessionLogPath } from "./session-log.js";

/** What `/bridge` reports about the session log follower of an attached stream. */
export interface FollowStatus {
  path: string | null;
  followed: number;
}

export interface BridgeReportInput {
  launch: GrokLaunch;
  sessionId: string;
  cwd: string | null;
  follow: FollowStatus;
  /** Reads a process's command line; null when it is not running or not readable. */
  commandLine?: (pid: number) => Promise<string | null>;
}

/** Variables whose values `/bridge` shows; any other Grok or xAI variable shows by name only. */
const SHOWN_VARIABLES = ["GROK_HOME", "GROK_CONFIG_PATH", "GROK_SHARED_DAEMON"] as const;

/** The leader socket a launch connects to: `--leader-socket PATH`, else the home's default. */
export function leaderSocketPath(launch: GrokLaunch): string {
  const index = launch.args.indexOf("--leader-socket");
  const configured = index >= 0 ? launch.args[index + 1] : undefined;
  const inline = launch.args.find((arg) => arg.startsWith("--leader-socket="));
  return (
    configured ??
    inline?.slice("--leader-socket=".length) ??
    join(grokHome(launch.env), "leader.sock")
  );
}

/** A boolean key of one TOML table, read without a TOML parser; undefined when unset. */
export function tomlBoolean(text: string, table: string, key: string): boolean | undefined {
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header?.[1]) {
      current = header[1].trim();
      continue;
    }
    const match = /^([\w.-]+)\s*=\s*(true|false)$/.exec(line);
    if (!match?.[1]) continue;
    const dotted = current ? `${current}.${match[1]}` : match[1];
    if (dotted === `${table}.${key}`) return match[2] === "true";
  }
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function defaultCommandLine(pid: number): Promise<string | null> {
  try {
    process.kill(pid, 0);
  } catch {
    return null;
  }
  return readFile(`/proc/${pid}/cmdline`, "utf8").then(
    (text) => text.split("\0").filter(Boolean).join(" ") || "(running)",
    () => "(running)",
  );
}

function yesNo(value: boolean): string {
  return value ? "present" : "absent";
}

/**
 * How this stream reaches its Grok session, for `/bridge`: the Grok home and sockets, the
 * leader settings, the environment the bridge starts Grok with, the session log it follows,
 * and the Grok windows that have the session open. A terminal shares the bridge's daemon only
 * when started with the same model route, starting model, `GROK_CONFIG_PATH` and environment.
 */
export async function bridgeReport(input: BridgeReportInput): Promise<string> {
  const { launch, sessionId, cwd, follow } = input;
  const env = launch.env;
  const home = grokHome(env);
  const socket = leaderSocketPath(launch);
  const configPath = env["GROK_CONFIG_PATH"] || join(home, "config.toml");
  const config = await readFile(configPath, "utf8").catch(() => "");
  const shared = tomlBoolean(config, "features", "shared_daemon");
  const useLeader = tomlBoolean(config, "cli", "use_leader");
  const shown = SHOWN_VARIABLES.map((name) => `${name}=${env[name] ?? "(unset)"}`).join(", ");
  const others = Object.keys(env)
    .filter(
      (name) => /^(GROK|XAI)_/.test(name) && !(SHOWN_VARIABLES as readonly string[]).includes(name),
    )
    .sort();
  const lines = [
    "**Bridge diagnostics**",
    `- Grok command: \`${[launch.command, ...launch.args].join(" ")}\``,
    `- Grok home: \`${home}\``,
    `- Leader socket: \`${socket}\` (${yesNo(await exists(socket))})`,
    `- Shared daemon socket: \`${socket}.daemon\` (${yesNo(await exists(`${socket}.daemon`))})`,
    `- Config \`${configPath}\`: features.shared_daemon = ${shared ?? "unset"}, cli.use_leader = ${useLeader ?? "unset"}`,
    `- Environment: ${shown}${others.length ? `; also set: ${others.join(", ")}` : ""}`,
  ];
  const path = follow.path ?? (cwd ? sessionLogPath(home, cwd, sessionId) : null);
  if (path) {
    const info = await stat(path).catch(() => null);
    lines.push(
      info
        ? `- Session log: \`${path}\` (${info.size} bytes, modified ${info.mtime.toISOString()}); ${follow.followed} entries followed from it`
        : `- Session log: \`${path}\` (missing; turns of Grok windows outside the bridge's leader cannot be followed)`,
    );
  }
  const read = input.commandLine ?? defaultCommandLine;
  const active = await readFile(join(home, "active_sessions.json"), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .catch(() => []);
  const windows = Array.isArray(active)
    ? active.filter(
        (entry): entry is { pid: number } =>
          !!entry &&
          typeof entry === "object" &&
          (entry as { session_id?: unknown }).session_id === sessionId &&
          typeof (entry as { pid?: unknown }).pid === "number",
      )
    : [];
  if (!windows.length) lines.push("- Grok windows with this session open: none listed");
  for (const window of windows) {
    const command = await read(window.pid);
    lines.push(`- Grok window ${window.pid}: ${command ? `\`${command}\`` : "not running"}`);
  }
  return lines.join("\n");
}

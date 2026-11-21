import { spawn } from "node:child_process";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import {
  grokSupport,
  grokVersionRequirement,
  parseGrokVersionOutput,
  warnTentativeGrok,
} from "./versions.js";

/** Default executable; Paseo resolves `agents.providers.grok-terminal.command` over it. */
export const DEFAULT_COMMAND = ["grok"] as const;
/** Attach through Grok's shared leader, the process a terminal started with `--leader` uses. */
export const AGENT_ARGS = ["agent", "--leader", "stdio"] as const;

export interface GrokLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * The ACP command for a Paseo launch. A configured command names the Grok executable and
 * optional global options such as `--leader-socket PATH`; the agent arguments are appended.
 * A command that already contains `agent` is used unchanged, for setups that need other
 * agent options.
 */
export function agentLaunch(launch?: ProviderLaunch): GrokLaunch {
  const command = launch?.command ?? DEFAULT_COMMAND[0];
  const configured = launch?.args ?? [];
  const args = configured.includes("agent") ? [...configured] : [...configured, ...AGENT_ARGS];
  return { command, args, env: launch?.env ? { ...launch.env } : inheritedEnv() };
}

export type GrokStatus =
  | { available: true; diagnostic?: string }
  | { available: false; diagnostic: string };

const VERSION_TIMEOUT_MS = 15_000;

function runVersion(launch: GrokLaunch): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, ["--version"], {
      env: launch.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${launch.command} --version did not finish`));
    }, VERSION_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(`${launch.command} --version exited with ${code}: ${output.trim()}`));
    });
  });
}

/** Paseo's provider status: the executable exists and its release is supported. */
export async function grokStatus(launch?: ProviderLaunch): Promise<GrokStatus> {
  const resolved = agentLaunch(launch);
  let output: string;
  try {
    output = await runVersion(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      available: false,
      diagnostic:
        code === "ENOENT"
          ? `Grok Build executable not found: ${resolved.command}. Install it with "curl -fsSL https://x.ai/cli/install.sh | bash" or set agents.providers.grok-terminal.command.`
          : `Grok Build version check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const version = parseGrokVersionOutput(output);
  if (!version || grokSupport(version) === "unsupported")
    return { available: false, diagnostic: grokVersionRequirement(version) };
  const warning = warnTentativeGrok(version);
  return warning ? { available: true, diagnostic: warning } : { available: true };
}

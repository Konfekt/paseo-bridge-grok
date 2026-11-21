#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { DEFAULT_LOOKBACK_HOURS, discoverOnce, lookbackHours } from "./discovery.js";
import { connectPaseoHost } from "./paseo-client.js";

const HELP = `Usage: paseo-bridge-grok [once] [--paseo-home PATH] [--hours N]

once        Run one discovery pass and exit (default).
--hours N   Import Grok sessions active in the last N hours (default ${DEFAULT_LOOKBACK_HOURS},
            or PASEO_BRIDGE_GROK_LOOKBACK_HOURS).

Requires a running Paseo daemon with the paseo-bridge-grok plugin enabled.
Continuous discovery starts and stops with the plugin; no separate worker is needed.
Uses Paseo's existing local credentials; never starts a daemon or sends a prompt.
`;

export async function main(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }
  let commandSet = false;
  let home: string | undefined;
  let hours = lookbackHours();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--paseo-home") {
      home = args[++index];
      if (!home || home.startsWith("-")) throw new Error("--paseo-home requires a path");
    } else if (arg === "--hours") {
      hours = lookbackHours({ PASEO_BRIDGE_GROK_LOOKBACK_HOURS: args[++index] ?? "" });
    } else if (!commandSet && arg === "once") {
      commandSet = true;
    } else {
      throw new Error(`Unknown argument: ${arg}. Use --help.`);
    }
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const connection = await connectPaseoHost(home, controller.signal);
    try {
      const since = new Date(Date.now() - hours * 3_600_000).toISOString();
      const { imported } = await discoverOnce(connection.discovery, { since }, controller.signal);
      process.stdout.write(
        imported.length ? `Imported ${imported.join(", ")}\n` : "No new Grok sessions to import\n",
      );
    } finally {
      await connection.close();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

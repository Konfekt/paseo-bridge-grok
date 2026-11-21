# paseo-bridge-grok

Attach terminal-started [Grok Build](https://x.ai/cli) sessions to unmodified [Paseo](https://github.com/getpaseo/paseo). The terminal and Paseo drive the same native Grok session: prompts and replies from either side show up in both, and closing one side leaves the other attached.

The package is a Paseo plugin. It supplies a **Grok Terminal** provider (`grok-terminal`) and a discovery loop that runs inside the Paseo daemon. Grok Build does the work itself; the bridge only connects Paseo to it. No shell wrapper, screen scraping or second execution engine is involved.

## How it works

Grok Build can run one shared background process per Grok home, the _leader_ (`$GROK_HOME/leader.sock`). Every Grok window or ACP client started with `--leader` attaches to it, and all of them see the same live session: streamed replies, model changes, the running prompt, titles.
- **Provider.** Paseo's own ACP client talks to `grok agent --leader stdio`, so a Paseo agent is just another client of the terminal's leader. A thin stream layer adapts Grok's behaviour to Paseo:
  - turns started in the terminal are reported to Paseo as running turns, with their prompt text, from Grok's queue notifications (plain ACP only reports a client's own turns);
  - Paseo detaching never sends `session/close`, because Grok's leader closes a session for every client at once; only the Paseo process ends;
  - Paseo's catalog requests are answered from the model list Grok reports at startup instead of creating throwaway Grok sessions;
  - streamed messages get stable IDs per prompt, so separate turns do not merge in the timeline;
  - attaching keeps the session's own model, reasoning effort and tools; Paseo's defaults and MCP servers are not pushed onto a terminal session.
- **Discovery.** Every few seconds the plugin asks Paseo for Grok sessions that are not yet attached and imports them. Each session gets its own Paseo workspace in the session's directory, titled after Grok's session title, so it has its own sidebar entry. Title changes in Grok are copied to the agent and its workspace.

## Requirements

- **Paseo 0.16.0 or newer** on the machine that runs Grok Build. Verified: 0.16.0, 0.16.2 and 0.17.0. Newer releases are accepted tentatively and log a one-time warning (`Paseo host ... is newer than the tested range ...; continuing tentatively`).
- **Grok Build 1.0.60 or newer.** Verified: 1.0.60 through 1.0.92. Newer releases are accepted tentatively with a one-time warning; older releases are rejected with a clear message (1.0.55 and earlier lack what discovery needs).
- Node.js 22 or newer and pnpm, which Paseo uses to build the plugin.
- Linux. macOS should work the same way but has not been tested; Windows has not been tested.

## Install

1. Install and sign in to Grok Build, if not done yet:

   ```sh
   curl -fsSL https://x.ai/cli/install.sh | bash
   grok login
   ```

2. Enable plugins in Paseo (root setting `pluginsEnabled` in `$PASEO_HOME/config.json`, default `~/.paseo/config.json`), then install the plugin from GitHub:

   ```sh
   paseo daemon config set pluginsEnabled true
   paseo daemon reload
   paseo plugin install github:Konfekt/paseo-bridge-grok
   paseo plugin ls
   ```

   Paseo asks you to trust the plugin: its server code runs with the daemon's permissions. It prepares the checkout with `pnpm install --frozen-lockfile` and `pnpm build` and logs the output in `$PASEO_HOME/daemon.log`. `paseo provider ls` should now list **Grok Terminal** as `available`.

3. Make the terminal use Grok's shared leader. Either start Grok with the flag:

   ```sh
   grok --leader
   ```

   or make it the default for Grok windows signed in with a Grok account, in `~/.grok/config.toml`:

   ```toml
   [features]
   shared_daemon = true
   ```

   A window that does not run on the leader still works on its own and its sessions are still imported, but Paseo and that window then each run their own copy of the session; see [Troubleshooting](#troubleshooting).

To install from a local checkout instead:

```sh
pnpm install --frozen-lockfile
pnpm build
paseo plugin install "$PWD"
```

## Update

```sh
paseo plugin update paseo-bridge-grok --yes
```

`paseo plugin update paseo-bridge-grok --check` shows whether an update is available. For a local checkout, pull, run `pnpm install --frozen-lockfile && pnpm build`, then `paseo plugin reload paseo-bridge-grok`.

Update Grok Build itself with `grok update` (or its automatic updates). Restart running Grok windows afterwards; `grok leader kill` stops an old leader so the next window starts the new release.

## Usage

Start `grok --leader` in a project and send a first prompt. Within a few seconds the session appears in Paseo as **Grok Terminal** in its own workspace, with its history.

| Action                                    | Result                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| Prompt in the terminal                    | Paseo shows the prompt, marks the agent running, streams the reply and marks it idle.       |
| Send a message in Paseo                   | Grok runs it in the same session; the terminal shows the prompt and the reply.              |
| Pick a model or effort in Paseo           | Grok switches the shared session; the terminal shows the new model. The reverse also works. |
| Stop in Paseo                             | Cancels the running prompt, also one the terminal started.                                  |
| Rename the session in Grok                | The Paseo agent and its workspace take the new title.                                       |
| Close the terminal                        | The session stays attached in Paseo and keeps working there.                                |
| Close Paseo or the plugin                 | The terminal keeps its session.                                                             |
| Archive the agent or workspace in Paseo   | The session is not imported again.                                                          |
| Create a **Grok Terminal** agent in Paseo | Starts a new Grok session on the leader, which `grok --leader` can resume (`/resume`).      |

Discovery imports sessions active in the last 24 hours. Change the window with the environment variable `PASEO_BRIDGE_GROK_LOOKBACK_HOURS` on the Paseo daemon, or import older sessions once:

```sh
node ~/.paseo/plugins/paseo-bridge-grok/server/cli.js once --hours 720
```

(use the plugin directory shown by `paseo plugin ls`; `--paseo-home PATH` selects another Paseo home).

### Another Grok home or binary

Paseo starts Grok with its own environment. If Grok is not on the daemon's `PATH`, or the terminal uses another `GROK_HOME`, add a provider override to `$PASEO_HOME/config.json` and run `paseo daemon reload`:

```json
{
  "agents": {
    "providers": {
      "grok-terminal": {
        "command": ["/home/me/.grok/bin/grok"],
        "env": { "GROK_HOME": "/home/me/.grok" }
      }
    }
  }
}
```

Global Grok options can follow the binary, for example `["grok", "--leader-socket", "/path/leader.sock"]`; the bridge appends `agent --leader stdio`. A command that already contains `agent` is used unchanged.

Grok, its home and the Paseo daemon must be on the same machine. For a remote machine, install Paseo and this plugin there and add that daemon as a host in the Paseo app.

## Troubleshooting

- **Grok Terminal is `unavailable`.** `paseo provider ls` shows the reason. _Executable not found_: install Grok Build or set `command` as above. _Grok Build 1.0.60 or newer is required_: run `grok update`.
- **Nothing is imported.** Send a first prompt: Grok does not list a session before it has a message. Check `paseo plugin ls` (status `running`), that `pluginsEnabled` is `true`, and `paseo plugin logs paseo-bridge-grok`. The session must be in the Grok home that Paseo uses (`GROK_HOME`, default `~/.grok`) and active within the lookback window.
- **Terminal and Paseo show different conversations.** The terminal is not on the leader. Close it and resume the session with `grok --leader` (or `grok --leader -r <session>`). Without the leader both processes write the same session independently.
- **`shared_daemon = true` does not share.** Grok uses the shared daemon only for windows signed in with a Grok account; windows using an API key or a custom model keep their own process. Use `grok --leader` instead.
- **The leader refuses to start under a sandbox profile.** Run Grok without the sandbox, or accept separate sessions.
- **Grok asks to sign in from Paseo.** Paseo creates new sessions as the daemon's user with the provider environment; sign in with `grok login` as that user and the same `GROK_HOME`.
- **A version warning in the plugin log.** A Paseo or Grok release newer than the verified range is in use. The bridge keeps working; report problems and pin a verified release if attached sessions misbehave.
- **Diagnostics.** `paseo plugin logs paseo-bridge-grok`, `$PASEO_HOME/daemon.log`, and Grok's own `grok leader list`.

## Limits

- Paseo lists sessions, not running windows. A terminal turn that is already running when Paseo attaches shows as running; one that ran while Paseo was not attached appears in the history.
- Sending a message in Paseo while a terminal turn runs may cancel that turn first, as Paseo does for its own running turns. Wait for the turn to finish, or send from the terminal.
- Paseo's MCP servers are not attached to terminal sessions; the session keeps the terminal's tools.
- Tool permission requests are answered by the client that sent the prompt; answering a terminal's pending request from Paseo has not been verified.
- Each attached agent keeps one `grok agent` client process (about 70 MB) while Paseo has it open.

## Development

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm verify
```

`pnpm verify` runs Biome, strict type checks, the tests, the build and a package check that installs the packed plugin from a clean copy of the tracked files. The live test (`tests/grok-live.test.ts`) needs a `grok` executable (`GROK_BIN` or `PATH`) and is skipped without one; it uses a throwaway Grok home with a local fake model, so no account or network model is needed. See [docs/verification.md](docs/verification.md).

## License

MIT

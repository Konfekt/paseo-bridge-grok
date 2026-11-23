# Verification

What the automated checks cover, which releases they ran against, and what to check when Grok Build or Paseo ships a new release. The commit history records when things changed and why.

## Supported versions

| Component  | Verified                                                                | Accepted                                                           | Rejected                                           |
| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Grok Build | 1.0.60 – 1.0.92 (live test passes on 1.0.60, 1.0.75, 1.0.85 and 1.0.92) | Newer releases and pre-releases, with a one-time warning           | Below 1.0.60; 1.0.50 and 1.0.55 fail the live test |
| Paseo host | 0.16.x (locked helpers 0.16.2; daemons 0.16.0 and 0.16.2), 0.17.0       | Anything matching `>=0.16.0`; above 0.16.x with a one-time warning | Below 0.16.0 (Paseo refuses to load the plugin)    |

`src/versions.ts` holds the policy (`GROK_MIN_VERSION`, `GROK_TESTED_VERSION`, `PASEO_MIN_VERSION`, `PASEO_TESTED_VERSION`). Grok Build ships every release as a patch release, so only releases up to `GROK_TESTED_VERSION` exactly count as verified; for Paseo the whole tested minor line does. `paseo-plugin.json` holds the requirement Paseo enforces itself, and `tests/versions.test.ts` checks that it and the pinned `@getpaseo/*` packages match the constants.

The bridge rejects an unsupported Grok release twice: the provider status reports it (`grok --version`), and the ACP `initialize` answer is turned into an error naming the requirement, in case the configured binary and a running leader differ.

## What the live test does

`tests/grok-live.test.ts` runs the released Paseo server in-process with the plugin installed through Paseo's public plugin API, and the real Grok Build executable (`GROK_BIN`, else `grok` on `PATH`). Grok runs in a throwaway `GROK_HOME` whose only models are custom models pointing at a local fake OpenAI-compatible server (`tests/fixtures/model-server.ts`), so no Grok account, API key or network model is involved. A small ACP client (`tests/fixtures/acp-client.ts`) on `grok agent --leader stdio` stands in for the terminal window; it is the same leader protocol a `grok --leader` window uses.

The test asserts, in order:
1. A session the terminal created is imported automatically into its own workspace in the session's directory, titled after the session, with its history in the timeline.
2. A slow prompt sent by the terminal shows as a running turn in Paseo (`grok-turn:<prompt id>`), its prompt and reply appear in the timeline, and the turn ends.
3. A message sent through Paseo runs in the same Grok session, and the terminal receives the reply.
4. Paseo's model list contains Grok's models; picking one in Paseo changes the terminal's session, and a model picked in the terminal shows in Paseo.
5. Stopping in Paseo cancels a turn the terminal started (`stopReason: cancelled`).
6. Paseo's catalog requests did not create extra Grok sessions.
7. After Paseo disconnects and stops, the terminal can still prompt in the session.

`tests/grok-commands-live.test.ts` uses the same setup (`tests/fixtures/live.ts`) and sends slash commands through Paseo's client API, asserting:
1. Paseo's command list for the agent contains Grok's advertised commands and the bridge's.
2. `/help` and a terminal-only command (`/theme`) are answered in Paseo without a model call.
3. `/model` lists the models; `/model Local B` (a display name) switches the shared session: the terminal receives the config update and Paseo shows the model.
4. `/rename` reaches the terminal (`session_info_update`) and the Paseo agent title.
5. `/btw` sends the earlier conversation as context, and a later terminal prompt does not carry the side question in its history.
6. `/btw` sent with steering while a terminal turn runs is answered without cancelling that turn (`stopReason: end_turn`).
7. `/recap` shows Grok's recap; `/status` runs Grok's `/session-info` without a model call.
8. `/plan <task>` puts the session in plan mode (`current_mode_update` in the terminal) and runs the task; `/plan off` returns to the default mode.
9. `/fork` and `/new <prompt>` create Grok sessions that discovery imports as new agents, the fork under its Grok title, the new one with its prompt and reply.

`tests/grok-paseo-created-live.test.ts` starts the session from Paseo instead, as the app's new-agent button does, and asserts:
1. Paseo creates a Grok session on the leader and runs a message in it.
2. `/status` shows the session ID, `/usage` Grok's persisted token totals, and `/export` writes the transcript file.
3. Grok lists the session, and the terminal joins it with `session/load` and sees its history (what `grok --leader -r <ID>` does).
4. A terminal turn on that session shows in Paseo as a running turn and its reply reaches the timeline.
5. A later Paseo message reaches the terminal, with neither side closed.
6. Discovery does not import the Paseo-created session a second time.

The tests are skipped when no `grok` executable is found. `pnpm package:smoke` runs them again against the packed plugin.

## Manual end-to-end check

Run with a real `grok --leader` TUI in tmux, the same fake-model Grok home and standalone Paseo daemons started with the official `@getpaseo/cli` (0.16.0, 0.16.2 and 0.17.0):
- `paseo plugin install <checkout>`; `paseo provider ls` lists **Grok Terminal** as available.
- A prompt typed in the TUI is imported, titled, and shown by `paseo logs`.
- `paseo send` runs in the session and the TUI shows the prompt and reply.
- A later TUI prompt appears live in `paseo logs`; Grok's generated title is copied to the agent.
- `paseo run --provider grok-terminal` creates a new session on the leader, which discovery does not import a second time.
- After `paseo daemon stop`, the TUI keeps working in the session.
- Under 0.17.0 the plugin logs the tentative-host warning and works the same.
- Slash commands through `paseo send` (0.16.2 and 0.17.0 daemons): `/help`, `/btw` (also with `--behavior steer` during a TUI turn, which keeps running), `/model`, `/rename` (the TUI shows the title), `/plan`, `/recap`, `/fork`, `/new` and a rejected `/theme`; the TUI shows model, title and mode changes.

## Unit tests

| Area                     | File                                                                         | Covers                                                                                                                                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stream rewriting         | `tests/interceptor.test.ts`                                                  | Local catalog answers, swallowed `session/close`, MCP-free load, version rejection and warnings, message IDs, replayed user messages, foreign turns, own-prompt matching, titles                                                                                     |
| Stream transport         | `tests/stream.test.ts`                                                       | Pass-through, local replies, non-JSON output, unexpected exit with stderr, missing executable, bridge requests with hidden answers, notification listeners, hidden sessions                                                                                          |
| Provider wrapper         | `tests/provider.test.ts`                                                     | Native settings kept on attach, synthetic turns and user messages, failure on detach, turn already running at attach, title routing, back-to-back turns, steering capability, command list, local command turns, aliases, steered side commands, `/plan` with a task |
| Slash commands           | `tests/commands.test.ts`, `tests/command-runner.test.ts`                     | Parsing, routing precedence, rejection and help texts, Grok's command reference, model resolution; each bridge command against a fake Grok stream or CLI, usage formatting, and failures as replies                                                                  |
| Models                   | `tests/models.test.ts`                                                       | Tolerant model-state parsing, synthesized config options, catalog enrichment                                                                                                                                                                                         |
| Discovery                | `tests/discovery.test.ts`, `tests/session-workspace.test.ts`                 | Handle matching, import and reload, archived workspaces, isolated failures, lookback, polling with backoff, stable workspace IDs and titles                                                                                                                          |
| Titles, launch, versions | `tests/title-sync.test.ts`, `tests/launch.test.ts`, `tests/versions.test.ts` | Debounced titles, launch arguments and status diagnostics, version policy                                                                                                                                                                                            |

## Checking a new release

For a new **Grok Build** release:
1. Run the live test against it: `GROK_BIN=/path/to/grok pnpm vitest run tests/grok-live.test.ts`. Releases are downloadable as `https://x.ai/cli/grok-<version>-linux-x86_64`.
2. If it passes, raise `GROK_TESTED_VERSION` and run `pnpm verify`.
3. If it fails, keep the constant. Users on the new release get the tentative warning while the bridge keeps working as far as Grok allows.

What tends to break, and how it shows:
- **Vendor notifications renamed** (`_x.ai/queue/changed`, `_x.ai/session/prompt_complete`, `_x.ai/sessions/changed`): terminal turns no longer show as running in Paseo; their messages still appear.
- **`initialize._meta.modelState` reshaped**: Paseo's catalog falls back to Paseo's generic ACP behaviour; model lists may be empty or create a temporary Grok session.
- **Leader flags or socket changes**: the provider fails to start; the plugin log shows Grok's stderr.
- **`session/list` changes**: nothing is imported.
- **Extension methods renamed or reshaped** (`_x.ai/btw`, `_x.ai/recap` with its `session_recap` notification, `_x.ai/session/rename`, `_x.ai/session/fork`, `session/set_mode` IDs): that bridge command replies with Grok's error in Paseo (for example `/btw failed: Method not found`); everything else keeps working. If Grok starts advertising a command of the same name, Grok's version runs instead.
- **New terminal commands**: rejected clearly once they appear in Grok's installed command reference; otherwise they reach Grok as text. Add them to `TERMINAL_COMMANDS` in `src/commands.ts`.

For a new **Paseo** release:
1. Bump the four `@getpaseo/*` dependencies together, run `pnpm install`, then `pnpm verify`.
2. If everything passes, raise `PASEO_TESTED_VERSION`. Until then the plugin logs the tentative warning on that host.
3. `src/paseo-client.ts` imports three server modules by path (home, pid lock, local credential); check those paths still exist after a bump.

## Not covered

- Hosted Grok models with a real Grok account, and the `[features] shared_daemon = true` route, which Grok applies only to windows signed in with a Grok account.
- Tool permission requests across clients.
- macOS and Windows.
- The Paseo mobile and desktop apps; the checks use the Paseo client API and CLI.

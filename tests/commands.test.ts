import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BRIDGE_COMMANDS,
  helpText,
  modelListText,
  parseSlashCommand,
  readDocumentedCommands,
  resolveModelArgs,
  routeCommand,
  terminalOnlyText,
} from "../src/commands.js";
import type { GrokCommand } from "../src/interceptor.js";
import { terminalCommandSet } from "../src/provider.js";

const advertised: GrokCommand[] = [
  { name: "compact", description: "Compress" },
  { name: "session-info", description: "Show session details" },
];
const terminal = new Set(["theme", "resume", "status"]);
const route = (text: string, commands: GrokCommand[] | null = advertised) => {
  const command = parseSlashCommand(text);
  if (!command) throw new Error(`not a command: ${text}`);
  return routeCommand(command, commands, terminal);
};
const models = [
  {
    id: "model",
    currentValue: "grok-a",
    options: [
      { value: "grok-a", name: "Grok A" },
      { value: "grok-code", name: "Grok Code Fast" },
    ],
  },
  { id: "reasoning_effort", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
];

test("slash commands are told apart from paths and prose", () => {
  expect(parseSlashCommand("/BTW  what is this?\nmore")).toEqual({
    name: "btw",
    args: "what is this?\nmore",
  });
  expect(parseSlashCommand("  /help")).toEqual({ name: "help", args: "" });
  expect(parseSlashCommand("/usr/bin/env is missing")).toBeNull();
  expect(parseSlashCommand("use /model please")).toBeNull();
  expect(parseSlashCommand("/")).toBeNull();
});

test("Grok's advertised commands win, then the bridge's, then terminal-only rejections", () => {
  expect(route("/compact")).toEqual({ kind: "grok", text: "" });
  expect(route("/status now")).toEqual({ kind: "grok", text: "/session-info now" });
  expect(route("/status", [])).toEqual({ kind: "terminal", name: "status" });
  expect(route("/m grok-a")).toMatchObject({
    kind: "bridge",
    command: { name: "model" },
    args: "grok-a",
  });
  // A command Grok starts advertising itself runs natively.
  expect(route("/btw hi", [...advertised, { name: "btw", description: "" }])).toEqual({
    kind: "grok",
    text: "",
  });
  expect(route("/theme dark")).toEqual({ kind: "terminal", name: "theme" });
  expect(route("/unheard-of")).toEqual({ kind: "message" });
});

test("rejections say where the command works and what to use instead", () => {
  expect(terminalOnlyText("theme")).toContain("/theme only works in the Grok terminal");
  expect(terminalOnlyText("resume")).toContain("Paseo lists your Grok sessions as agents");
});

test("help lists Grok's commands, the bridge's, aliases, and terminal-only ones", () => {
  const text = helpText(advertised, terminal);
  expect(text).toContain("`/compact` — Compress");
  for (const command of BRIDGE_COMMANDS) expect(text).toContain(`/${command.name}`);
  expect(text).toContain("/status runs /session-info");
  expect(text).toContain("**Terminal only** (rejected here): /resume, /theme");
  expect(helpText(null, terminal)).toContain("Grok has not listed its commands");
});

test("Grok's installed command reference extends the terminal-only list", async () => {
  const home = await mkdtemp(join(tmpdir(), "pbg-docs-"));
  await mkdir(join(home, "docs", "user-guide"), { recursive: true });
  await writeFile(
    join(home, "docs", "user-guide", "04-slash-commands.md"),
    [
      "## Session",
      "### `/future-thing [arg]`",
      "Aliases: `/ft`, `/fut`",
      "Text mentioning `/not-a-heading` is ignored.",
      "### `/btw <question>`",
    ].join("\n"),
  );
  expect(readDocumentedCommands(home)).toEqual(
    expect.arrayContaining(["btw", "ft", "fut", "future-thing"]),
  );
  expect(readDocumentedCommands(home)).not.toContain("not-a-heading");
  const set = terminalCommandSet(home);
  expect(set.has("future-thing")).toBe(true);
  expect(set.has("theme")).toBe(true);
  // The bridge's own commands are never rejected.
  expect(set.has("btw")).toBe(false);
});

test("models resolve by ID or name, with an optional effort", () => {
  expect(resolveModelArgs(models, "grok-code")).toEqual({ model: "grok-code" });
  expect(resolveModelArgs(models, "grok code fast")).toEqual({ model: "grok-code" });
  expect(resolveModelArgs(models, "Grok A LOW")).toEqual({ model: "grok-a", effort: "low" });
  expect(resolveModelArgs(models, "nope")).toEqual({
    error: 'Unknown model "nope". Available: grok-a, grok-code.',
  });
  expect(resolveModelArgs([], "x")).toHaveProperty("error");
  const list = modelListText(models);
  expect(list).toContain("`grok-a` (Grok A) — current");
  expect(list).toContain("Reasoning effort: low, **high**");
});

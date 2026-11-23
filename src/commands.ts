import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GrokCommand } from "./interceptor.js";

/** A slash command typed in Paseo: `/name arguments`. */
export interface SlashCommand {
  name: string;
  args: string;
}

const SLASH = /^\s*\/([A-Za-z][\w-]*)(?:[ \t]+([\s\S]*))?$/;

/**
 * Read a prompt as a slash command. Only a prompt that starts with `/word` followed by
 * whitespace or the end qualifies, so a path such as `/usr/bin/env fails` stays a message.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const match = SLASH.exec(text);
  if (!match?.[1]) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() };
}

/** Commands the bridge carries out itself, because Grok does not advertise them over ACP. */
export interface BridgeCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  argumentHint?: string;
  /** Answers without touching the conversation, so it may run beside a running turn. */
  aside: boolean;
}

export const BRIDGE_COMMANDS: readonly BridgeCommand[] = [
  {
    name: "btw",
    aliases: [],
    description: "Ask a side question about this session; the answer stays out of the conversation",
    argumentHint: "<question>",
    aside: true,
  },
  {
    name: "model",
    aliases: ["m"],
    description: "Show the models, or switch this session's model (and reasoning effort)",
    argumentHint: "[model] [effort]",
    aside: false,
  },
  {
    name: "effort",
    aliases: [],
    description: "Show or set the reasoning effort of the current model",
    argumentHint: "[level]",
    aside: false,
  },
  {
    name: "rename",
    aliases: ["title"],
    description: "Rename this Grok session",
    argumentHint: "<title>",
    aside: true,
  },
  {
    name: "recap",
    aliases: [],
    description: "Summarize this session in one sentence",
    aside: true,
  },
  {
    name: "plan",
    aliases: [],
    description: "Enter plan mode, optionally with a task; `/plan off` leaves it",
    argumentHint: "[task | off]",
    aside: false,
  },
  {
    name: "fork",
    aliases: [],
    description: "Copy this session into a new Grok session, listed as a new agent",
    argumentHint: "[title]",
    aside: true,
  },
  {
    name: "new",
    aliases: ["clear"],
    description:
      "Start a new Grok session in this folder with a first prompt, listed as a new agent",
    argumentHint: "<prompt>",
    aside: true,
  },
  {
    name: "usage",
    aliases: ["cost"],
    description: "Show this session's token and cost usage, in total or for one turn",
    argumentHint: "[turn]",
    aside: true,
  },
  {
    name: "export",
    aliases: [],
    description: "Export this session's transcript as Markdown to a new file in its folder",
    argumentHint: "[file]",
    aside: true,
  },
  {
    name: "help",
    aliases: [],
    description: "List the commands available here",
    aside: true,
  },
];

/** Aliases of commands Grok advertises, which Grok itself only resolves in its terminal. */
export const GROK_ALIASES: Readonly<Record<string, string>> = {
  status: "session-info",
  info: "session-info",
};

/**
 * Grok Build terminal commands that have no remote counterpart. Typed in Paseo they would
 * otherwise reach the model as a message. Grok's installed command reference adds commands
 * of newer releases at runtime; see {@link readDocumentedCommands}.
 */
export const TERMINAL_COMMANDS: readonly string[] = [
  "agents",
  "agents-dashboard",
  "always-approve",
  "auto-review",
  "changelog",
  "compact-mode",
  "config",
  "config-agents",
  "connectors",
  "context-window",
  "copy",
  "dashboard",
  "delete",
  "density",
  "docs",
  "doctor",
  "dream",
  "edit-prompt",
  "exit",
  "expand",
  "find",
  "flush",
  "full",
  "fullscreen",
  "guides",
  "history",
  "home",
  "hooks",
  "howto",
  "imagine",
  "imagine-video",
  "import-claude",
  "jump",
  "login",
  "logout",
  "marketplace",
  "mcps",
  "mem",
  "memory",
  "minimal",
  "ml",
  "models",
  "multiline",
  "onboarding",
  "personas",
  "plan-view",
  "plugins",
  "preferences",
  "prefs",
  "privacy",
  "quit",
  "release-notes",
  "remember",
  "resume",
  "rewind",
  "sessions",
  "settings",
  "show-plan",
  "skills",
  "t",
  "theme",
  "timeline",
  "timestamps",
  "tour",
  "tutorial",
  "undo",
  "view-plan",
  "vim-mode",
  "welcome",
  "workflows",
];

/** What to use instead, for rejected commands where Paseo has an equivalent. */
const ALTERNATIVES: Readonly<Record<string, string>> = {
  resume:
    "Paseo lists your Grok sessions as agents; open the one you want. To continue this one in a terminal, run `grok --leader -r <session ID or title>` there (`/status` shows the ID).",
  copy: "Use Paseo's copy action on the message, or `/export` for the whole transcript.",
  sessions: "Paseo lists your Grok sessions as agents; open the one you want.",
  dashboard: "Paseo lists your Grok sessions as agents; open the one you want.",
  "agents-dashboard": "Paseo lists your Grok sessions as agents; open the one you want.",
  quit: "Close or archive the agent in Paseo instead; the Grok session stays.",
  exit: "Close or archive the agent in Paseo instead; the Grok session stays.",
  home: "Close or archive the agent in Paseo instead; the Grok session stays.",
  welcome: "Close or archive the agent in Paseo instead; the Grok session stays.",
  delete: "Archive the agent in Paseo, or delete the session from the Grok terminal.",
  models: "Use /model to list and switch models.",
  login: "Run `grok login` on the computer that runs Paseo.",
  logout: "Run `grok logout` on the computer that runs Paseo.",
  remember: "Grok saves memory notes only from its terminal.",
};

/**
 * Commands named in Grok's installed command reference (`docs/user-guide/*slash*.md` under
 * the Grok home): headings such as ``### `/rename` `` and their listed aliases. Missing or
 * unreadable files yield an empty list.
 */
export function readDocumentedCommands(grokHome?: string): string[] {
  const homes = [grokHome, join(homedir(), ".grok")].filter((home): home is string => !!home);
  const names = new Set<string>();
  for (const home of homes) {
    const directory = join(home, "docs", "user-guide");
    let files: string[];
    try {
      files = readdirSync(directory).filter((file) => /slash/i.test(file) && file.endsWith(".md"));
    } catch {
      continue;
    }
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(join(directory, file), "utf8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        const heading = /^#{2,4}\s/.test(line);
        if (!heading && !/\balias(es)?\b/i.test(line)) continue;
        for (const match of line.matchAll(/`\/([a-z][a-z0-9-]*)[^`]*`/g))
          if (match[1]) names.add(match[1]);
      }
    }
    if (names.size) break;
  }
  return [...names].sort();
}

export type CommandRoute =
  | { kind: "grok"; text: string }
  | { kind: "bridge"; command: BridgeCommand; args: string }
  | { kind: "terminal"; name: string }
  | { kind: "message" };

/**
 * Decide who handles a typed slash command. Grok's own advertised commands always win, so a
 * command Grok starts offering over ACP in a later release runs natively.
 */
export function routeCommand(
  command: SlashCommand,
  advertised: readonly GrokCommand[] | null,
  terminalCommands: ReadonlySet<string>,
): CommandRoute {
  const native = new Set((advertised ?? []).map((entry) => entry.name.toLowerCase()));
  if (native.has(command.name)) return { kind: "grok", text: "" };
  const alias = GROK_ALIASES[command.name];
  if (alias && native.has(alias))
    return { kind: "grok", text: `/${alias}${command.args ? ` ${command.args}` : ""}` };
  const bridge = BRIDGE_COMMANDS.find(
    (entry) => entry.name === command.name || entry.aliases.includes(command.name),
  );
  if (bridge) return { kind: "bridge", command: bridge, args: command.args };
  if (terminalCommands.has(command.name)) return { kind: "terminal", name: command.name };
  return { kind: "message" };
}

export function terminalOnlyText(name: string): string {
  const alternative = ALTERNATIVES[name];
  return [
    `/${name} only works in the Grok terminal, so the bridge did not send it to Grok.`,
    alternative ?? "Run it in a `grok --leader` window on the same session.",
  ].join(" ");
}

export function helpText(
  advertised: readonly GrokCommand[] | null,
  terminal: ReadonlySet<string>,
): string {
  const native = new Set((advertised ?? []).map((entry) => entry.name.toLowerCase()));
  const line = (name: string, hint: string | undefined, description: string) =>
    `- \`/${name}${hint ? ` ${hint}` : ""}\` — ${description}`;
  const sections = [
    "**Grok commands**",
    ...(advertised?.length
      ? advertised.map((entry) => line(entry.name, entry.hint, entry.description))
      : ["- (Grok has not listed its commands for this session yet)"]),
    "",
    "**Bridge commands**",
    ...BRIDGE_COMMANDS.filter((entry) => !native.has(entry.name)).map((entry) =>
      line(entry.name, entry.argumentHint, entry.description),
    ),
  ];
  const aliases = Object.entries(GROK_ALIASES).filter(([, target]) => native.has(target));
  if (aliases.length)
    sections.push(
      "",
      `**Aliases**: ${aliases.map(([alias, target]) => `/${alias} runs /${target}`).join(", ")}`,
    );
  const routed = new Set([...native, ...aliases.map(([alias]) => alias)]);
  const terminalOnly = [...terminal].filter((name) => !routed.has(name)).sort();
  if (terminalOnly.length)
    sections.push(
      "",
      `**Terminal only** (rejected here): ${terminalOnly.map((name) => `/${name}`).join(", ")}`,
    );
  return sections.join("\n");
}

interface SelectOption {
  value: string;
  name: string;
}

function selectOptions(option: Record<string, unknown> | undefined): SelectOption[] {
  const options = option?.["options"];
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    const value = (entry as { value?: unknown }).value;
    const name = (entry as { name?: unknown }).name;
    return typeof value === "string"
      ? [{ value, name: typeof name === "string" ? name : value }]
      : [];
  });
}

export function configOption(
  options: readonly Record<string, unknown>[],
  id: string,
): Record<string, unknown> | undefined {
  return options.find((option) => option["id"] === id);
}

/** The models and efforts the session offers, as a readable list. */
export function modelListText(options: readonly Record<string, unknown>[]): string {
  const model = configOption(options, "model");
  const models = selectOptions(model);
  if (!models.length) return "Grok has not reported this session's models yet.";
  const current = model?.["currentValue"];
  const effort = configOption(options, "reasoning_effort");
  const lines = models.map(
    (entry) =>
      `- \`${entry.value}\`${entry.name !== entry.value ? ` (${entry.name})` : ""}${entry.value === current ? " — current" : ""}`,
  );
  const efforts = selectOptions(effort);
  if (efforts.length)
    lines.push(
      "",
      `Reasoning effort: ${efforts.map((entry) => (entry.value === effort?.["currentValue"] ? `**${entry.value}**` : entry.value)).join(", ")}`,
    );
  return ["**Models**", ...lines, "", "Switch with `/model <model> [effort]`."].join("\n");
}

const normalized = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Resolve `/model` arguments to a model and optional effort, as Grok's terminal does: a model
 * ID or display name (case-insensitive, may contain spaces), optionally followed by an effort.
 */
export function resolveModelArgs(
  options: readonly Record<string, unknown>[],
  args: string,
): { model: string; effort?: string } | { error: string } {
  const models = selectOptions(configOption(options, "model"));
  if (!models.length) return { error: "Grok has not reported this session's models yet." };
  const find = (text: string) => {
    const wanted = normalized(text);
    return models.find(
      (entry) => normalized(entry.value) === wanted || normalized(entry.name) === wanted,
    );
  };
  const whole = find(args);
  if (whole) return { model: whole.value };
  const words = args.trim().split(/\s+/);
  const last = words.pop();
  const withoutLast = find(words.join(" "));
  if (withoutLast && last) return { model: withoutLast.value, effort: last.toLowerCase() };
  return {
    error: `Unknown model "${args}". Available: ${models.map((entry) => entry.value).join(", ")}.`,
  };
}

interface UsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  modelCalls?: number;
  turnCount?: number;
  turnNumber?: number;
  primaryModelId?: string;
}

const count = (value: number | undefined) => (value ?? 0).toLocaleString("en-US");

function usageLine(totals: UsageTotals): string {
  const parts = [
    `${count(totals.inputTokens)} input`,
    `${count(totals.outputTokens)} output`,
    `${count(totals.cachedReadTokens)} cached`,
    `${count(totals.reasoningTokens)} reasoning`,
  ];
  const calls = totals.modelCalls ?? 0;
  return `${count(totals.totalTokens)} tokens (${parts.join(", ")}), ${calls} model call${calls === 1 ? "" : "s"}${totals.primaryModelId ? `, ${totals.primaryModelId}` : ""}`;
}

/** `grok usage <session> [turn]` output as text; other output is shown as it is. */
export function usageText(output: string): string {
  let parsed: { session?: UsageTotals; turns?: UsageTotals[] } | undefined;
  try {
    parsed = JSON.parse(output) as typeof parsed;
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== "object" || (!parsed.session && !Array.isArray(parsed.turns)))
    return output
      ? `\`\`\`\n${output}\n\`\`\``
      : "Grok has recorded no usage for this session yet.";
  const lines: string[] = [];
  if (parsed.session)
    lines.push(
      `**Session:** ${usageLine(parsed.session)} over ${parsed.session.turnCount ?? 0} turn${parsed.session.turnCount === 1 ? "" : "s"}.`,
    );
  const turns = Array.isArray(parsed.turns) ? parsed.turns : [];
  const shown = turns.slice(-10);
  if (shown.length) {
    lines.push("", turns.length > shown.length ? `**Last ${shown.length} turns**` : "**Turns**");
    for (const turn of shown) lines.push(`- Turn ${turn.turnNumber ?? "?"}: ${usageLine(turn)}`);
  }
  return lines.join("\n");
}

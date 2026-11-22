import {
  type BridgeCommand,
  configOption,
  helpText,
  modelListText,
  resolveModelArgs,
} from "./commands.js";
import { errorMessage } from "./errors.js";
import type { GrokStream } from "./stream.js";

/** The outcome of a bridge command: text to show, or a prompt to run in the session. */
export type CommandOutcome =
  | { type: "reply"; text: string; error?: boolean }
  | { type: "prompt"; text: string; notice: string };

const BTW_TIMEOUT_MS = 10 * 60_000;
const RECAP_TIMEOUT_MS = 3 * 60_000;
/** A prompt the bridge starts in a new session keeps its request open while it runs. */
const NEW_SESSION_PROMPT_TIMEOUT_MS = 24 * 3_600_000;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The bridge's own result, which Grok nests as `{ result: ... }` for some extension methods. */
function unwrap(value: unknown): Record<string, unknown> {
  const outer = record(value);
  return "result" in outer ? record(outer["result"]) : outer;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Carries out the bridge's slash commands against one attached Grok session. */
export class CommandRunner {
  constructor(
    private readonly stream: GrokStream,
    private readonly terminalCommands: ReadonlySet<string>,
  ) {}

  private get sessionId(): string {
    const native = this.stream.interceptor.nativeSessionId;
    if (!native) throw new Error("No Grok session is attached");
    return native;
  }

  async run(command: BridgeCommand, args: string): Promise<CommandOutcome> {
    try {
      return await this.dispatch(command, args);
    } catch (error) {
      return {
        type: "reply",
        text: `/${command.name} failed: ${errorMessage(error)}`,
        error: true,
      };
    }
  }

  private async dispatch(command: BridgeCommand, args: string): Promise<CommandOutcome> {
    const reply = (text: string, error = false): CommandOutcome => ({
      type: "reply",
      text,
      ...(error ? { error } : {}),
    });
    switch (command.name) {
      case "help":
        return reply(helpText(this.stream.interceptor.advertisedCommands, this.terminalCommands));
      case "model":
        return reply(await this.model(args));
      case "effort":
        return reply(await this.effort(args));
      case "rename":
        return this.rename(args);
      case "btw":
        return this.btw(args);
      case "recap":
        return reply(await this.recap());
      case "plan":
        return this.plan(args);
      case "fork":
        return reply(await this.fork(args));
      case "new":
        return this.newSession(args);
      default:
        return reply(`/${command.name} is not implemented.`, true);
    }
  }

  private async setOption(configId: string, value: string): Promise<Record<string, unknown>[]> {
    const result = record(
      await this.stream.request("session/set_config_option", {
        sessionId: this.sessionId,
        configId,
        value,
      }),
    );
    const options = result["configOptions"];
    return Array.isArray(options)
      ? options.map(record)
      : [...this.stream.interceptor.configOptions];
  }

  private async model(args: string): Promise<string> {
    const options = this.stream.interceptor.configOptions;
    if (!args) return modelListText(options);
    const resolved = resolveModelArgs(options, args);
    if ("error" in resolved) return resolved.error;
    const updated = await this.setOption("model", resolved.model);
    const lines = [`Model set to \`${resolved.model}\` for this session.`];
    if (resolved.effort) lines.push(await this.applyEffort(updated, resolved.effort));
    else {
      const effort = configOption(updated, "reasoning_effort")?.["currentValue"];
      if (typeof effort === "string") lines.push(`Reasoning effort: ${effort}.`);
    }
    return lines.join(" ");
  }

  private async applyEffort(
    options: readonly Record<string, unknown>[],
    level: string,
  ): Promise<string> {
    const effort = configOption(options, "reasoning_effort");
    const values = Array.isArray(effort?.["options"])
      ? (effort["options"] as { value?: unknown }[]).flatMap((entry) =>
          typeof entry.value === "string" ? [entry.value] : [],
        )
      : [];
    if (!values.length) return "This model has no reasoning effort setting.";
    if (!values.includes(level))
      return `Unknown reasoning effort "${level}". Available: ${values.join(", ")}.`;
    await this.setOption("reasoning_effort", level);
    return `Reasoning effort set to ${level}.`;
  }

  private async effort(args: string): Promise<string> {
    const options = this.stream.interceptor.configOptions;
    if (!args) {
      const effort = configOption(options, "reasoning_effort");
      if (!effort) return "This model has no reasoning effort setting.";
      return `Reasoning effort: ${String(effort["currentValue"])}. Set it with \`/effort <level>\`.`;
    }
    return this.applyEffort(options, args.trim().toLowerCase());
  }

  private async rename(args: string): Promise<CommandOutcome> {
    const title = args.replace(/\s+/g, " ").trim();
    if (!title) return { type: "reply", text: "Usage: `/rename <title>`.", error: true };
    if (title === "--auto")
      return {
        type: "reply",
        text: "Grok resumes automatic titles only from its terminal (`/rename --auto`).",
        error: true,
      };
    await this.stream.request("_x.ai/session/rename", { sessionId: this.sessionId, title });
    return { type: "reply", text: `Renamed the session to "${title}".` };
  }

  private async btw(args: string): Promise<CommandOutcome> {
    if (!args) return { type: "reply", text: "Usage: `/btw <question>`.", error: true };
    const result = unwrap(
      await this.stream.request(
        "_x.ai/btw",
        { sessionId: this.sessionId, question: args },
        BTW_TIMEOUT_MS,
      ),
    );
    const answer = typeof result["answer"] === "string" ? result["answer"].trim() : "";
    return {
      type: "reply",
      text: `${quote(`btw: ${args}`)}\n\n${answer || "(Grok gave no answer)"}\n\n_Side answer: not added to the conversation._`,
    };
  }

  private recap(): Promise<string> {
    const sessionId = this.sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        stop();
        reject(new Error(`no recap within ${RECAP_TIMEOUT_MS / 1000} s`));
      }, RECAP_TIMEOUT_MS);
      timer.unref?.();
      const stop = this.stream.onNotification((message) => {
        const params = record(message["params"]);
        if (params["sessionId"] !== sessionId) return;
        const update = record(params["update"]);
        if (update["sessionUpdate"] !== "session_recap" || update["auto"] === true) return;
        clearTimeout(timer);
        stop();
        const summary = typeof update["summary"] === "string" ? update["summary"].trim() : "";
        resolve(summary ? `**Recap:** ${summary}` : "Grok had nothing to recap.");
      });
      this.stream.request("_x.ai/recap", { sessionId }).catch((error: unknown) => {
        clearTimeout(timer);
        stop();
        reject(error);
      });
    });
  }

  private async plan(args: string): Promise<CommandOutcome> {
    const off = isPlanOff(args);
    await this.stream.request("session/set_mode", {
      sessionId: this.sessionId,
      modeId: off ? "default" : "plan",
    });
    if (off) return { type: "reply", text: "Left plan mode." };
    if (!args)
      return {
        type: "reply",
        text: "Plan mode is on: Grok plans before it changes anything. Send the task next, or `/plan off` to leave.",
      };
    return { type: "prompt", text: args, notice: "Plan mode is on" };
  }

  private async fork(args: string): Promise<string> {
    const cwd = this.stream.interceptor.cwd;
    if (!cwd) throw new Error("the session's folder is unknown");
    const result = unwrap(
      await this.stream.request("_x.ai/session/fork", {
        sourceSessionId: this.sessionId,
        sourceCwd: cwd,
        newCwd: cwd,
      }),
    );
    const forked = typeof result["newSessionId"] === "string" ? result["newSessionId"] : null;
    if (!forked) throw new Error("Grok returned no session");
    const base = this.stream.interceptor.title;
    const title = args.replace(/\s+/g, " ").trim() || (base ? `${base} (fork)` : "");
    if (title) await this.stream.request("_x.ai/session/rename", { sessionId: forked, title });
    return `Forked this session${title ? ` as "${title}"` : ""}. Paseo lists the fork as a new agent within a few seconds.`;
  }

  private async newSession(args: string): Promise<CommandOutcome> {
    if (!args)
      return {
        type: "reply",
        text: "Usage: `/new <first prompt>`. Grok lists a new session only once it has a message; Paseo's new-agent button starts an empty one.",
        error: true,
      };
    const cwd = this.stream.interceptor.cwd;
    if (!cwd) throw new Error("the session's folder is unknown");
    const created = record(await this.stream.request("session/new", { cwd, mcpServers: [] }));
    const sessionId = typeof created["sessionId"] === "string" ? created["sessionId"] : null;
    if (!sessionId) throw new Error("Grok returned no session");
    this.stream.hideSession(sessionId);
    this.stream
      .request(
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: args }] },
        NEW_SESSION_PROMPT_TIMEOUT_MS,
      )
      .catch(() => undefined);
    return {
      type: "reply",
      text: "Started a new Grok session with your prompt. Paseo lists it as a new agent within a few seconds; this agent stays on the current session.",
    };
  }
}

/** Whether `/plan` arguments ask to leave plan mode rather than name a task. */
export function isPlanOff(args: string): boolean {
  return /^(off|exit|stop)$/i.test(args.trim());
}

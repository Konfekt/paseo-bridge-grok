import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface Notification {
  method: string;
  params: Record<string, unknown>;
}

/** A minimal ACP client, standing in for a terminal attached to Grok's leader. */
export class AcpClient {
  readonly notifications: Notification[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 0;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) {
    this.child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => undefined);
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = message["id"];
      if (typeof id === "number" && !message["method"] && this.pending.has(id)) {
        this.pending.get(id)?.(message);
        this.pending.delete(id);
      } else if (typeof message["method"] === "string" && id === undefined) {
        this.notifications.push(message as unknown as Notification);
      } else if (message["method"] === "session/request_permission") {
        const options = (message["params"] as { options: Array<{ optionId: string }> }).options;
        this.child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId: options[0]?.optionId } } })}\n`,
        );
      }
    });
  }

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const response = new Promise<Record<string, unknown>>((resolve) =>
      this.pending.set(id, resolve),
    );
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const message = await response;
    if (message["error"]) throw new Error(`${method}: ${JSON.stringify(message["error"])}`);
    return message["result"] as Record<string, unknown>;
  }

  initialize() {
    return this.call("initialize", { protocolVersion: 1, clientCapabilities: {} });
  }

  /** Text the session streamed to this client since `from`. */
  streamed(from = 0): string {
    return this.notifications
      .slice(from)
      .filter((notification) => notification.method === "session/update")
      .map((notification) => JSON.stringify(notification.params))
      .join("\n");
  }

  close(): void {
    this.child.kill("SIGTERM");
  }
}

import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GrokStreamInterceptor, JsonRpcMessage } from "./interceptor.js";

/** How often the attached session's log is checked for entries Paseo did not receive. */
export const LOG_POLL_MS = 1_000;
/** How long a logged entry may wait for its live counterpart before it counts as missed. */
export const LOG_GRACE_MS = 2_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;

/** The Grok home a launch uses: `GROK_HOME`, else `~/.grok` of its `HOME`. */
export function grokHome(env: Record<string, string | undefined>): string {
  return env["GROK_HOME"] || join(env["HOME"] || homedir(), ".grok");
}

/** Where Grok Build keeps a session's update log. */
export function sessionLogPath(home: string, cwd: string, sessionId: string): string {
  return join(home, "sessions", encodeURIComponent(cwd), sessionId, "updates.jsonl");
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Follows the attached session's update log, which every Grok process writing the session
 * appends to. Grok's leader streams only its own clients' turns; a terminal started without
 * `--leader` writes the same session from a separate process, and its turns reach Paseo only
 * through this log. Entries Paseo already received live are recognised by their event IDs
 * and skipped; the rest are delivered through the interceptor once their grace period ends.
 */
export class SessionLogFollower {
  private attachment = -1;
  private path: string | null = null;
  private offset = 0;
  private remainder = "";
  private pending: { message: JsonRpcMessage; at: number }[] = [];
  private busy = false;
  private readonly timer: NodeJS.Timeout;
  private start: Promise<void> = Promise.resolve();

  constructor(
    private readonly home: string,
    private readonly interceptor: GrokStreamInterceptor,
    private readonly deliver: (message: JsonRpcMessage) => void,
    private readonly options: { pollMs?: number; graceMs?: number; now?: () => number } = {},
  ) {
    this.timer = setInterval(() => void this.poll(), options.pollMs ?? LOG_POLL_MS);
    this.timer.unref();
  }

  /** Call after each message: on a new attachment, the log's current end becomes the start. */
  sync(): void {
    const attachment = this.interceptor.attachment;
    if (attachment === this.attachment) return;
    this.attachment = attachment;
    const native = this.interceptor.nativeSessionId;
    const cwd = this.interceptor.cwd;
    this.path = native && cwd ? sessionLogPath(this.home, cwd, native) : null;
    this.remainder = "";
    this.pending = [];
    this.offset = Number.POSITIVE_INFINITY;
    const path = this.path;
    this.start = path
      ? fileSize(path).then((size) => {
          if (this.path === path) this.offset = size;
        })
      : Promise.resolve();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Read new log entries and deliver those that are past their grace period. */
  async poll(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.sync();
      await this.start;
      const path = this.path;
      if (path && Number.isFinite(this.offset)) await this.read(path);
      this.flush();
    } finally {
      this.busy = false;
    }
  }

  private async read(path: string): Promise<void> {
    const size = await fileSize(path);
    if (size < this.offset) {
      // Rewritten (for example compacted): continue from its new end.
      this.offset = size;
      this.remainder = "";
      return;
    }
    if (size === this.offset) return;
    const length = Math.min(size - this.offset, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    const handle = await open(path, "r").catch(() => null);
    if (!handle) return;
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
      if (this.path !== path) return;
      this.offset += bytesRead;
      const lines = (this.remainder + buffer.subarray(0, bytesRead).toString("utf8")).split("\n");
      this.remainder = lines.pop() ?? "";
      const at = (this.options.now ?? Date.now)();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as { method?: unknown; params?: unknown };
          if (typeof entry.method === "string" && entry.params && typeof entry.params === "object")
            this.pending.push({
              message: { jsonrpc: "2.0", method: entry.method, params: entry.params },
              at,
            });
        } catch {
          // A torn or foreign line is skipped; the next entries still follow.
        }
      }
    } finally {
      await handle.close();
    }
  }

  private flush(): void {
    if (this.interceptor.replaying) return;
    const due = (this.options.now ?? Date.now)() - (this.options.graceMs ?? LOG_GRACE_MS);
    let delivered = false;
    for (let entry = this.pending[0]; entry && entry.at <= due; entry = this.pending[0]) {
      // One followed turn per poll: Paseo receives turn starts directly but replies through
      // the ACP stream, so the next turn waits until the previous replies have arrived.
      if (delivered && this.interceptor.startsLoggedTurn(entry.message)) break;
      this.pending.shift();
      for (const message of this.interceptor.followed(entry.message)) {
        this.deliver(message);
        delivered = true;
      }
    }
  }
}

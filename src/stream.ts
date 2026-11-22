import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import {
  GrokStreamInterceptor,
  type InterceptorHooks,
  type JsonRpcMessage,
} from "./interceptor.js";
import type { GrokLaunch } from "./launch.js";

const STDERR_TAIL_BYTES = 4_096;
const TERMINATE_GRACE_MS = 2_000;

export interface GrokStream extends AcpStream {
  interceptor: GrokStreamInterceptor;
  /** Send a request of the bridge's own to Grok; its answer does not reach Paseo. */
  request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Observe every notification from Grok, including those Paseo does not receive. */
  onNotification(listener: (message: JsonRpcMessage) => void): () => void;
  /** Keep a session's notifications from Paseo, for sessions the bridge drives itself. */
  hideSession(sessionId: string): void;
}

/** Prefix of request IDs the bridge sends on its own behalf. */
export const BRIDGE_REQUEST_PREFIX = "paseo-bridge-grok:";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class GrokRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "GrokRequestError";
  }
}

function errorText(error: unknown): string {
  const record = (error ?? {}) as { message?: unknown; data?: unknown };
  const message = typeof record.message === "string" ? record.message : "Grok Build request failed";
  return typeof record.data === "string" && record.data ? `${message}: ${record.data}` : message;
}

/**
 * Start `grok agent --leader stdio` and expose it as an ACP message stream whose traffic
 * passes through a {@link GrokStreamInterceptor}. Ending either side ends the process;
 * Grok's leader keeps the session for the terminal.
 */
export async function spawnGrokStream(
  launch: GrokLaunch,
  hooks: InterceptorHooks,
  onExit: () => void = () => undefined,
): Promise<GrokStream> {
  const child = spawn(launch.command, launch.args, {
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new Error(`Grok Build executable not found: ${launch.command}`, { cause: error })
          : error,
      );
    });
  });
  // A write after Grok exits fails with EPIPE; the close handler reports the exit instead.
  child.stdin.on("error", () => undefined);
  const interceptor = new GrokStreamInterceptor(hooks);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  let ending = false;
  const terminate = () => {
    if (ending) return;
    ending = true;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, TERMINATE_GRACE_MS);
    timer.unref();
  };
  let readable!: ReadableStreamDefaultController<AcpStreamMessage>;
  let readableOpen = true;
  const deliver = (message: JsonRpcMessage) => {
    if (readableOpen) readable.enqueue(message as AcpStreamMessage);
  };
  const pendingRequests = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  const listeners = new Set<(message: JsonRpcMessage) => void>();
  const hidden = new Set<string>();
  let requestCounter = 0;
  const failPending = (error: Error) => {
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pendingRequests.delete(id);
    }
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      hooks.warn?.(`Ignoring non-JSON output from Grok Build: ${line.slice(0, 200)}`);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const rpc = message as JsonRpcMessage;
    const id = rpc["id"];
    if (typeof id === "string" && id.startsWith(BRIDGE_REQUEST_PREFIX) && !("method" in rpc)) {
      const pending = pendingRequests.get(id);
      if (!pending) return;
      pendingRequests.delete(id);
      clearTimeout(pending.timer);
      if (rpc["error"]) {
        const error = rpc["error"] as { code?: number; data?: unknown };
        pending.reject(new GrokRequestError(errorText(rpc["error"]), error.code, error.data));
      } else pending.resolve(rpc["result"]);
      return;
    }
    if (typeof rpc["method"] === "string" && !("id" in rpc)) {
      for (const listener of listeners) listener(rpc);
      const params = rpc["params"] as { sessionId?: unknown } | undefined;
      if (typeof params?.sessionId === "string" && hidden.has(params.sessionId)) return;
    }
    for (const rewritten of interceptor.inbound(message as JsonRpcMessage)) deliver(rewritten);
  });
  child.once("close", (code, signal) => {
    onExit();
    failPending(new Error(`Grok Build exited (${signal ?? code ?? "unknown"})`));
    if (!readableOpen) return;
    readableOpen = false;
    if (ending || code === 0) readable.close();
    else
      readable.error(
        new Error(
          `Grok Build exited (${signal ?? code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
        ),
      );
  });
  return {
    interceptor,
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (ending || !child.stdin.writable)
        return Promise.reject(new Error("Grok Build stdin is closed"));
      const id = `${BRIDGE_REQUEST_PREFIX}${++requestCounter}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Grok Build did not answer ${method} within ${timeoutMs / 1000} s`));
        }, timeoutMs);
        timer.unref?.();
        pendingRequests.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    hideSession(sessionId) {
      hidden.add(sessionId);
    },
    readable: new ReadableStream<AcpStreamMessage>({
      start(controller) {
        readable = controller;
      },
      cancel() {
        readableOpen = false;
        terminate();
      },
    }),
    writable: new WritableStream<AcpStreamMessage>({
      write(message) {
        const { forward, replies } = interceptor.outbound(message as JsonRpcMessage);
        if (forward) {
          if (ending || !child.stdin.writable) throw new Error("Grok Build stdin is closed");
          child.stdin.write(`${JSON.stringify(forward)}\n`);
        }
        if (replies.length) queueMicrotask(() => replies.forEach(deliver));
      },
      close: terminate,
      abort: terminate,
    }),
  };
}

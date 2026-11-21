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
    for (const rewritten of interceptor.inbound(message as JsonRpcMessage)) deliver(rewritten);
  });
  child.once("close", (code, signal) => {
    onExit();
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

import { once } from "node:events";
import { createServer, type Server } from "node:http";

/**
 * A local OpenAI Chat Completions endpoint for Grok Build's custom models, so the real
 * `grok` binary runs complete turns without an xAI account. It answers
 * `reply to: <last user text>`; a prompt containing `slow` answers after a delay.
 */
export async function startModelServer(options: { slowMs?: number } = {}): Promise<{
  url: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", async () => {
      if (request.url?.endsWith("/models")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(body) as Record<string, unknown>;
      } catch {
        // An unparseable request still gets an answer, so Grok reports the turn normally.
      }
      requests.push(parsed);
      const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : [];
      const last = [...messages]
        .reverse()
        .find((message) => (message as { role?: string }).role === "user") as
        | { content?: unknown }
        | undefined;
      const content =
        typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
      const userText = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(content)?.[1] ?? content;
      if (/\bslow\b/.test(userText) && options.slowMs)
        await new Promise((resolve) => setTimeout(resolve, options.slowMs));
      const reply = `reply to: ${userText.trim().slice(-200)}`;
      const base = {
        id: "chat",
        object: "chat.completion.chunk",
        created: 1,
        model: parsed["model"],
      };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      if (parsed["stream"]) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No model server address");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Grok configuration with two local models and no xAI credentials. */
export function grokConfig(modelUrl: string): string {
  return `[models]
default = "local-a"

[model.local-a]
model = "local-model-a"
base_url = "${modelUrl}"
name = "Local A"
api_key = "local"
context_window = 128000

[model.local-b]
model = "local-model-b"
base_url = "${modelUrl}"
name = "Local B"
api_key = "local"
context_window = 128000

[cli]
auto_update = false
`;
}

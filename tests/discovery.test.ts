import { expect, test } from "vitest";
import {
  type AttachedAgent,
  attachedTo,
  type DiscoverableSession,
  type DiscoveryClient,
  discoverOnce,
  lookbackHours,
  watchDiscovery,
} from "../src/discovery.js";
import { ArchivedWorkspaceError } from "../src/session-workspace.js";

const handle = (sessionId: string) =>
  `plugin:${JSON.stringify({ version: 1, data: { sessionId } })}`;
const session = (id: string): DiscoverableSession => ({
  providerId: "grok-terminal",
  providerHandleId: handle(id),
  cwd: "/p",
});

function fakeClient(sessions: DiscoverableSession[], agents: AttachedAgent[] = []) {
  const loads: string[] = [];
  const imports: string[] = [];
  let failImport: ((session: DiscoverableSession) => Error | undefined) | undefined;
  const client: DiscoveryClient = {
    warmProvider: async () => undefined,
    sessions: async () => sessions,
    agents: async () => [...agents],
    load: async (id) => {
      loads.push(id);
    },
    importSession: async (entry) => {
      const error = failImport?.(entry);
      if (error) throw error;
      imports.push(entry.providerHandleId);
      const agent = {
        id: `agent-${imports.length}`,
        provider: "grok-terminal",
        persistence: { sessionId: entry.providerHandleId },
      };
      agents.push(agent);
      return agent;
    },
  };
  return {
    client,
    loads,
    imports,
    setFailImport: (fn: typeof failImport) => {
      failImport = fn;
    },
  };
}

test("matches agents to sessions by plugin handle or native ID", () => {
  const agent = { id: "a", provider: "grok-terminal", persistence: { sessionId: "s1" } };
  expect(attachedTo(agent, session("s1"))).toBe(true);
  expect(attachedTo(agent, session("s2"))).toBe(false);
  expect(attachedTo({ ...agent, provider: "codex" }, session("s1"))).toBe(false);
});

test("imports new sessions and reloads attached agents", async () => {
  const attached = {
    id: "old",
    provider: "grok-terminal",
    persistence: { sessionId: handle("s1") },
  };
  const archived = { ...attached, id: "gone", archivedAt: "x" };
  const fake = fakeClient([session("s1"), session("s2")], [attached, archived]);
  const result = await discoverOnce(fake.client, { since: "" });
  expect(result.imported).toEqual(["agent-1"]);
  expect(fake.imports).toEqual([handle("s2")]);
  expect(fake.loads).toEqual(["old"]);
});

test("skips sessions whose workspace was archived", async () => {
  const fake = fakeClient([session("s1")]);
  fake.setFailImport(() => new ArchivedWorkspaceError("wks_1"));
  const state = { skipped: new Set<string>() };
  await discoverOnce(fake.client, { since: "", state });
  fake.setFailImport(undefined);
  await discoverOnce(fake.client, { since: "", state });
  expect(fake.imports).toEqual([]);
});

test("reports failed imports after trying every session", async () => {
  const fake = fakeClient([session("bad"), session("good")]);
  fake.setFailImport((entry) =>
    entry.providerHandleId === handle("bad") ? new Error("nope") : undefined,
  );
  await expect(discoverOnce(fake.client, { since: "" })).rejects.toThrow("nope");
  expect(fake.imports).toEqual([handle("good")]);
});

test("lookback hours come from the environment", () => {
  expect(lookbackHours({})).toBe(24);
  expect(lookbackHours({ PASEO_BRIDGE_GROK_LOOKBACK_HOURS: "2" })).toBe(2);
  expect(() => lookbackHours({ PASEO_BRIDGE_GROK_LOOKBACK_HOURS: "-1" })).toThrow();
});

test("the watcher keeps polling after errors and stops on abort", async () => {
  const controller = new AbortController();
  const errors: unknown[] = [];
  let passes = 0;
  const fake = fakeClient([]);
  await watchDiscovery(
    async () => {
      passes++;
      if (passes === 1) throw new Error("daemon down");
      if (passes === 3) controller.abort();
      return { discovery: fake.client, close: async () => undefined };
    },
    controller.signal,
    (error) => errors.push(error),
    { pollIntervalMs: 1 },
  );
  expect(passes).toBe(3);
  expect(errors).toHaveLength(1);
});

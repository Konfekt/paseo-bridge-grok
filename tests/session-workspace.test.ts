import { expect, test } from "vitest";
import {
  ArchivedWorkspaceError,
  importIntoSessionWorkspace,
  sessionWorkspaceId,
  sessionWorkspaceTitle,
} from "../src/session-workspace.js";

const session = { providerId: "grok-terminal", providerHandleId: "h1", cwd: "/p", title: "T" };

test("workspace IDs are stable and in Paseo's format", () => {
  expect(sessionWorkspaceId("h1")).toBe(sessionWorkspaceId("h1"));
  expect(sessionWorkspaceId("h1")).not.toBe(sessionWorkspaceId("h2"));
  expect(sessionWorkspaceId("h1")).toMatch(/^wks_[0-9a-f]{16}$/);
});

test("titles are one line and capped", () => {
  expect(sessionWorkspaceTitle({ title: " a\n b " })).toBe("a b");
  expect(sessionWorkspaceTitle({ firstPromptPreview: "x".repeat(100) })).toHaveLength(80);
  expect(sessionWorkspaceTitle({})).toBeUndefined();
});

test("imports into the session's own workspace, reusing an existing one", async () => {
  const calls: unknown[] = [];
  const host = {
    createWorkspace: async (input: unknown) => {
      calls.push(input);
      return { error: "exists", errorCode: "workspace_id_conflict" };
    },
    importAgent: async (input: { workspaceId: string; labels: Record<string, string> }) => input,
  };
  const agent = await importIntoSessionWorkspace(host, session);
  expect(agent.workspaceId).toBe(sessionWorkspaceId("h1"));
  expect(agent.labels).toEqual({
    "bridge.owner": "paseo-bridge-grok",
    "bridge.workspace": agent.workspaceId,
  });
  expect(calls).toEqual([
    { source: { kind: "directory", path: "/p" }, workspaceId: agent.workspaceId, title: "T" },
  ]);
});

test("a failed workspace creation fails without importing", async () => {
  let imported = false;
  const host = {
    createWorkspace: async () => ({ error: "disk full" }),
    importAgent: async () => {
      imported = true;
    },
  };
  await expect(importIntoSessionWorkspace(host, session)).rejects.toThrow("disk full");
  expect(imported).toBe(false);
});

test("an archived workspace is reported as such", async () => {
  const workspaceId = sessionWorkspaceId("h1");
  const host = {
    createWorkspace: async () => ({}),
    importAgent: async () => {
      throw new Error(`Workspace not found: ${workspaceId}`);
    },
  };
  await expect(importIntoSessionWorkspace(host, session)).rejects.toBeInstanceOf(
    ArchivedWorkspaceError,
  );
});

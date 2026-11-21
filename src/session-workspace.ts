import { createHash } from "node:crypto";
import { PLUGIN_ID } from "./ids.js";

export interface PlacedSession {
  providerId: string;
  providerHandleId: string;
  cwd: string;
  title?: string | null | undefined;
  firstPromptPreview?: string | null | undefined;
}

export interface WorkspaceHost<Agent> {
  importAgent(input: {
    providerId: string;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels: Record<string, string>;
  }): Promise<Agent>;
  createWorkspace(input: {
    source: { kind: "directory"; path: string };
    workspaceId: string;
    title?: string;
  }): Promise<unknown>;
}

/** Labels every imported agent carries, so it can be recognised as bridge-owned. */
export const OWNER_LABELS: Readonly<Record<string, string>> = { "bridge.owner": PLUGIN_ID };
/** Label naming the workspace the bridge created for the agent's session. */
export const WORKSPACE_LABEL = "bridge.workspace";

const MAX_TITLE_LENGTH = 80;

/** Stable per-session workspace ID in Paseo's `wks_<16 hex>` format, so retries and
 * restarts address the same workspace instead of creating another. */
export function sessionWorkspaceId(providerHandleId: string): string {
  const digest = createHash("sha256").update(`${PLUGIN_ID}\0${providerHandleId}`).digest("hex");
  return `wks_${digest.slice(0, 16)}`;
}

/** One-line title of at most 80 characters, or undefined when there is no text. */
export function sessionWorkspaceTitle(session: {
  title?: string | null | undefined;
  firstPromptPreview?: string | null | undefined;
}): string | undefined {
  const text = (session.title || session.firstPromptPreview || "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_TITLE_LENGTH ? `${text.slice(0, MAX_TITLE_LENGTH - 1)}…` : text;
}

/** Paseo answers a repeated create of the same workspace ID with this code. */
const WORKSPACE_EXISTS = "workspace_id_conflict";

/** The session's own workspace was archived; the session is not imported again. */
export class ArchivedWorkspaceError extends Error {
  constructor(readonly workspaceId: string) {
    super(`Workspace ${workspaceId} was archived; not importing its session again`);
    this.name = "ArchivedWorkspaceError";
  }
}

/**
 * Paseo lists workspaces, not agents, so each terminal session gets its own workspace in
 * the session's directory. The import is always aimed at that workspace: an import without
 * one makes Paseo create a folder workspace and delete it again when the import fails, which
 * shows up in the app as a workspace that appears and vanishes. A failed creation fails the
 * pass instead, and the next pass retries.
 */
export async function importIntoSessionWorkspace<Agent>(
  host: WorkspaceHost<Agent>,
  session: PlacedSession,
): Promise<Agent> {
  const workspaceId = sessionWorkspaceId(session.providerHandleId);
  const title = sessionWorkspaceTitle(session);
  const created = (await host.createWorkspace({
    source: { kind: "directory", path: session.cwd },
    workspaceId,
    ...(title ? { title } : {}),
  })) as { error?: string | null; errorCode?: string } | undefined;
  const error = created?.error;
  if (error && error !== WORKSPACE_EXISTS && created?.errorCode !== WORKSPACE_EXISTS)
    throw new Error(`Could not create workspace ${workspaceId}: ${error}`);
  try {
    return await host.importAgent({
      providerId: session.providerId,
      providerHandleId: session.providerHandleId,
      cwd: session.cwd,
      workspaceId,
      labels: { ...OWNER_LABELS, [WORKSPACE_LABEL]: workspaceId },
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message.includes(`Workspace not found: ${workspaceId}`))
      throw new ArchivedWorkspaceError(workspaceId);
    throw cause;
  }
}

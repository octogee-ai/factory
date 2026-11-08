import { projectAgentMmUsername } from "@octogee/shared/types/identity";
import type { SecretsRepository } from "../platform-state/secrets.js";

export const PROJECT_AGENT_PAT_DESCRIPTION = "Octogee project agent (OpenClaw)";

export function projectAgentSecretDocId(project: string): string {
  return `projectAgentMattermost-${project}`;
}

export interface ProjectAgentDeps {
  mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
  secrets: Pick<SecretsRepository, "put" | "delete">;
  log: (msg: string) => void;
}

export interface CreateProjectAgentBotInput {
  uid: string;
  username: string;
  project: string;
  teamId: string;
  displayName: string;
  projectChannelIds: readonly string[];
}

interface MmToken {
  id?: string;
  description?: string;
}

async function createOrAdoptBotUser(
  deps: ProjectAgentDeps,
  botUsername: string,
  displayName: string,
  description: string,
): Promise<string> {
  let createError: unknown;
  try {
    const created = (await deps.mmApiCall("POST", "/bots", {
      username: botUsername,
      display_name: displayName,
      description,
    })) as { user_id?: unknown };
    if (typeof created?.user_id === "string" && created.user_id) return created.user_id;
  } catch (err) {
    createError = err;
  }

  const existing = (await deps.mmApiCall("GET", `/users/username/${botUsername}`)) as {
    id?: unknown;
    is_bot?: unknown;
    delete_at?: unknown;
  } | null;
  if (typeof existing?.id === "string" && existing.id) {
    // MM usernames are server-global and MM does not enforce our reserved-
    // segment rules — a builder could rename their own account to squat this
    // username. Adopting a human account would hand it the project PAT.
    if (existing.is_bot !== true) {
      throw new Error(
        `[project-agent] username ${botUsername} is taken by a user that is not a bot - refusing to adopt`,
      );
    }
    if (typeof existing.delete_at === "number" && existing.delete_at > 0) {
      await deps.mmApiCall("PUT", `/users/${existing.id}/active`, { active: true });
      deps.log(`[project-agent] reactivated retired bot ${botUsername} (${existing.id})`);
    }
    deps.log(`[project-agent] bot ${botUsername} already exists, adopting (${existing.id})`);
    return existing.id;
  }

  throw new Error(
    `[project-agent] cannot create or adopt bot ${botUsername}: ${
      createError instanceof Error ? createError.message : String(createError ?? "no user_id returned")
    }`,
  );
}

async function revokeTokens(
  deps: ProjectAgentDeps,
  mmUserId: string,
  matches: (token: MmToken) => boolean,
): Promise<void> {
  let existing: unknown;
  try {
    existing = await deps.mmApiCall("GET", `/users/${mmUserId}/tokens`);
  } catch (err) {
    deps.log(
      `[project-agent] token listing failed for ${mmUserId} — continuing: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }
  if (!Array.isArray(existing)) return;
  for (const token of existing as MmToken[]) {
    if (typeof token?.id !== "string" || !matches(token)) continue;
    await deps.mmApiCall("POST", "/users/tokens/revoke", { token_id: token.id });
  }
}

async function addProjectAgentMember(
  deps: ProjectAgentDeps,
  kind: "teams" | "channels",
  id: string,
  mmUserId: string,
): Promise<void> {
  const endpoint = `/${kind}/${id}/members`;
  try {
    await deps.mmApiCall("POST", endpoint, {
      ...(kind === "teams" ? { team_id: id } : {}),
      user_id: mmUserId,
    });
  } catch (error) {
    if (!(error instanceof Error) || (error as Error & { status?: number }).status !== 409) throw error;
    const errorId = error.message.match(/"id"\s*:\s*"([^"]+)"/u)?.[1]
      ?? error.message.replace(/^MM API 409:\s*/u, "");
    const alreadyMemberIds = kind === "teams"
      ? ["store.sql_team.save_member.exists.app_error"]
      : ["store.sql_channel.save_member.exists.app_error", "user_already_in_channel"];
    if (!alreadyMemberIds.includes(errorId)) throw error;
    deps.log(`[project-agent] ${mmUserId} already belongs to ${kind}/${id}`);
  }
}

export async function createProjectAgentBot(
  deps: ProjectAgentDeps,
  input: CreateProjectAgentBotInput,
): Promise<{ mmUserId: string; token: string }> {
  const botUsername = projectAgentMmUsername(input.username, input.project);
  const mmUserId = await createOrAdoptBotUser(
    deps,
    botUsername,
    input.displayName,
    `Octogee project agent for ${input.username}/${input.project}`,
  );

  await addProjectAgentMember(deps, "teams", input.teamId, mmUserId);
  for (const channelId of input.projectChannelIds) {
    await addProjectAgentMember(deps, "channels", channelId, mmUserId);
  }

  await revokeTokens(deps, mmUserId, (t) => t.description === PROJECT_AGENT_PAT_DESCRIPTION);
  const minted = (await deps.mmApiCall("POST", `/users/${mmUserId}/tokens`, {
    description: PROJECT_AGENT_PAT_DESCRIPTION,
  })) as { token?: unknown };
  if (typeof minted?.token !== "string" || !minted.token) {
    throw new Error(`[project-agent] PAT mint returned no token for ${botUsername}`);
  }

  await deps.secrets.put(input.uid, {
    kind: "project-agent-mattermost",
    secretId: projectAgentSecretDocId(input.project),
    projectId: input.project,
    personalToken: minted.token,
    mattermostUserId: mmUserId,
    createdAt: { serverNow: true },
    rotatedAt: null,
  });
  deps.log(`[project-agent] provisioned ${botUsername} (${mmUserId}) with fresh PAT`);

  return { mmUserId, token: minted.token };
}

export interface RetireProjectAgentBotInput {
  uid: string;
  project: string;
  mmUserId: string;
}

export async function retireProjectAgentBot(
  deps: ProjectAgentDeps,
  input: RetireProjectAgentBotInput,
): Promise<void> {
  await revokeTokens(deps, input.mmUserId, () => true);
  try {
    await deps.mmApiCall("DELETE", `/users/${input.mmUserId}`);
  } catch (err) {
    // Already gone (hard-deleted, or a prior retire won the race) — the
    // level-triggered reconcile must not wedge on it; secret cleanup proceeds.
    if ((err as { status?: number }).status !== 404) throw err;
    deps.log(`[project-agent] bot ${input.mmUserId} already gone (404) - continuing retire`);
  }
  await deps.secrets.delete(input.uid, projectAgentSecretDocId(input.project));
  deps.log(`[project-agent] retired bot ${input.mmUserId} for project ${input.project}`);
}

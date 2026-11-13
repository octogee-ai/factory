import * as crypto from "node:crypto";

import { log as coreLog } from "../config.js";
import { assertMattermostConfigured, isIdempotentMmError } from "../mattermost/client.js";
import type {
  ChannelCommandEnsureResult,
  ChannelCommandSpec,
  ChannelEraseSpec,
  ChannelHostEntity,
  ChannelMembershipTarget,
  ChannelSpec,
  ChannelUserSpec,
  ManagedChannelHost,
} from "./types.js";

export interface MattermostChannelHostConfig {
  baseUrl: string;
  adminToken: string;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}

export interface MattermostChannelHost extends ManagedChannelHost {
  readonly provider: "mattermost";
}

const UNDELETABLE_DEFAULT_CHANNEL = "api.channel.delete_channel.cannot.app_error";

interface MmEntity extends ChannelHostEntity {
  delete_at?: number;
  name?: string;
}

interface MmToken {
  id?: unknown;
  description?: unknown;
}

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pass = "";
  for (let i = 0; i < 24; i++) pass += chars[crypto.randomInt(chars.length)];
  return pass;
}

function isArchivedChannel(candidate: unknown, name: string): candidate is MmEntity {
  if (typeof candidate !== "object" || candidate === null) return false;
  const channel = candidate as Partial<MmEntity>;
  return channel.name === name && typeof channel.id === "string" && (channel.delete_at ?? 0) > 0;
}

function channelIdsForTeamDeletion(value: unknown, teamId: string): string[] {
  if (!Array.isArray(value)) throw new Error("mm getUserChannels returned an invalid channel list");
  return value.flatMap((channel: unknown) => {
    if (channel === null || typeof channel !== "object") {
      throw new Error("mm getUserChannels returned an invalid channel");
    }
    const row = channel as Record<string, unknown>;
    if (typeof row.id !== "string" || row.id.length === 0 ||
        typeof row.type !== "string" || !["O", "P", "D", "G"].includes(row.type)) {
      throw new Error("mm getUserChannels returned an invalid channel");
    }
    if (row.type === "D" || row.type === "G") return [];
    if (row.team_id !== teamId) {
      throw new Error("mm getUserChannels returned an invalid channel team");
    }
    return [row.id];
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function membersPath(target: ChannelMembershipTarget): string {
  return "teamId" in target
    ? `/teams/${target.teamId}/members`
    : `/channels/${target.channelId}/members`;
}

interface MmAdmin {
  log(message: string): void;
  call<T = MmEntity>(method: string, endpoint: string, body?: unknown): Promise<T | null>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

function createMmAdmin(config: MattermostChannelHostConfig): MmAdmin {
  const log = config.log ?? (() => undefined);
  const fetchImpl: typeof fetch = (input, init) => (config.fetch ?? fetch)(input, init);
  const authHeader = { Authorization: `Bearer ${config.adminToken}` };

  return {
    log,
    fetch: (path, init = {}) =>
      fetchImpl(`${config.baseUrl}/api/v4${path}`, {
        ...init,
        headers: { ...authHeader, ...(init.headers as Record<string, string> | undefined) },
      }),
    async call<T = MmEntity>(method: string, endpoint: string, body?: unknown): Promise<T | null> {
      const resp = await fetchImpl(`${config.baseUrl}/api/v4${endpoint}`, {
        method,
        headers: { ...authHeader, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (isIdempotentMmError(text)) {
          log(`[mattermost] API ${resp.status} (idempotent): ${text.slice(0, 200)}`);
        } else {
          log(`⚠ [mattermost] API ${resp.status}: ${text.slice(0, 200)}`);
        }
        return null;
      }
      return (await resp.json()) as T;
    },
  };
}

async function responseText(resp: Response): Promise<string> {
  return (await resp.text().catch(() => "")).slice(0, 200);
}

async function tolerantDelete(api: MmAdmin, path: string, label: string): Promise<void> {
  const resp = await api.fetch(path, { method: "DELETE" });
  if (resp.ok || resp.status === 404) {
    api.log(`[mm] ${label} deleted (or already gone)`);
    return;
  }
  throw new Error(`mm ${label} failed: ${resp.status} ${await responseText(resp)}`);
}

async function blockMmSignIn(api: MmAdmin, userId: string): Promise<void> {
  const deactivated = await api.fetch(`/users/${userId}/active`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: false }),
  });
  if (deactivated.status === 404) {
    api.log(`[mm] user ${userId} is gone, so it cannot sign in`);
    return;
  }
  if (!deactivated.ok) {
    throw new Error(`mm deactivate user ${userId} failed: ${deactivated.status} ${await responseText(deactivated)}`);
  }
  const revoked = await api.fetch(`/users/${userId}/sessions/revoke/all`, { method: "POST" });
  if (!revoked.ok) {
    throw new Error(`mm revoke sessions for user ${userId} failed: ${revoked.status} ${await responseText(revoked)}`);
  }
  api.log(`[mm] user ${userId} deactivated and its sessions revoked`);
}

async function destroyChannel(api: MmAdmin, channelId: string): Promise<void> {
  const resp = await api.fetch(`/channels/${channelId}`, { method: "DELETE" });
  if (resp.ok || resp.status === 404) {
    api.log(`[mm] channel ${channelId} deleted (or already gone)`);
    return;
  }
  const body = await resp.text().catch(() => "");
  if (resp.status === 400 && body.includes(UNDELETABLE_DEFAULT_CHANNEL)) {
    api.log(`[mm] channel ${channelId} is the team default — left for the team delete`);
    return;
  }
  throw new Error(`mm channel ${channelId} failed: ${resp.status} ${body.slice(0, 200)}`);
}

async function listUserTeamChannels(api: MmAdmin, userId: string, teamId: string): Promise<string[]> {
  const resp = await api.fetch(`/users/${userId}/teams/${teamId}/channels`);
  if (resp.status === 404) return [];
  if (!resp.ok) {
    throw new Error(`mm getUserChannels failed: ${resp.status} ${await responseText(resp)}`);
  }
  return channelIdsForTeamDeletion(await resp.json().catch(() => null), teamId);
}

async function eraseScope(api: MmAdmin, { teamId, ownerUserId, channelIds, userIds }: ChannelEraseSpec): Promise<void> {
  const destroyUser = (userId: string) => tolerantDelete(api, `/users/${userId}?permanent=true`, `user ${userId}`);
  if (ownerUserId && teamId) {
    for (const channelId of await listUserTeamChannels(api, ownerUserId, teamId)) {
      await destroyChannel(api, channelId);
    }
  }
  if (ownerUserId) await destroyUser(ownerUserId);
  for (const channelId of channelIds) await destroyChannel(api, channelId);
  for (const userId of userIds) await destroyUser(userId);
  if (teamId) await tolerantDelete(api, `/teams/${teamId}?permanent=true`, `team ${teamId}`);
}

async function ensureMmUser(
  api: MmAdmin,
  { username, email, firstName, lastName, nickname }: ChannelUserSpec,
): Promise<MmEntity | null> {
  let user = await api.call("POST", "/users", {
    email,
    username,
    password: generatePassword(),
    first_name: firstName,
    last_name: lastName,
    nickname,
    roles: "system_user",
  });
  if (!user) {
    user = await api.call("GET", `/users/username/${username}`);
    if (user) api.log(`[mattermost] user ${username} already exists, reusing`);
  }
  if (!user) {
    user = await api.call("GET", `/users/email/${encodeURIComponent(email)}`);
    if (user) {
      api.log(`[mattermost] found existing user by email (${email}), reactivating + updating username`);
      if ((user.delete_at ?? 0) > 0) {
        await api.call("PUT", `/users/${user.id}/active`, { active: true });
        api.log(`[mattermost] reactivated user ${user.id}`);
      }
      await api.call("PUT", `/users/${user.id}/patch`, { username, first_name: firstName, last_name: lastName });
    }
  }
  return user;
}

async function ensureMmChannel(
  api: MmAdmin,
  { teamId, name, displayName, purpose, private: isPrivate }: ChannelSpec,
): Promise<MmEntity | null> {
  let channel = await api.call("POST", "/channels", {
    team_id: teamId,
    name,
    display_name: displayName,
    type: isPrivate ? "P" : "O",
    purpose,
  });
  if (channel) return channel;

  channel = await api.call("GET", `/teams/${teamId}/channels/name/${name}`);
  if (channel) return channel;

  const archived = await api.call<unknown>("GET", `/teams/${teamId}/channels/name/${name}?include_deleted=true`);
  if (isArchivedChannel(archived, name)) {
    channel = await api.call("POST", `/channels/${archived.id}/restore`);
    if (channel) api.log(`[mattermost] restored archived channel: ${name}`);
    return channel;
  }
  return null;
}

async function revokeMmTokens(api: MmAdmin, userId: string, description: string): Promise<string[]> {
  let listed: unknown;
  try {
    listed = await api.call<unknown>("GET", `/users/${userId}/tokens`);
  } catch (err) {
    api.log(`[mattermost] ⚠ list tokens failed for ${userId} — continuing: ${errorMessage(err)}`);
    return [];
  }
  if (!Array.isArray(listed)) return [];
  const revoked: string[] = [];
  for (const token of listed as MmToken[]) {
    if (token?.description !== description || typeof token?.id !== "string") continue;
    try {
      if (await api.call<unknown>("POST", "/users/tokens/revoke", { token_id: token.id }) !== null) {
        revoked.push(token.id);
      }
    } catch (err) {
      api.log(`[mattermost] ⚠ revoke token ${token.id} failed — continuing: ${errorMessage(err)}`);
    }
  }
  return revoked;
}

const TEAM_PAGE_SIZE = 200;

interface MmCommand {
  id: string;
  team_id: string;
  trigger: string;
  url: string;
  method: string;
  token: string;
  [key: string]: unknown;
}

async function strictJson(api: MmAdmin, method: string, path: string, body?: unknown): Promise<unknown> {
  const resp = await api.fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!resp.ok) throw new Error(`mm ${method} ${path.split("?")[0]} failed: ${resp.status} ${await responseText(resp)}`);
  return resp.json();
}

function mmCommands(value: unknown): MmCommand[] {
  if (!Array.isArray(value)) throw new Error("mm list commands returned an invalid command list");
  return value.map((entry: unknown) => {
    const command = entry as Partial<MmCommand> | null;
    if (!command || ["id", "team_id", "trigger", "url", "method", "token"].some((key) => typeof command[key] !== "string")) {
      throw new Error("mm list commands returned an invalid command");
    }
    return command as MmCommand;
  });
}

function teamCommands(api: MmAdmin, teamId: string): Promise<MmCommand[]> {
  return strictJson(api, "GET", `/commands?team_id=${encodeURIComponent(teamId)}&custom_only=true`).then(mmCommands);
}

async function listMmTeamIds(api: MmAdmin): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 0; ; page += 1) {
    const teams = await strictJson(api, "GET", `/teams?page=${page}&per_page=${TEAM_PAGE_SIZE}`);
    if (!Array.isArray(teams)) throw new Error("mm list teams returned an invalid team list");
    for (const team of teams as Array<{ id?: unknown }>) {
      if (typeof team?.id !== "string") throw new Error("mm list teams returned an invalid team");
      ids.push(team.id);
    }
    if (teams.length < TEAM_PAGE_SIZE) return ids;
  }
}

async function ensureMmCommand(api: MmAdmin, spec: ChannelCommandSpec): Promise<ChannelCommandEnsureResult> {
  const desired = {
    team_id: spec.teamId,
    trigger: spec.trigger,
    method: "P",
    url: spec.url,
    display_name: spec.displayName,
    description: spec.description,
    auto_complete: true,
    auto_complete_desc: spec.autocompleteDescription,
    auto_complete_hint: "",
  };
  const existing = (await teamCommands(api, spec.teamId)).find((command) => command.trigger === spec.trigger);
  if (!existing) {
    await strictJson(api, "POST", "/commands", desired);
    return "created";
  }
  if (existing.url === spec.url && existing.method === "P") return "present";
  await strictJson(api, "PUT", `/commands/${existing.id}`, { ...existing, ...desired });
  return "updated";
}

function sameToken(stored: string, presented: Buffer): boolean {
  const expected = Buffer.from(stored);
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

async function mmCommandTokenMatches(
  api: MmAdmin,
  { teamId, trigger, token }: { teamId: string; trigger: string; token: string },
): Promise<boolean> {
  const presented = Buffer.from(token);
  return (await teamCommands(api, teamId)).some((command) =>
    command.trigger === trigger && command.team_id === teamId && sameToken(command.token, presented));
}

export function createMattermostChannelHost(config: MattermostChannelHostConfig): MattermostChannelHost {
  const api = createMmAdmin(config);
  const { call, log } = api;

  return {
    kind: "managed",
    provider: "mattermost",

    async ensureTeam({ name, displayName, inviteOnly }) {
      let team = await call("POST", "/teams", {
        name,
        display_name: displayName,
        type: inviteOnly ? "I" : "O",
      });
      if (!team) {
        team = await call("GET", `/teams/name/${name}`);
        if (team) log(`[mattermost] team ${name} already exists, reusing`);
      }
      return team;
    },

    ensureUser: (input) => ensureMmUser(api, input),

    async ensureBot({ username, displayName, description }) {
      const created = await call<Partial<MmEntity> & { user_id?: string }>("POST", "/bots", {
        username,
        display_name: displayName,
        description,
      });
      if (created?.user_id) return { id: created.user_id, ...created };
      const existing = await call("GET", `/users/username/${username}`);
      if (existing) log(`[mattermost] bot ${username} already exists, reusing`);
      return existing;
    },

    ensureChannel: (input) => ensureMmChannel(api, input),

    findUser: (username) => call("GET", `/users/username/${username}`),

    async setUserPassword(username, password) {
      const user = await call("GET", `/users/username/${username}`);
      if (!user) throw new Error(`mm user ${username} was not found`);
      const resp = await api.fetch(`/users/${user.id}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_password: password }),
      });
      if (!resp.ok) {
        throw new Error(`mm set password for ${username} failed: ${resp.status} ${await responseText(resp)}`);
      }
    },

    blockSignIn: (userId) => blockMmSignIn(api, userId),

    async addMember(target, userId, roles) {
      await call(
        "POST",
        membersPath(target),
        "teamId" in target
          ? { team_id: target.teamId, user_id: userId, ...(roles ? { roles } : {}) }
          : { user_id: userId },
      );
    },

    async removeMember(target, userId) {
      await call("DELETE", `${membersPath(target)}/${userId}`);
    },

    async archiveChannel(ref) {
      if ("channelId" in ref) {
        await call("DELETE", `/channels/${ref.channelId}`);
        return ref.channelId;
      }
      const channel = await call("GET", `/teams/${ref.teamId}/channels/name/${ref.name}`);
      if (!channel?.id) return null;
      await call("DELETE", `/channels/${channel.id}`);
      return channel.id;
    },

    async issueToken(userId, description) {
      const result = await call<{ token?: unknown }>("POST", `/users/${userId}/tokens`, { description });
      const token = result?.token;
      return typeof token === "string" && token.length > 0 ? token : null;
    },

    revokeTokens: (userId, description) => revokeMmTokens(api, userId, description),

    async userExists(userId) {
      const resp = await api.fetch(`/users/${userId}`);
      if (resp.status === 404) return false;
      if (!resp.ok) {
        throw new Error(`mm user lookup ${userId} failed: ${resp.status} ${await responseText(resp)}`);
      }
      return true;
    },

    erase: (scope) => eraseScope(api, scope),

    listTeamIds: () => listMmTeamIds(api),

    ensureCommand: (spec) => ensureMmCommand(api, spec),

    commandTokenMatches: (input) => mmCommandTokenMatches(api, input),
  };
}

export function mattermostChannelHostFromEnv(): MattermostChannelHost {
  assertMattermostConfigured();
  return createMattermostChannelHost({
    baseUrl: process.env.MM_URL as string,
    adminToken: process.env.MM_ADMIN_TOKEN as string,
    log: (message) => coreLog(message),
  });
}

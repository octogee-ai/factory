import type { BuilderRecord, BuilderAgentIdentity, WorkspaceChannel, WorkspaceRecord } from "@octogee/core/platform-state";
import { db } from "./db.js";
import { platformStateStore } from "./platform-state.js";

export interface WorkspaceMmContext {
  ownerUid: string;
  slug: string;
  teamId: string | null;
  userId: string | null;
  username: string | null;
  coachUserId: string | null;
  coachDmChannelId: string | null;
  generalChannelId: string | null;
  adminChannelId: string | null;
}

type RawDocData = Record<string, unknown>;

interface MattermostContextParts {
  workspace: WorkspaceRecord | null;
  generalChan: WorkspaceChannel | null;
  coachDmChan: WorkspaceChannel | null;
  adminChan: WorkspaceChannel | null;
  agent: BuilderAgentIdentity | null;
}

export async function getWorkspaceMmContext(
  ownerUid: string,
  ownerSlug?: string,
  userDataHint?: unknown,
): Promise<WorkspaceMmContext | null> {
  const [userData, builder] = await Promise.all([
    loadUserData(ownerUid, userDataHint),
    platformStateStore.builders.records.get(ownerUid),
  ]);
  if (!userData) return null;
  const slug = resolveWorkspaceSlug(ownerSlug, userData, builder);
  if (!slug) return null;

  const parts = await loadMattermostContextParts(ownerUid, slug);
  return buildWorkspaceMmContext(ownerUid, slug, userData, builder, parts);
}

async function loadUserData(ownerUid: string, userDataHint: unknown): Promise<RawDocData | null> {
  const hinted = asRecord(userDataHint);
  if (hinted) return hinted;
  return asRecord((await db.doc(`users/${ownerUid}`).get()).data());
}

function resolveWorkspaceSlug(ownerSlug: string | undefined, userData: RawDocData, builder: BuilderRecord | null): string | null {
  return ownerSlug || stringField(userData, "username") || builder?.workspaceId || null;
}

async function loadMattermostContextParts(ownerUid: string, slug: string): Promise<MattermostContextParts> {
  const scope = { workspaceSlug: slug, projectSlug: null };
  const { records, channels, agentIdentities } = platformStateStore.workspaces;
  const [workspace, generalChan, coachDmChan, adminChan, agent] = await Promise.all([
    records.get(slug),
    channels.get(scope, "general"),
    channels.get(scope, "coach-dm"),
    channels.get(scope, "admin"),
    agentIdentities.get(ownerUid),
  ]);
  return { workspace, generalChan, coachDmChan, adminChan, agent };
}

function buildWorkspaceMmContext(
  ownerUid: string,
  slug: string,
  userData: RawDocData,
  builder: BuilderRecord | null,
  parts: MattermostContextParts,
): WorkspaceMmContext {
  const userMattermost = asRecord(userData.mattermost);
  return {
    ownerUid,
    slug,
    teamId: parts.workspace?.mattermostTeamId ?? null,
    userId: builder?.mattermostUserId ?? null,
    username: stringField(userMattermost, "username"),
    coachUserId: parts.agent?.mattermostUserId ?? null,
    coachDmChannelId: parts.coachDmChan?.mattermostChannelId ?? null,
    generalChannelId: parts.generalChan?.mattermostChannelId ?? null,
    adminChannelId: parts.adminChan?.mattermostChannelId ?? null,
  };
}

function asRecord(value: unknown): RawDocData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as RawDocData;
}

function stringField(record: RawDocData | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

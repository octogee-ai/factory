import type { UserSnapshot } from "./customer-lifecycle.js";

type ChannelBinding = UserSnapshot["channels"][number];

export function mapWorkspaceChannelDoc(
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "workspace",
    kind: (data.kind as string | undefined) ?? "general",
    channelId,
  };
}

export function mapProjectChannelDoc(
  projectId: string,
  data: Record<string, unknown>,
): ChannelBinding | null {
  const channelId = (data.mattermost as { channelId?: string } | undefined)?.channelId;
  if (!channelId) return null;
  return {
    scope: "project",
    projectId,
    kind: (data.kind as string | undefined) ?? "default",
    channelId,
  };
}

export function deriveSlug(uid: string, data: Record<string, unknown>): string {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const slug = (oc?.slug as string | undefined) ?? (data.username as string | undefined);
  if (!slug) {
    throw new Error(
      `[load:${uid}] cannot derive slug — neither provisioning.openclaw.slug nor users/{uid}.username is set`,
    );
  }
  return slug;
}

function optionalInitialModelFields(
  openclaw: Record<string, unknown> | undefined,
): Pick<
  UserSnapshot,
  "initialModelProvider" | "initialModel" | "initialModelReasoningEffort"
> {
  const out: Pick<
    UserSnapshot,
    "initialModelProvider" | "initialModel" | "initialModelReasoningEffort"
  > = {};
  if (typeof openclaw?.initialModelProvider === "string") {
    out.initialModelProvider = openclaw.initialModelProvider;
  }
  if (typeof openclaw?.initialModel === "string") {
    out.initialModel = openclaw.initialModel;
  }
  if (typeof openclaw?.initialModelReasoningEffort === "string") {
    out.initialModelReasoningEffort = openclaw.initialModelReasoningEffort;
  }
  return out;
}

function snapshotProvisioning(data: Record<string, unknown>): Pick<
  UserSnapshot,
  | "gatewayId"
  | "status"
  | "agentIds"
  | "repoUrl"
  | "greetingPosted"
  | "initialModelProvider"
  | "initialModel"
  | "initialModelReasoningEffort"
> {
  const oc = (data.provisioning as { openclaw?: Record<string, unknown> } | undefined)?.openclaw;
  const git = (data.provisioning as { git?: Record<string, unknown> } | undefined)?.git;
  return {
    gatewayId: (oc?.gatewayId as string | undefined) ?? "",
    status: ((oc?.status as string | undefined) ?? "") as UserSnapshot["status"],
    agentIds: (oc?.agentIds as string[] | undefined) ?? [],
    repoUrl: (git?.repoUrl as string | undefined) ?? "",
    greetingPosted: Boolean((oc?.greeting as { ok?: boolean } | undefined)?.ok),
    ...optionalInitialModelFields(oc),
  };
}

function snapshotIdentity(
  data: Record<string, unknown>,
  slug: string,
): Pick<UserSnapshot, "tier" | "mattermostUserId" | "ownerName"> {
  return {
    tier:
      (data.tier as string | undefined) ??
      (data.subscription as { tier?: string } | undefined)?.tier ??
      "trial",
    mattermostUserId:
      (data.mattermost as { userId?: string } | undefined)?.userId ?? null,
    ownerName:
      (data.displayName as string | undefined) ??
      (data.username as string | undefined) ??
      slug,
  };
}

type SnapshotSystemConfig = NonNullable<UserSnapshot["systemConfig"]>;

export interface ByotSnapshotProjection {
  byotActive: boolean | null;
  systemConfig?: SnapshotSystemConfig;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function byotSystemConfigFromRecord(
  credential: Record<string, unknown>,
): SnapshotSystemConfig | undefined {
  const out: { provider?: string; baseUrl?: string; model?: string } = {};
  if (typeof credential.provider === "string") out.provider = credential.provider;
  if (typeof credential.baseUrl === "string") out.baseUrl = credential.baseUrl;
  if (typeof credential.model === "string") out.model = credential.model;
  return Object.keys(out).length > 0 ? { byot: out } : undefined;
}

export function byotSnapshotProjectionFromSystemConfig(
  sysData: Record<string, unknown> | undefined,
): ByotSnapshotProjection {
  const modelCredential = objectRecord(sysData?.modelCredential);
  if (modelCredential) {
    const systemConfig = modelCredential.active === true
      ? byotSystemConfigFromRecord(modelCredential)
      : undefined;
    return {
      byotActive: systemConfig !== undefined,
      ...(systemConfig ? { systemConfig } : {}),
    };
  }

  const byot = objectRecord(sysData?.byot);
  const systemConfig = byot ? byotSystemConfigFromRecord(byot) : undefined;
  return {
    byotActive: null,
    ...(systemConfig ? { systemConfig } : {}),
  };
}

// Project a users/{uid}/system/config doc down to the byot fields the mount-time
// re-assert needs. Returns undefined when there is nothing usable so the snapshot stays
// lean; deriveDesiredByotState then defaults the provider to anthropic for an active BYOT.
export function byotSystemConfigFromDoc(
  sysData: Record<string, unknown> | undefined,
): UserSnapshot["systemConfig"] {
  return byotSnapshotProjectionFromSystemConfig(sysData).systemConfig;
}

export function mapUserDocToSnapshot(
  uid: string,
  data: Record<string, unknown>,
  channels: UserSnapshot["channels"],
): UserSnapshot {
  const slug = deriveSlug(uid, data);
  return {
    uid,
    slug,
    channels,
    byotActive: Boolean(data.byotActive),
    ...snapshotIdentity(data, slug),
    ...snapshotProvisioning(data),
  };
}

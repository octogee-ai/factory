export type ChannelHostKind = "managed" | "connected";

export interface ChannelHostEntity {
  id: string;
  [key: string]: unknown;
}

export interface ChannelTeamSpec {
  name: string;
  displayName: string;
  inviteOnly: boolean;
}

export interface ChannelUserSpec {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  nickname: string;
}

export interface ChannelBotSpec {
  username: string;
  displayName: string;
  description: string;
}

export interface ChannelSpec {
  teamId: string;
  name: string;
  displayName: string;
  purpose: string;
  private: boolean;
}

export type ChannelMembershipTarget = { teamId: string } | { channelId: string };

export type ChannelRef = { channelId: string } | { teamId: string; name: string };

export interface ChannelEraseSpec {
  teamId: string | null;
  ownerUserId: string | null;
  channelIds: readonly string[];
  userIds: readonly string[];
}

export interface ChannelCommandSpec {
  teamId: string;
  trigger: string;
  url: string;
  displayName: string;
  description: string;
  autocompleteDescription: string;
}

export type ChannelCommandEnsureResult = "created" | "updated" | "present";

export interface ManagedChannelHost {
  readonly kind: "managed";
  readonly provider: string;
  ensureTeam(spec: ChannelTeamSpec): Promise<ChannelHostEntity | null>;
  ensureUser(spec: ChannelUserSpec): Promise<ChannelHostEntity | null>;
  ensureBot(spec: ChannelBotSpec): Promise<ChannelHostEntity | null>;
  ensureChannel(spec: ChannelSpec): Promise<ChannelHostEntity | null>;
  findUser(username: string): Promise<ChannelHostEntity | null>;
  setUserPassword(username: string, password: string): Promise<void>;
  blockSignIn(userId: string): Promise<void>;
  addMember(target: ChannelMembershipTarget, userId: string, roles?: string): Promise<void>;
  removeMember(target: ChannelMembershipTarget, userId: string): Promise<void>;
  archiveChannel(ref: ChannelRef): Promise<string | null>;
  issueToken(userId: string, description: string): Promise<string | null>;
  revokeTokens(userId: string, description: string): Promise<string[]>;
  userExists(userId: string): Promise<boolean>;
  erase(spec: ChannelEraseSpec): Promise<void>;
  listTeamIds(): Promise<string[]>;
  ensureCommand(spec: ChannelCommandSpec): Promise<ChannelCommandEnsureResult>;
  commandTokenMatches(input: { teamId: string; trigger: string; token: string }): Promise<boolean>;
}

export interface ChannelBootstrapInput {
  gatewayId: string;
  ownerId: string;
  setupToken?: string;
}

export interface ChannelBootstrapResult {
  pendingSteps: Array<{ description: string; url?: string }>;
  state: Record<string, unknown>;
}

export interface ChannelCompleteInput {
  gatewayId: string;
  ownerId: string;
  state: Record<string, unknown>;
}

export interface ChannelValidation {
  ok: boolean;
  detail?: string;
}

export interface ChannelDirectoryQuery {
  gatewayId: string;
  query: string;
}

export interface ChannelDirectoryEntry {
  externalId: string;
  displayName: string;
  kind: "user" | "channel";
}

export interface ChannelGatewayConfig {
  channelId: string;
  config: Record<string, unknown>;
  secretRefs: Record<string, string>;
  egressHosts: readonly string[];
}

export interface ConnectedChannelHost {
  readonly kind: "connected";
  readonly provider: string;
  bootstrap(input: ChannelBootstrapInput): Promise<ChannelBootstrapResult>;
  complete(input: ChannelCompleteInput): Promise<void>;
  validate(gatewayId: string): Promise<ChannelValidation>;
  lookupDirectory(query: ChannelDirectoryQuery): Promise<ChannelDirectoryEntry[]>;
  gatewayConfig(gatewayId: string): Promise<ChannelGatewayConfig>;
  remove(gatewayId: string): Promise<void>;
}

export type ChannelHost = ManagedChannelHost | ConnectedChannelHost;

export type FleetBrokerProvisioningStatus = "" | "provisioning" | "complete";
export type FleetBrokerMattermostUpdate = Record<string, unknown>;
export type FleetBrokerGreetingResult =
  | { ok: true; jobId: string }
  | { ok: false; error: string };

export interface FleetBrokerChannelBinding {
  scope: "workspace" | "project";
  kind: string;
  channelId: string;
  projectId?: string;
}

export interface FleetBrokerProjectRestore {
  projectSlug: string;
  giteaRepoName: string | null;
  provisioningState?: string;
}

export interface FleetBrokerCoachIdentity {
  name: string;
  emoji: string;
}

export interface FleetBrokerProjectCreateInput {
  name?: string;
  slug?: string;
  tagline?: string;
  category?: string;
  projectType?: string;
  status?: string;
  visibility?: string;
  repoSource?: unknown;
}

export interface FleetBrokerProjectCreateSuccess {
  success: true;
  workspaceId: string;
  slug: string;
  channelId: string;
}

export interface FleetBrokerUsageData {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  model: string;
  costBreakdown: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

export interface FleetBrokerUsageEvent {
  agentId: string;
  usage: FleetBrokerUsageData;
}

export interface FleetBrokerBlobSignedUrl {
  url: string;
  method: "GET" | "PUT";
  gcsPath: string;
  expiresAt: string;
}

export interface FleetBrokerUserSnapshot {
  uid: string;
  slug: string;
  tier: string;
  gatewayId: string;
  status: FleetBrokerProvisioningStatus;
  agentIds: string[];
  repoUrl: string;
  mattermostUserId: string | null;
  customerMmUserId: string | null;
  greetingPosted: boolean;
  channels: FleetBrokerChannelBinding[];
  projects: FleetBrokerProjectRestore[];
  ownerName: string;
  email: string;
  displayName: string;
  lastName: string;
  photoURL: string;
  onboardingVibe: string | null;
  coachToken: string | null;
  coachMmUserId: string | null;
  coachIdentity?: FleetBrokerCoachIdentity;
}

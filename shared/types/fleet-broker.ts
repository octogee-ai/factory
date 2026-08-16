import type { AssignmentState } from "./gateway-releases.js";
import type { ProjectRepoSource } from "./project.js";

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
  repoSource?: ProjectRepoSource | null;
  provisioningState?: string;
  // Owner-controlled checkout switch. Absent means enabled; only an explicit
  // false keeps the project off the pod.
  checkoutEnabled?: boolean;
  // Whatever the project doc declares; the pod's preview gate filters it
  // against the static-recipe catalog it governs.
  recipe?: string;
}

export type FleetBrokerProjectCheckoutScope =
  | "workspace-only"
  | "workspace-and-projects";

export interface FleetBrokerAssignmentRosterEntry {
  uid: string;
  state: AssignmentState;
  epoch: number;
}

export interface FleetBrokerConfiguredBuilderProjectCredential {
  projectId: string;
  agentId: string;
  accountId: string;
  token: string;
}

export interface FleetBrokerConfiguredBuilderBootstrap {
  uid: string;
  slug: string;
  agentId: string;
  accountId: string;
  coachToken: string;
  projectCredentials: FleetBrokerConfiguredBuilderProjectCredential[];
}

// Vegas: per-project agent state as served to gateways. `token`/`mmUserId`
// come from users/{uid}/secrets/projectAgentMattermost-{pid} (null until the
// bot is minted); `enabled` mirrors the server-managed project-doc agent flag.
export interface FleetBrokerProjectAgent {
  projectId: string;
  enabled: boolean;
  mmUserId: string | null;
  token: string | null;
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
  recipe?: unknown;
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

export interface FleetBrokerPreStopFlushStep {
  name: string;
  status: "done" | "failed" | "skipped";
  error?: string;
  durationMs: number;
}

export interface FleetBrokerPreStopFlushResult {
  ok: boolean;
  durationMs: number;
  steps: FleetBrokerPreStopFlushStep[];
}

export interface FleetBrokerPreStopFlushEvent {
  gatewayClass: string;
  phase: "started" | "completed";
  reason: "prestop";
  result?: FleetBrokerPreStopFlushResult;
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
  projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  projects: FleetBrokerProjectRestore[];
  projectAgents?: FleetBrokerProjectAgent[];
  // Plan-resolution inputs (TierResolvable). Receipt timestamps JSON-serialize as
  // {_seconds,_nanoseconds}; asDate in shared/types/billing parses those shapes, so the
  // pod-side resolveEffectivePlan grants the same catalog/trial access the trusted side
  // resolved instead of silently degrading to house_only.
  selectedTier?: unknown;
  subscription?: unknown;
  // Builder infra subscription (pricing v3) — travels so the pod resolves a
  // credits-rail builder as catalog, not house_only.
  builderSubscription?: unknown;
  trialGrant?: unknown;
  signupOfferConvertedAt?: unknown;
  // The operator's free-tier model dial (platformConfig/models), resolved
  // server-side: the house pin for house_only plans and the BYOK fallback.
  // Fingerprinted — a dial flip re-ensures mounted house-only customers.
  freeTierModelRef?: string;
  // The operator's Builder Agent default dial (platformConfig/models): the
  // {primary, fallbacks} a catalog-plan Agent runs until its Builder picks
  // their own. Fingerprinted — a dial flip re-ensures mounted customers.
  builderAgentDefault?: { primary: string; fallbacks: string[] };
  ownerName: string;
  email: string;
  displayName: string;
  lastName: string;
  photoURL: string;
  onboardingVibe: string | null;
  coachToken: string | null;
  coachMmUserId: string | null;
  coachIdentity?: FleetBrokerCoachIdentity;
  byotActive?: boolean;
  systemConfig?: { byot?: { provider?: string; baseUrl?: string; model?: string } };
}

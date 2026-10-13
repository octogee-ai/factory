import type { NativeSharedAgentContextRestoreHold } from "./fleet-controller.js";
import type { AgentLook } from "./agent-look.js";
import type { AgentModelSelections } from "./agent-models.js";
import type { ProjectAgentIdentity, ProjectAgentStatus } from "./project.js";
import type { AssignmentState } from "./gateway-releases.js";
import type { GatewayVmEgressState } from "./glm.js";
import type { ProjectRepoSource } from "./project.js";

export type FleetBrokerProvisioningStatus = "" | "provisioning" | "complete";
export type FleetBrokerMattermostUpdate = Record<string, unknown>;

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

export interface FleetBrokerConfiguredBuilderDesk {
  builderName: string;
  agentName: string;
  look: AgentLook;
  timeZone: string | null;
}

export interface FleetBrokerConfiguredBuilderBootstrap {
  uid: string;
  slug: string;
  agentId: string;
  accountId: string;
  coachToken: string;
  projectCredentials: FleetBrokerConfiguredBuilderProjectCredential[];
  desk: FleetBrokerConfiguredBuilderDesk;
}

export interface FleetBrokerProjectAgentReadiness {
  projectId: string;
  activationId: string;
  tokenHash: string;
  channelIds: string[];
}

export interface FleetBrokerProjectAgent {
  identity?: ProjectAgentIdentity;
  deliveryPending?: boolean;
  projectId: string;
  activationId?: string | null;
  status?: ProjectAgentStatus | null;
  enabled: boolean;
  mmUserId: string | null;
  token: string | null;
}

export interface FleetBrokerCoachIdentity {
  name: string;
  emoji: string;
}

export interface FleetBrokerProjectCreateInput {
  agentName?: string;
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
  requiredHeaders?: Record<string, string>;
}

export interface FleetBrokerNpmRegistryCredentials {
  registryUrl: string;
  token: string;
  expiresAt: string;
}

export interface FleetBrokerCustomerRuntimeReset {
  status: "pending";
  uid: string;
  slug: string;
  operationId: string;
  sourceGatewayId: string;
  targetGatewayId: string;
  generation: number;
  disposableLeaseId: string;
  disposableLeaseGeneration: number;
  requestedAt: number;
}

export const RETIRED_COMPUTER_BINDING_DENIAL_REASON =
  "retired computer bindings may only reach final-checkpoint routes";

export const BUILDER_RUNTIME_STATE_RECOVERY_TIERS = ["minute", "hour", "day"] as const;

export type BuilderRuntimeStateRecoveryTier =
  (typeof BUILDER_RUNTIME_STATE_RECOVERY_TIERS)[number];

export interface FleetBrokerBuilderRuntimeStateSnapshotUrls {
  live: FleetBrokerBlobSignedUrl;
  recovery: FleetBrokerBlobSignedUrl[];
}

export interface FleetBrokerBuilderRuntimeStatePruneResult {
  deleted: number;
}

export interface FleetBrokerComputerHomeCheckpointUrl {
  name: string;
  upload: FleetBrokerBlobSignedUrl;
}

export interface FleetBrokerComputerHomeCheckpointCommit {
  name: string;
  size: number;
  sha256: string;
  completedAt: number;
}

export interface FleetBrokerComputerHomeDownload extends FleetBrokerComputerHomeCheckpointCommit {
  coverage?: "builder-home-v2";
  writerProtocol?: 2 | 3;
  instanceId?: string | null;
  generation?: string;
  download: FleetBrokerBlobSignedUrl;
}

export interface FleetBrokerNativeSharedContextDownload {
  checkpoint: import("./glm.js").GatewayVmHomeCheckpoint;
  size: number;
  sha256: string;
  generation: string;
  download: FleetBrokerBlobSignedUrl;
}

export function sharedContextCheckpointObjectPath(slug: string, checkpoint: import("./glm.js").GatewayVmHomeCheckpoint, archive: { archiveId: string; contextSha256: string }): string {
  return `customers/${slug}/computer-home/shared-context/${checkpoint.name}/${checkpoint.generation}/${archive.archiveId}/${archive.contextSha256}.tar.gz`;
}

export interface FleetBrokerComputerHomePruneResult {
  deleted: number;
}

export interface FleetBrokerComputerEgress {
  egress: GatewayVmEgressState | null;
}

export type FleetBrokerOpenClawBootAction = "start" | "doctor" | "wait";

export interface FleetBrokerOpenClawBootClaim {
  action: FleetBrokerOpenClawBootAction;
  sourceDoctor?: { requestId: string; agentIds: string[] };
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
  runtimeReset?: FleetBrokerCustomerRuntimeReset;
  nativeSharedContextRestore?: NativeSharedAgentContextRestoreHold;
  repoUrl: string;
  mattermostUserId: string | null;
  customerMmUserId: string | null;
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
  timeZone?: string | null;
  photoURL: string;
  onboardingVibe: string | null;
  coachToken: string | null;
  coachMmUserId: string | null;
  coachIdentity?: FleetBrokerCoachIdentity;
  byotActive?: boolean;
  systemConfig?: {
    byot?: { provider?: string; baseUrl?: string; model?: string };
    agentModels?: AgentModelSelections;
  };
}

export type FleetBrokerNativeSharedContextCheckpointRequest = NativeSharedAgentContextRestoreHold & { checkpoint: import("./glm.js").GatewayVmHomeCheckpoint };

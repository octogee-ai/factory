import type { AssignmentState } from "./gateway-releases.js";
export type FleetBrokerProvisioningStatus = "" | "provisioning" | "complete";
export type FleetBrokerMattermostUpdate = Record<string, unknown>;
export type FleetBrokerGreetingResult = {
    ok: true;
    jobId: string;
} | {
    ok: false;
    error: string;
};
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
export type FleetBrokerProjectCheckoutScope = "workspace-only" | "workspace-and-projects";
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
    selectedTier?: unknown;
    subscription?: unknown;
    builderSubscription?: unknown;
    trialGrant?: unknown;
    signupOfferConvertedAt?: unknown;
    freeTierModelRef?: string;
    builderAgentDefault?: {
        primary: string;
        fallbacks: string[];
    };
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
    systemConfig?: {
        byot?: {
            provider?: string;
            baseUrl?: string;
            model?: string;
        };
    };
}

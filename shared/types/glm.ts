

export type GatewayDesiredStatus = "running" | "draining" | "retired";

export const GATEWAY_PROFILES = ["standard", "operator"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export interface GatewayDesiredState {
  
  gatewayId: string;
  
  instanceName: string;
  imageRepository: string;
  imageTag: string;

profile?: GatewayProfile;
  desiredStatus: GatewayDesiredStatus;
  
  createdBy: string;
  
  retireAfter?: number;
  
  serviceAccountName?: string;

gcpProject?: string;

gatewayContainerSecurityContext?: Record<string, unknown>;

persistence?: GatewayPersistenceSpec;
  
  lastError?: { at: number; message: string } | null;

openclawOverrides?: Record<string, unknown>;

byosub?: Record<string, ByosubRef>;

ownerUid?: string;

coOwnerUids?: string[];

builderSlug?: string;
  
  tier?: string;
}

export interface BuilderShellSession {
  sessionId: string;
  gatewayId: string;
  uid: string;
  via: "owner" | "co-owner";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  status: "active" | "closed" | "timed-out" | "errored";
  error?: string;
}

export const BUILDER_SHELL_SESSIONS_COLLECTION = "builder_shell_sessions" as const;

export interface GatewayPersistenceSpec {
  enabled: boolean;
  existingClaim?: string;
  storageClassName?: string;
  size?: string;
  accessModes?: string[];
}

export type ByosubProvider = "openai" | "anthropic";

export interface ByosubRef {
  provider: ByosubProvider;
  
  secretName: string;
}

export type OperationKind =
  | "add-gateway"
  | "migrate-customer"
  | "retire-gateway"
  | "rollout"
  | "deprovision-customer";

export type OperationStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rolled-back";

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface OperationStep {
  name: string;
  status: StepStatus;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Operation {
  id: string;
  kind: OperationKind;
  status: OperationStatus;
  createdBy: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  input: Record<string, unknown>;
  steps: OperationStep[];
  error?: string;
  rolledBack?: boolean;
}

export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;

chartFingerprint?: string;
  serviceAccountName?: string;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  persistence?: GatewayPersistenceSpec;

profile?: GatewayProfile;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";

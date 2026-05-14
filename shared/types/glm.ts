/**
 * Gateway Lifecycle Manager — shared types between workspace-api,
 * glm-controller, and the admin UI. See
 * docs/architecture/GATEWAY-PLATFORM-SPEC.md §Gateway Lifecycle Manager.
 */

export type GatewayDesiredStatus = "running" | "draining" | "retired";

export interface GatewayDesiredState {
  /** Operator-meaningful id, matches `users/{uid}.provisioning.openclaw.gatewayId`. */
  gatewayId: string;
  /** Helm `instances.{name}` key — typically the gatewayId minus the `gw-{env}-` prefix. */
  instanceName: string;
  imageRepository: string;
  imageTag: string;
  desiredStatus: GatewayDesiredStatus;
  /** Operator identity (uid for human, "ci:{sha}" for CI, "agent:{name}" for an automated caller). */
  createdBy: string;
  /** Optional retire deadline — reconciler treats `desiredStatus=retired` after this point as a hard remove regardless of mountedCustomers. */
  retireAfter?: number;
  /** Last reconcile error, if any. Cleared on successful reconcile. */
  lastError?: { at: number; message: string } | null;
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

/** Helm `instances.{name}` map shape — what the reconciler renders into values. */
export interface HelmInstanceValue {
  enabled: boolean;
  image: { repository: string; tag: string };
  gatewayId: string;
  /**
   * Hash of the on-disk gateway chart at the moment Cowboy rendered the
   * release. Cowboy compares its current chart's fingerprint against
   * the value last stored in the helm release; when they differ (chart
   * template change shipped via glm-controller image rebuild), the
   * diff detects an "update" and helm re-applies.
   *
   * Optional so older releases that predate this field load without
   * fingerprint info — they'll trigger one update on the first reconcile
   * after upgrade to set the field.
   */
  chartFingerprint?: string;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";

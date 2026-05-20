/**
 * Gateway Lifecycle Manager — shared types between workspace-api,
 * glm-controller, and the admin UI. See
 * docs/architecture/GATEWAY-PLATFORM-SPEC.md §Gateway Lifecycle Manager.
 */

export type GatewayDesiredStatus = "running" | "draining" | "retired";

/**
 * Gateway *capability profile* — orthogonal to the instance identity and
 * to the fleet image SHA. `standard` is the pooled/cattle gateway image;
 * `operator` is the same image + the operator toolkit (gcloud, kubectl,
 * helm, terraform, firebase) for Builder-operator instances (e.g.
 * BenderEcho). Cowboy resolves a profile to its image repository at the
 * fleet SHA — see glm-controller `resolveGatewayImageRepository`. New
 * profiles are one row in `infra/gateway/profiles.yaml`, never a new
 * per-customer image name. See docs/architecture/GATEWAY-PLATFORM-SPEC.md
 * §Gateway Profiles vs Gateway Instances.
 */
export const GATEWAY_PROFILES = ["standard", "operator"] as const;
export type GatewayProfile = (typeof GATEWAY_PROFILES)[number];

export interface GatewayDesiredState {
  /** Operator-meaningful id, matches `users/{uid}.provisioning.openclaw.gatewayId`. */
  gatewayId: string;
  /** Helm `instances.{name}` key — typically the gatewayId minus the `gw-{env}-` prefix. */
  instanceName: string;
  imageRepository: string;
  imageTag: string;
  /**
   * Optional capability profile. Absent / `standard` ⇒ use
   * `imageRepository` literally (zero change for the existing cattle
   * fleet). A non-standard profile ⇒ Cowboy derives the repository for
   * that profile at this same `imageTag` (the fleet SHA). The validated
   * ergonomic knob — operators set `profile: "operator"`, not a raw repo
   * string.
   */
  profile?: GatewayProfile;
  desiredStatus: GatewayDesiredStatus;
  /** Operator identity (uid for human, "ci:{sha}" for CI, "agent:{name}" for an automated caller). */
  createdBy: string;
  /** Optional retire deadline — reconciler treats `desiredStatus=retired` after this point as a hard remove regardless of mountedCustomers. */
  retireAfter?: number;
  /** Optional per-instance Kubernetes ServiceAccount override. */
  serviceAccountName?: string;
  /**
   * Optional gateway-container securityContext override. Used for
   * personal build gateways that need sudo/elevated exec while shared
   * gateways keep the chart's locked-down default.
   */
  gatewayContainerSecurityContext?: Record<string, unknown>;
  /**
   * Optional per-instance OpenClaw home persistence. Default remains
   * emptyDir; personal dogfood gateways may opt into a PVC until their
   * complete durable restore path is proven.
   */
  persistence?: GatewayPersistenceSpec;
  /** Last reconcile error, if any. Cleared on successful reconcile. */
  lastError?: { at: number; message: string } | null;
  /**
   * Per-gateway partial `openclaw.json` overlay, deep-merged pre-boot
   * (before gateway policy patches). SecretRef-only — never inline secrets.
   * See docs/specs/PER-GATEWAY-CONFIG-SPEC.md.
   */
  openclawOverrides?: Record<string, unknown>;
  /**
   * BYO-subscription credential refs, keyed by openclaw agent id (e.g.
   * `octogee-ceckert-coach`). The value is a *reference* to an owner-scoped
   * Secret Manager secret — never the credential itself. Pre-boot restores
   * each into that agent's per-agent codex-home. One gateway can host many
   * customers, each with their own ref. See BYO-SUBSCRIPTION-OAUTH-SPEC.md.
   */
  byosub?: Record<string, ByosubRef>;
  /**
   * Firebase UID of the Builder who owns this operator-profile gateway.
   * Gates `glmGateways/{id}` reads + shell-ticket mint at the Builder-
   * facing surface. Cattle gateways leave absent. Spec:
   * GATEWAY-PLATFORM-SPEC.md §Operator Shell Access.
   */
  ownerUid?: string;
  /**
   * Additional Firebase UIDs with shell access. Primary `ownerUid`
   * keeps exclusive write authority; co-owners are shell-only.
   */
  coOwnerUids?: string[];
  /**
   * Builder slug (matches `users/{uid}.slug`). Source of the
   * `builder=<slug>` GCP resource label for cost attribution. Spec:
   * GATEWAY-PLATFORM-SPEC.md §Billing & Cost Attribution.
   */
  builderSlug?: string;
  /** Billing tier (`hobby` | `pro` | `operator` | `enterprise`). Source of `tier=<id>` GCP resource label. */
  tier?: string;
}

/**
 * Audit record for a Builder-facing web-terminal session. Written under
 * `builder_shell_sessions/{sessionId}` at open (status=active); updated
 * on close (status + endedAt + durationMs). Spec:
 * GATEWAY-PLATFORM-SPEC.md §Operator Shell Access.
 */
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
  /** Owner-scoped Secret Manager secret name, e.g. `byosub-{uid}-openai`. */
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
  serviceAccountName?: string;
  gatewayContainerSecurityContext?: Record<string, unknown>;
  persistence?: GatewayPersistenceSpec;
  /**
   * Capability profile passed to the chart as a helm value so templates
   * can render profile-conditional resources (e.g. operator gateways
   * skip `ANTHROPIC_API_KEY` env injection — operators authenticate via
   * `claude auth login` / per-agent BYOS; the platform env would shadow
   * those, see BYO-SUBSCRIPTION-OAUTH-SPEC §3b). Cattle/standard leaves
   * this absent — chart default `profile: ""` preserves cattle behavior
   * (welcome path + L3 throttle fallback).
   */
  profile?: GatewayProfile;
}

export type HelmInstancesMap = Record<string, HelmInstanceValue>;

export const GLM_GATEWAYS_COLLECTION = "glmGateways";
export const GLM_OPERATIONS_COLLECTION = "glmOperations";

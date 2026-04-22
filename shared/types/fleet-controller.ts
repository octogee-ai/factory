/**
 * Fleet controller types — CANONICAL source.
 *
 * Mirrored at `functions/src/fleet-controller/types.ts` until we migrate
 * Cloud Functions to TS project references. Any change here must be
 * mirrored there (and vice versa). Drift would surface at runtime as a
 * JSON-shape rejection on the gateway's POST /restore-customer handler.
 *
 * Spec: docs/GATEWAY-FLEET-CONTROLLER-SPEC.md
 *
 * The controller reads/writes these shapes in Firestore; both sides of the
 * wire consume the same declarations so drift can't open up. No runtime
 * validation here — types are compile-time only, consistent with the rest
 * of `@octogee/shared`.
 */

// ── Gateway state ────────────────────────────────────────────────────────────

/**
 * Gateway lifecycle status, authored by the gateway's provisioner.
 *
 *   booting       — pod is up, OpenClaw may still be starting; do not enqueue jobs.
 *   ready         — gateway is accepting restore jobs.
 *   draining      — operator-initiated; stop enqueueing new jobs, let in-flight
 *                   complete. Used for zero-downtime pod replacement.
 *   unreachable   — controller-assigned when lastHeartbeatAt is older than
 *                   GATEWAY_UNREACHABLE_AFTER_MS. Provisioner process likely
 *                   dead; customers eligible for re-mount when the heartbeat
 *                   returns.
 */
export type GatewayStatus = "booting" | "ready" | "draining" | "unreachable";

export interface GatewayLastError {
  jobId: string;
  slug: string;
  message: string;
  at: unknown; // Firestore Timestamp
}

export interface GatewayState {
  /** Duplicates the doc id so queries can filter on gatewayId without a key-path lookup. */
  gatewayId: string;
  status: GatewayStatus;
  /**
   * Written every `GATEWAY_HEARTBEAT_INTERVAL_MS` by the gateway provisioner.
   * The controller's reconciler uses `lastHeartbeatAt` older than
   * `GATEWAY_UNREACHABLE_AFTER_MS` as the signal to transition the gateway to
   * `unreachable` status.
   */
  lastHeartbeatAt: unknown; // Firestore Timestamp
  /** Immutable per-pod — `BUILD_SHA` env var from the image. */
  version: string;
  /** `openclaw --version` output. Useful when debugging fork vs. upstream behavior. */
  openclawVersion: string;
  /**
   * Customer slugs currently present in the gateway's `openclaw.json`
   * `channels.mattermost.accounts` map. The controller uses this as the
   * mounted-set when computing the pending-set for pick-next.
   */
  mountedCustomers: string[];
  /**
   * Non-null while a restore job is actively running on this gateway.
   * Serializes pick-next: the controller won't enqueue a new job while a
   * previous one is still in flight. See `JOB_TTL_MS` for stuck-job handling.
   */
  inFlightJobId: string | null;
  /** Set when a restore job finishes (success OR failure). Trigger for next pick-next. */
  lastJobCompletedAt: unknown | null; // Firestore Timestamp | null
  /** Most recent failure — kept for one job lifetime. Null when last job succeeded. */
  lastError: GatewayLastError | null;
}

// ── Restore jobs ─────────────────────────────────────────────────────────────

/**
 * Restore job state machine.
 *
 *   pending     — doc created, Cloud Task not yet dispatched.
 *   dispatched  — Cloud Task created successfully; awaiting gateway HTTP ack.
 *   running     — gateway accepted the job, steps are executing.
 *   done        — steps completed + channels.status verified.
 *   failed      — one of the steps errored out. `error` carries a short reason.
 */
export type RestoreJobState =
  | "pending"
  | "dispatched"
  | "running"
  | "done"
  | "failed";

/**
 * Snapshot of the fields from `users/{uid}` + associated collections that the
 * gateway needs to execute a restore. Taken by the controller at job-creation
 * time so retries use consistent input even if Firestore mutates between
 * attempts. Shape parallels `boot-sync.CustomerState` but is separate because
 * the boot-sync type is internal to the scripts package.
 */
export interface CustomerSnapshot {
  uid: string;
  slug: string;
  tier: string;
  businessName: string;
  gatewayId: string;
  repoUrl: string;
  agentIds: string[];
  customerMmUserId: string | null;
  channels: Array<{
    scope: "workspace" | "project";
    projectId?: string;
    kind: string;
    channelId: string;
  }>;
}

export interface RestoreJob {
  jobId: string;
  gatewayId: string;
  uid: string;
  slug: string;
  state: RestoreJobState;
  /**
   * Cloud Tasks retry count, 1-indexed. Incremented by the gateway on each
   * invocation (Cloud Tasks re-delivers on non-2xx; we need to know whether
   * we're on a retry to avoid double-side-effects).
   */
  attempt: number;
  createdAt: unknown; // Firestore Timestamp
  dispatchedAt: unknown | null; // Firestore Timestamp | null
  completedAt: unknown | null; // Firestore Timestamp | null
  error: string | null;
  snapshot: CustomerSnapshot;
}

// ── Constants shared across controller + gateway ─────────────────────────────

/** Gateway heartbeat cadence. */
export const GATEWAY_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Reconciler threshold for transitioning a gateway to `unreachable`. Must be
 * a multiple of the heartbeat interval with enough slack to tolerate normal
 * Firestore write latency and one missed heartbeat.
 */
export const GATEWAY_UNREACHABLE_AFTER_MS = 3 * 60_000;

/**
 * Upper bound on a single restore job. Past this the reconciler marks it
 * failed and clears the gateway's `inFlightJobId` so pick-next can proceed.
 * Chosen to cover the 2-minute worst-case cold start (classifier warm-up +
 * model-pricing fetch timeouts + Gitea clone) plus headroom for network
 * flakes.
 */
export const JOB_TTL_MS = 10 * 60_000;

/**
 * Budget for the gateway to verify a mounted account reached
 * `{running: true, connected: true}` via `channels.status` RPC. Soft — if
 * the budget runs out the gateway logs a warning but still acks the job as
 * done so the controller can move on.
 */
export const VERIFY_ACCOUNT_TIMEOUT_MS = 30_000;

/**
 * Cloud Tasks header name the controller uses to set an idempotency key.
 * Gateway rejects duplicate jobIds within the last hour.
 */
export const IDEMPOTENCY_HEADER = "X-Idempotency-Key";

/**
 * Cloud Tasks header name carrying the shared-secret HMAC the controller
 * signs with. Gateway verifies against its `FLEET_CONTROLLER_SECRET` env.
 */
export const SIGNATURE_HEADER = "X-Fleet-Controller-Signature";

/** Firestore collection names — constants to keep drift between writer + reader impossible. */
export const GATEWAYS_COLLECTION = "gateways";
export const RESTORE_JOBS_COLLECTION = "restoreJobs";

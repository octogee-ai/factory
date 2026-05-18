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
  /**
   * Cluster-internal URL where this gateway's OpenClaw RPC listens. Written
   * by the heartbeat; read by workspace-api / chat-proxy to resolve a
   * user's assigned gateway to a connectable host. Canonical shape:
   * `http://octogee-gateway-{gatewayId}.{namespace}.svc.cluster.local:{port}`.
   */
  internalUrl?: string;
  /**
   * Epoch ms when the current gateway process booted. Captured once per
   * process (constant across heartbeats), so it resets on every gateway
   * restart — `now − startedAt` is true process uptime / a restart-loop
   * signal. Surfaced by admin-fleet-router as `uptimeMs`.
   */
  startedAt?: number;
  /**
   * Per-customer failure tracker for exponential-backoff scheduling. Keyed
   * by slug. Pick-next skips any slug whose last failure is still inside
   * the backoff window computed from its `failCount`, so a single corrupt
   * user doc cannot flat-line the gateway by spinning on immediate-requeue.
   * Cleared on successful restore for that slug.
   *
   * Missing field (older gateways) is treated as "no failures" — pick-next
   * defaults to an empty map when absent.
   */
  failedCustomers?: Record<string, { failCount: number; lastFailedAt: unknown /* Timestamp */ }>;
}

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
 *
 * This only backstops the no-ack / process-death case: a *failing* restore
 * acks failure promptly (markJobFailedAndGatewayAcked → inFlightJobId=null
 * → onGatewayUpdatedForFleet → next pick), so recovery is event-chained,
 * not TTL-paced. The old 10min value was a slow-provisioning artifact that
 * let one hung job block every other customer's recovery on a gateway for
 * 10min. Invariant (enforced by fleet-backoff.test.ts): must stay strictly
 * greater than ADD_CUSTOMER_DEADLINE_MS (300_000) so a healthy in-flight
 * restore is never reaped — set to that worst case + 60s headroom.
 */
export const JOB_TTL_MS = 6 * 60_000;

/**
 * Budget for the gateway to verify a mounted account reached
 * `{running: true, connected: true}` via `channels.status` RPC. The greeting
 * cron is scheduled only after this verify passes, so the budget must cover
 * the full cold-mount flow including any follow-up config patches that
 * restart the MM channel mid-boot. Empirically the second restart finishes
 * by ~25s on TEST so 120s is generous; a hard fail past this is the right
 * signal that something is genuinely wrong with the mount.
 */
export const VERIFY_ACCOUNT_TIMEOUT_MS = 120_000;

/**
 * Hard ceiling on cumulative time `applyConfigPatch` will spend retrying a
 * single patch. OpenClaw's `config.patch` RPC rate-limits to ~1 patch per
 * 60s and returns `retry after Ns` hints. 90s covers one full rate-limit
 * window plus a buffer for retry-after delays. Past this, fail loud rather
 * than silently extend the mount duration into the multi-minute range that
 * triggered the 2026-05-13 batch-migration incident.
 */
export const CONFIG_PATCH_DEADLINE_MS = 90_000;

/**
 * Hard ceiling on the entire `addCustomerToGateway` flow per customer. Sum
 * of: SSH key + Gitea (~3s) + clone (~5s) + blob-sync (~10s) + project
 * clone (~5s) + MM provision (~10s) + config patch (≤CONFIG_PATCH_DEADLINE_MS)
 * + verify-channel-ready (≤VERIFY_ACCOUNT_TIMEOUT_MS) + greeting cron (~5s).
 * Hits ~260s in the worst case; we pad to 300s. If we exceed this, a
 * downstream step is genuinely hung and the in-flight lock must be
 * released so retries can run on a clean state.
 */
export const ADD_CUSTOMER_DEADLINE_MS = 300_000;

/**
 * Per-RPC client-side timeouts for the migration HTTP client. Applied to
 * each fetch leg independently (not cumulatively across legs). These are
 * `AbortSignal` budgets passed into fetch so a hung server-side step
 * surfaces as a clear "X timed out after Nms" rather than undici's default
 * 300s headersTimeout firing as opaque `fetch failed`.
 *
 * Picked to be slightly longer than the matching server-side budgets so
 * an in-budget server response can still come back:
 * - quiesce: server drains in-flight runs to disk; usually <5s but bounded
 *   by the longest agent turn.
 * - transfer: applied to BOTH the /export leg and the /import leg in
 *   `transferState`, so worst-case wall clock is 2 × TRANSFER_TIMEOUT_MS.
 *   Each leg sized for /import's `addCustomerToGateway` (≤ADD_CUSTOMER_DEADLINE_MS)
 *   plus 30s slack; /export is typically much faster but reuses the
 *   budget rather than introducing a separate constant.
 * - unmount: single config.patch + dir delete (≤CONFIG_PATCH_DEADLINE_MS)
 *   plus 30s slack.
 */
export const MIGRATION_QUIESCE_TIMEOUT_MS = 60_000;
export const MIGRATION_TRANSFER_TIMEOUT_MS = ADD_CUSTOMER_DEADLINE_MS + 30_000;
export const MIGRATION_UNMOUNT_TIMEOUT_MS = CONFIG_PATCH_DEADLINE_MS + 30_000;

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

// ── Migration RPCs (gateway-side, called by orchestrator) ────────────────────
//
// Endpoints exposed by every gateway pod for live customer migration. The
// orchestrator (CLI verb `fleet migrate-customer --apply`, lands in a follow-
// up PR) drives the four-step state machine from scripts/lib/fleet-migration.ts
// against these RPCs. Authentication is the same HMAC scheme as
// /restore-customer — `X-Fleet-Controller-Signature` over the canonical
// payload — and the same `FLEET_CONTROLLER_SECRET` shared secret.
//
//   POST /quiesce/{gatewayId}    — drain in-flight runs for the slug's agent.
//                                  Returns when sessions.json shows no
//                                  `status: "running"` sessions for that
//                                  agent, or 408 on timeout.
//   POST /export/{gatewayId}     — stream a tarball of the slug's agent dir
//                                  (~/.openclaw/agents/{agentId}) + customer
//                                  SSH keys. Response Content-Type is
//                                  application/x-tar; orchestrator pipes it
//                                  to the target's /import.
//   POST /import/{gatewayId}     — accept a tarball as request body. Unpacks
//                                  to the same paths on this gateway, then
//                                  registers the agent in OpenClaw (config
//                                  patch). Body is the tarball; HMAC signs
//                                  the X-Migration-Id + slug header pair (no
//                                  body-bytes signing — orchestrator uses
//                                  Content-Length + tar magic to validate).
//   POST /unmount/{gatewayId}    — release the slug from this gateway:
//                                  remove from openclaw config, delete
//                                  on-disk state. Identical to the existing
//                                  removeCustomerFromGateway flow.

export interface MigrationRequestBody {
  /** Stable id for the whole migration (orchestrator-generated, used for
   *  HMAC + idempotency across the four RPCs). */
  migrationId: string;
  /** Customer slug being migrated. */
  slug: string;
}

export interface QuiesceRequestBody extends MigrationRequestBody {
  /** Max time to wait for in-flight runs to drain. Defaults to 60_000 ms
   *  on the gateway when omitted. */
  timeoutMs?: number;
}

export interface QuiesceResponse {
  migrationId: string;
  slug: string;
  /** True if all sessions for the agent reached non-running state before
   *  the timeout. False with `runningCount > 0` means the gateway gave up
   *  waiting; the orchestrator should decide whether to abort or force. */
  drained: boolean;
  /** Number of running sessions observed at the moment of return. Always
   *  0 when `drained: true`. */
  runningCount: number;
}

// /export request body is the base `MigrationRequestBody` shape ({migrationId,
// slug}) — no extra fields, so no separate type. The response is a binary
// tar stream (Content-Type: application/x-tar); errors before streaming
// begins return the standard { error, message } JSON shape.

export interface ImportResponse {
  migrationId: string;
  slug: string;
  /** True when the import succeeded — tarball unpacked + agent registered
   *  in OpenClaw. */
  imported: boolean;
  /** True when the slug was already in this gateway's mounted set and the
   *  request was treated as a noop (no tarball read, no dir wipe). Lets
   *  callers distinguish "fresh import" from "already there" without
   *  inspecting log lines. */
  alreadyMounted?: boolean;
}

export interface UnmountRequestBody extends MigrationRequestBody {}

export interface UnmountResponse {
  migrationId: string;
  slug: string;
  /** True if the slug was mounted prior to this call. False is not an
   *  error — it means the gateway didn't have this customer to unmount
   *  (already gone, never mounted). */
  unmounted: boolean;
}

/** Headers the gateway expects on /import (where body is the tarball, not
 *  JSON). The HMAC is computed over `${migrationId}\n${slug}` instead of
 *  the body, since the body is a streamed tar. */
export const MIGRATION_ID_HEADER = "X-Migration-Id";
export const MIGRATION_SLUG_HEADER = "X-Migration-Slug";

/**
 * Exponential backoff (in ms) keyed by cumulative failure count for a given
 * customer on a gateway. Pick-next skips a slug while
 *   now - lastFailedAt < backoffMsForFailCount(failCount)
 *
 *   failCount=1 → 10 s
 *   failCount=2 → 20 s
 *   failCount=3 → 40 s
 *   failCount=6 → 5.3 min
 *   failCount≥11 → capped at 120 min (2h)
 *
 * Rationale: the only thing the cooldown must do is break the hot-loop
 * where the controller re-picks the same candidate on every
 * `inFlightJobId=null` transition (sub-second). A 10s first cooldown does
 * that with margin; the old 2-min floor was a slow-provisioning artifact
 * that turned a transiently-failed customer's recovery into minutes. The
 * exponential growth + 2h cap still keeps a genuinely-broken customer
 * quiet ("fails naturally", no forever-ban of transients).
 */
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 120 * 60_000;

export function backoffMsForFailCount(failCount: number): number {
  if (failCount <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, failCount - 1), BACKOFF_CAP_MS);
}

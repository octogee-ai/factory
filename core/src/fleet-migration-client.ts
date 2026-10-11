

import { gatewayScopedJobId, signFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  type NativeAgentContextTransfer,
  type NativeSharedAgentContextRecovery,
  type NativeSharedAgentContextStage,
  type SchedulerMigrationRequestBody,
  type SchedulerMigrationResult,
  type FlushGatewayResponse,
  type ImportResponse,
  type MigrationProgressRequestBody,
  type QuiesceResponse,
  type RestoreMigrationResponse,
  type UnmountResponse,
  type VerifyMigrationResponse,
} from "@octogee/shared/types/fleet-controller";
import type {
  FleetBrokerProjectCheckoutScope,
  FleetBrokerUserSnapshot,
} from "@octogee/shared/types/fleet-broker";
import type { MigrationSyncMode } from "./fleet-migration.js";

export interface MigrationClientTimeouts {
  quiesceMs?: number;
  transferMs?: number;
  unmountMs?: number;
  verifyMs?: number;
}

export interface MigrationClientDeps {
  privateKey: string;

  resolveGatewayUrl: (gatewayId: string) => string;

  fetch?: typeof globalThis.fetch;

  log?: (msg: string) => void;

  timeouts?: MigrationClientTimeouts;

  finishAgentContextRestore?: MigrationClient["finishAgentContextRestore"];
  transferState: MigrationClient["transferState"];
}

// `gatewayId` is the TENANT path id — bare, put in the in-pod URL path and
// matched by the pod's GATEWAY_ID guard. `transportId` defaults to the bare
// gatewayId; simple-roll has one stable Service per gateway, so tenant and
// transport are the same name (GATEWAY-SIMPLE-ROLL-SPEC).
export interface MigrationClient {
  abortImport(opts: { migrationId: string; gatewayId: string; slug: string; mode: MigrationSyncMode }): Promise<void>;
  scheduler(opts: SchedulerMigrationRequestBody & { gatewayId: string; transportId?: string }): Promise<SchedulerMigrationResult>;
  schedulerReady(opts: { migrationId: string; gatewayId: string; transportId?: string; slug: string }): Promise<void>;
  resume(opts: { migrationId: string; gatewayId: string; transportId?: string; slug: string }): Promise<void>;
  quiesce(opts: {
    stopMattermost?: boolean;
    schedulerHandoff?: boolean;
    schedulerMigrationId?: string;
    retainNonportable?: boolean;
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<QuiesceResponse>;

  flushGateway(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    reason: string;
    expectedSystemConfigCommit?: string;
  }): Promise<FlushGatewayResponse>;

  restoreTarget(opts: {
    resume?: boolean;
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    uid: string;
    slug: string;
    snapshot: FleetBrokerUserSnapshot;
  }): Promise<RestoreMigrationResponse>;

  finishAgentContextRestore(opts: {
    sharedAgentContextRecovery?: NativeSharedAgentContextRecovery;
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    slug: string;
    agentContext: Extract<NativeAgentContextTransfer, { mode: "restore-shared" }>;
    stage: NativeSharedAgentContextStage;
  }): Promise<ImportResponse>;

  transferState(opts: {
    stageOnly?: boolean;
    agentContext?: NativeAgentContextTransfer;
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    fromTransportId?: string;
    toTransportId?: string;
    slug: string;
    mode?: MigrationSyncMode;
    includeActivationManifest?: boolean;
    projectCheckoutScope?: FleetBrokerProjectCheckoutScope;
  }): Promise<ImportResponse>;

  verifyTarget(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<VerifyMigrationResponse>;

  unmount(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
  }): Promise<UnmountResponse>;
}

export interface MigrationRpcErrorOptions {
  details?: unknown;
  status?: number;
  code?: string;
}

export class MigrationRpcError extends Error {
  readonly details?: unknown;
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: MigrationRpcErrorOptions = {}) {
    super(message);
    this.name = "MigrationRpcError";
    this.details = options.details;
    this.status = options.status;
    this.code = options.code;
  }
}

export class MigrationDrainPendingError extends Error {
  readonly retryable = true;
}

export class MigrationTransportError extends Error {
  readonly retryable = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "MigrationTransportError";
  }
}

export function isDefinitiveConfigRpcRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const rpc = error as { status?: unknown };
  return typeof rpc.status === "number" &&
    (rpc.status === 501 ||
      rpc.status >= 400 &&
      rpc.status < 500 &&
      rpc.status !== 408 &&
      rpc.status !== 429);
}

type FetchWithTimeout = (
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
) => Promise<Response>;

function createFetchWithTimeout(fetchImpl: typeof globalThis.fetch): FetchWithTimeout {
  return async (label, url, init, timeoutMs) => {
    const controller = new AbortController();
    let didTimeout = false;
    const timer = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (didTimeout) {
        throw new MigrationTransportError(
          `${label} timed out after ${timeoutMs}ms (${url})`,
          { cause: err },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationTransportError(`${label} transport failed: ${message}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }
  };
}

// gatewayId is the pod the call addresses: the signature is scoped to it so a pod
// cannot relay a call it received to a sibling gateway. transportId addresses the
// K8s Service (a revision), which is why the two are separate.
interface SignedGatewayPost {
  transportId: string;
  path: string;
  gatewayId: string;
  migrationId: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}

function createSignedJsonPoster(deps: {
  privateKey: string;
  resolveGatewayUrl: (transportId: string) => string;
  fetchWithTimeout: FetchWithTimeout;
}): <Resp>(request: SignedGatewayPost) => Promise<Resp> {
  return async <Resp>(request: SignedGatewayPost): Promise<Resp> => {
    const { path, timeoutMs } = request;
    const rawBody = JSON.stringify(request.body);
    const signature = signFleetRequest(
      deps.privateKey,
      gatewayScopedJobId(request.migrationId, request.gatewayId),
      rawBody,
    );
    const res = await deps.fetchWithTimeout(
      path,
      `${deps.resolveGatewayUrl(request.transportId)}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      },
      timeoutMs,
    );
    if (!res.ok) throw await migrationRpcError(path, res);
    try {
      return (await res.json()) as Resp;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new MigrationTransportError(`${path} response body was incomplete: ${message}`, {
        cause: err,
      });
    }
  };
}

export function createMigrationClient(deps: MigrationClientDeps): MigrationClient {
  const log = deps.log ?? (() => undefined);
  const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
  const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
  const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
  const postSignedJson = createSignedJsonPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });

  return {
    async abortImport({ migrationId, gatewayId, slug, mode }) {
      const result = await postSignedJson<ImportResponse>({
        transportId: gatewayId, path: `/abort-rsync-import/${gatewayId}`, gatewayId, migrationId,
        body: { migrationId, slug, mode, rpcPhase: "abort-rsync-import" }, timeoutMs: unmountMs,
      });
      if (result.migrationId !== migrationId || result.slug !== slug || result.imported !== false) {
        throw new Error("import cleanup acknowledgement mismatch");
      }
    },
    async scheduler({ gatewayId, transportId, ...body }) {
      const result = await postSignedJson<SchedulerMigrationResult>({
        transportId: transportId ?? gatewayId,
        path: `/scheduler/${gatewayId}`,
        gatewayId,
        migrationId: body.migrationId,
        body,
        timeoutMs: quiesceMs,
      });
      if (result.operationId !== body.migrationId || result.phase !== body.phase ||
          !Array.isArray(result.agentIds) || result.agentIds.some(id => typeof id !== "string" || !id) ||
          (result.agentIds.length === 0 && body.phase !== "resume" && body.phase !== "abort") ||
          result.drained !== true || (body.phase === "export" && result.snapshot === undefined)) {
        throw new Error(`scheduler ${body.phase} did not prove a drained matching operation`);
      }
      return result;
    },
    async schedulerReady({ migrationId, gatewayId, transportId, slug }) {
      const result = await postSignedJson<{ ready?: unknown }>({
        transportId: transportId ?? gatewayId,
        path: `/scheduler-ready/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug },
        timeoutMs: quiesceMs,
      });
      if (result.ready !== true) throw new Error(`/scheduler-ready/${gatewayId} did not confirm readiness`);
    },
    async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot, resume }) {
      const res = await postSignedJson<RestoreMigrationResponse>({
        transportId: transportId ?? gatewayId,
        path: `/${resume === true ? "resume-restore" : "restore"}/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, uid, slug, snapshot },
        timeoutMs: transferMs,
      });
      log(
        `[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`,
      );
      return res;
    },

    async resume({ migrationId, gatewayId, transportId, slug }) {
      const response = await postSignedJson<{ resumed: boolean }>({
        transportId: transportId ?? gatewayId, path: `/resume/${gatewayId}`,
        gatewayId, migrationId, body: { migrationId, slug }, timeoutMs: quiesceMs,
      });
      if (response.resumed !== true) throw new Error(`source ingress did not resume for ${slug}`);
    },

    async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs, stopMattermost, schedulerHandoff, schedulerMigrationId, retainNonportable }) {
      const handoff = schedulerHandoff
        ? { schedulerHandoff: true, schedulerMigrationId: schedulerMigrationId ?? migrationId, ...(retainNonportable ? { retainNonportable: true } : {}) }
        : {};
      const res = await postSignedJson<QuiesceResponse>({
        transportId: transportId ?? gatewayId,
        path: `/quiesce/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug, ...(timeoutMs == null ? {} : { timeoutMs }), ...(stopMattermost === undefined ? {} : { stopMattermost }), ...handoff },
        timeoutMs: Math.max(quiesceMs, (timeoutMs ?? MIGRATION_QUIESCE_TIMEOUT_MS) + 30_000),
      });
      if (!res.drained) {
        throw new MigrationDrainPendingError(
          `quiesce did not drain: ${res.runningCount} still running on ${gatewayId} for slug=${slug}`,
        );
      }
      log(`[migration-client] ✅ quiesce ok migrationId=${migrationId} slug=${slug}`);
      return res;
    },

    async flushGateway({
      migrationId,
      gatewayId,
      transportId,
      slug,
      reason,
      expectedSystemConfigCommit,
    }) {
      const res = await postSignedJson<FlushGatewayResponse>({
        transportId: transportId ?? gatewayId,
        path: `/flush/${gatewayId}`,
        gatewayId,
        migrationId,
        body: {
          migrationId,
          slug,
          reason,
          ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
        },
        timeoutMs: transferMs,
      });
      log(
        `[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`,
      );
      return res;
    },

    async unmount({ migrationId, gatewayId, transportId, slug }) {
      const res = await postSignedJson<UnmountResponse>({
        transportId: transportId ?? gatewayId,
        path: `/unmount/${gatewayId}`,
        gatewayId,
        migrationId,
        body: { migrationId, slug },
        timeoutMs: unmountMs,
      });
      if (res.migrationId !== migrationId || res.slug !== slug || typeof res.unmounted !== "boolean") {
        throw new Error("unmount cleanup acknowledgement mismatch");
      }
      log(
        `[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`,
      );
      return res;
    },

    finishAgentContextRestore: async input => {
      if (!deps.finishAgentContextRestore) throw new Error("Shared agent context restoration is unavailable");
      return deps.finishAgentContextRestore(input);
    },
    transferState: deps.transferState,

    async verifyTarget({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
      const requestTimeoutMs =
        timeoutMs == null ? verifyMs : Math.max(verifyMs, timeoutMs + 30_000);
      const res = await postSignedJson<VerifyMigrationResponse>({
        transportId: transportId ?? gatewayId,
        path: `/verify/${gatewayId}`,
        gatewayId,
        migrationId,
        body: timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs },
        timeoutMs: requestTimeoutMs,
      });
      if (!res.ready) {
        throw new Error(
          `target verify failed on ${gatewayId} for slug=${slug}: ${JSON.stringify(res.checks)}`,
        );
      }
      log(
        `[migration-client] ✅ verifyTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId}`,
      );
      return res;
    },
  };
}

async function migrationRpcError(path: string, response: Response): Promise<MigrationRpcError> {
  const text = await response.text().catch(() => "<no body>");
  let details: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      details = parsed as Record<string, unknown>;
    }
  } catch {
    details = {};
  }
  const options: MigrationRpcErrorOptions = { status: response.status, details };
  if (typeof details.code === "string") options.code = details.code;
  return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}

export async function reportMigrationProgress(
  deps: Pick<MigrationClientDeps, "privateKey" | "resolveGatewayUrl" | "fetch">,
  gatewayId: string,
  body: MigrationProgressRequestBody,
): Promise<void> {
  const post = createSignedJsonPoster({
    privateKey: deps.privateKey,
    resolveGatewayUrl: deps.resolveGatewayUrl,
    fetchWithTimeout: createFetchWithTimeout(deps.fetch ?? globalThis.fetch),
  });
  await post({
    transportId: gatewayId,
    path: `/migration-progress/${gatewayId}`,
    gatewayId,
    migrationId: body.migrationId,
    body: { ...body },
    timeoutMs: 2_000,
  });
}

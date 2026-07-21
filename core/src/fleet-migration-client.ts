

import { signFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  type FlushGatewayResponse,
  type ImportResponse,
  type QuiesceResponse,
  type RestoreMigrationResponse,
  type UnmountResponse,
  type VerifyMigrationResponse,
} from "@octogee/shared/types/fleet-controller";
import type { FleetBrokerUserSnapshot } from "@octogee/shared/types/fleet-broker";
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
}

// `gatewayId` is the TENANT path id — bare, put in the in-pod URL path and
// matched by the pod's GATEWAY_ID guard. `transportId` defaults to the bare
// gatewayId; simple-roll has one stable Service per gateway, so tenant and
// transport are the same name (GATEWAY-SIMPLE-ROLL-SPEC).
export interface MigrationClient {
  quiesce(opts: {
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
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    uid: string;
    slug: string;
    snapshot: FleetBrokerUserSnapshot;
  }): Promise<RestoreMigrationResponse>;

  transferState(opts: {
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    fromTransportId?: string;
    toTransportId?: string;
    slug: string;
    mode?: MigrationSyncMode;
    includeActivationManifest?: boolean;
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
  status?: number;
  code?: string;
}

export class MigrationRpcError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, options: MigrationRpcErrorOptions = {}) {
    super(message);
    this.name = "MigrationRpcError";
    this.status = options.status;
    this.code = options.code;
  }
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

export function createMigrationClient(deps: MigrationClientDeps): MigrationClient {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => undefined);
  const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
  const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
  const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;

  const fetchWithTimeout = async (
    label: string,
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> => {
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

  const postSignedJson = async <Resp>(
    transportId: string,
    path: string,
    migrationId: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Resp> => {
    const rawBody = JSON.stringify(body);
    const signature = signFleetRequest(deps.privateKey, migrationId, rawBody);
    const url = `${deps.resolveGatewayUrl(transportId)}${path}`;
    const res = await fetchWithTimeout(
      path,
      url,
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

  return {
    async restoreTarget({ migrationId, gatewayId, transportId, uid, slug, snapshot }) {
      const res = await postSignedJson<RestoreMigrationResponse>(
        transportId ?? gatewayId,
        `/restore/${gatewayId}`,
        migrationId,
        { migrationId, uid, slug, snapshot },
        transferMs,
      );
      log(
        `[migration-client] ✅ restoreTarget migrationId=${migrationId} slug=${slug} gateway=${gatewayId} steps=${res.steps.join(",")}`,
      );
      return res;
    },

    async quiesce({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
      const res = await postSignedJson<QuiesceResponse>(
        transportId ?? gatewayId,
        `/quiesce/${gatewayId}`,
        migrationId,
        timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs },
        quiesceMs,
      );
      if (!res.drained) {
        throw new Error(
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
      const res = await postSignedJson<FlushGatewayResponse>(
        transportId ?? gatewayId,
        `/flush/${gatewayId}`,
        migrationId,
        {
          migrationId,
          slug,
          reason,
          ...(expectedSystemConfigCommit ? { expectedSystemConfigCommit } : {}),
        },
        transferMs,
      );
      log(
        `[migration-client] ✅ flushGateway migrationId=${migrationId} slug=${slug} gateway=${gatewayId} ok=${res.ok}`,
      );
      return res;
    },

    async unmount({ migrationId, gatewayId, transportId, slug }) {
      const res = await postSignedJson<UnmountResponse>(
        transportId ?? gatewayId,
        `/unmount/${gatewayId}`,
        migrationId,
        { migrationId, slug },
        unmountMs,
      );
      log(
        `[migration-client] ✅ unmount migrationId=${migrationId} slug=${slug} wasMounted=${res.unmounted}`,
      );
      return res;
    },

    async transferState({ migrationId, fromGatewayId, toGatewayId, fromTransportId, toTransportId, slug, mode, includeActivationManifest }) {
      const targetUrl = deps.resolveGatewayUrl(toTransportId ?? toGatewayId);
      const targetImportSignature = signFleetRequest(deps.privateKey, migrationId, slug);
      const parsed = await postSignedJson<ImportResponse>(
        fromTransportId ?? fromGatewayId,
        `/push-state/${fromGatewayId}`,
        migrationId,
        {
          migrationId,
          slug,
          targetGatewayId: toGatewayId,
          targetUrl,
          targetImportSignature,
          ...(mode ? { mode } : {}),
          ...(includeActivationManifest ? { includeActivationManifest: true } : {}),
        },
        transferMs,
      );
      log(
        `[migration-client] ✅ transferState mode=${mode ?? "default"} migrationId=${migrationId} slug=${slug} ${fromGatewayId} → ${toGatewayId}`,
      );
      return parsed;
    },

    async verifyTarget({ migrationId, gatewayId, transportId, slug, timeoutMs }) {
      const requestTimeoutMs =
        timeoutMs == null ? verifyMs : Math.max(verifyMs, timeoutMs + 30_000);
      const res = await postSignedJson<VerifyMigrationResponse>(
        transportId ?? gatewayId,
        `/verify/${gatewayId}`,
        migrationId,
        timeoutMs == null ? { migrationId, slug } : { migrationId, slug, timeoutMs },
        requestTimeoutMs,
      );
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
  const options: MigrationRpcErrorOptions = { status: response.status };
  if (typeof details.code === "string") options.code = details.code;
  return new MigrationRpcError(`${path}: ${response.status} ${text}`, options);
}

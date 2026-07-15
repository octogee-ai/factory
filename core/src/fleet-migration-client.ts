

import { signFleetRequest } from "./fleet-signature.js";
import { randomUUID } from "node:crypto";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  type FlushGatewayResponse,
  type ConfigFreezeResponse,
  type ConfigRestoreProofResponse,
  type ConfigUnfreezeResponse,
  type ImportResponse,
  type QuiesceResponse,
  type RestoreMigrationResponse,
  type UnmountResponse,
  type VerifyMigrationResponse,
  SYSTEM_CONFIG_FREEZE_OWNED,
  SYSTEM_CONFIG_FREEZE_SCOPE_MISMATCH,
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

  now?: () => number;
  genRequestId?: () => string;

}

// Transport/tenant split (GATEWAY-RELEASES-SPEC): `gatewayId` is the TENANT path
// id — bare, put in the in-pod URL path and matched by the pod's GATEWAY_ID
// guard. `transportId` is the TRANSPORT target — the revision service name
// ({gw}-r{n}) resolveGatewayUrl maps to a K8s Service URL. When transportId is
// omitted it defaults to gatewayId (legacy single-revision behavior). During a
// same-gateway roll both revisions share the bare gatewayId but differ by
// transportId, so source and target resolve to distinct URLs.
export interface MigrationClient {
  freezeConfig(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
  }): Promise<ConfigFreezeResponse>;

  proveConfigRestore(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    checkpointCommit: string;
  }): Promise<ConfigRestoreProofResponse>;

  reproveConfigRestore(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
    checkpointCommit: string;
  }): Promise<ConfigRestoreProofResponse>;

  unfreezeConfig(opts: {
    migrationId: string;
    gatewayId: string;
    transportId?: string;
    slug: string;
  }): Promise<ConfigUnfreezeResponse>;

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
  ownerMigrationId?: string;
  slug?: string;
}

export class MigrationRpcError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly ownerMigrationId?: string;
  readonly slug?: string;

  constructor(message: string, options: MigrationRpcErrorOptions = {}) {
    super(message);
    this.name = "MigrationRpcError";
    this.status = options.status;
    this.code = options.code;
    this.ownerMigrationId = options.ownerMigrationId;
    this.slug = options.slug;
  }
}

export function isDefinitiveConfigRpcRejection(error: unknown): boolean {
  if (!(error instanceof MigrationRpcError)) return false;
  if (
    error.code === SYSTEM_CONFIG_FREEZE_OWNED ||
    error.code === SYSTEM_CONFIG_FREEZE_SCOPE_MISMATCH
  ) {
    return true;
  }
  return error.status === 404 || error.status === 501;
}

export function isDefinitiveFreezeRejection(error: unknown): boolean {
  return error instanceof MigrationRpcError &&
    (error.status === 501 ||
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429);
}

export function isFreezeOwnerConflict(
  error: unknown,
): error is MigrationRpcError & { ownerMigrationId: string; slug: string } {
  return error instanceof MigrationRpcError &&
    error.code === SYSTEM_CONFIG_FREEZE_OWNED &&
    typeof error.ownerMigrationId === "string" &&
    error.ownerMigrationId.length > 0 &&
    typeof error.slug === "string" &&
    error.slug.length > 0;
}

function assertConfigResponseBinding(
  response: { migrationId: string; slug: string },
  migrationId: string,
  slug: string,
): void {
  if (response.migrationId !== migrationId || response.slug !== slug) {
    throw new Error("malformed config response binding");
  }
}

export function createMigrationClient(deps: MigrationClientDeps): MigrationClient {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => undefined);
  const quiesceMs = deps.timeouts?.quiesceMs ?? MIGRATION_QUIESCE_TIMEOUT_MS;
  const transferMs = deps.timeouts?.transferMs ?? MIGRATION_TRANSFER_TIMEOUT_MS;
  const unmountMs = deps.timeouts?.unmountMs ?? MIGRATION_UNMOUNT_TIMEOUT_MS;
  const verifyMs = deps.timeouts?.verifyMs ?? MIGRATION_VERIFY_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  const genRequestId = deps.genRequestId ?? (() => randomUUID().replaceAll("-", ""));
  const configMutationBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const issuedAt = now();
    return {
      ...body,
      issuedAt,
      expiresAt: issuedAt + 30_000,
      requestId: genRequestId(),
    };
  };

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
        throw new Error(`${label} timed out after ${timeoutMs}ms (${url})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  // `transportId` resolves the K8s Service URL (revision); `path` already
  // carries the bare tenant gatewayId — the two are deliberately independent.
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
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      let details: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          details = parsed as Record<string, unknown>;
        }
      } catch {
        details = {};
      }
      throw new MigrationRpcError(`${path}: ${res.status} ${text}`, {
        status: res.status,
        ...(typeof details.code === "string" ? { code: details.code } : {}),
        ...(typeof details.ownerMigrationId === "string"
          ? { ownerMigrationId: details.ownerMigrationId }
          : {}),
        ...(typeof details.slug === "string" ? { slug: details.slug } : {}),
      });
    }
    return (await res.json()) as Resp;
  };

  return {
    async freezeConfig({ migrationId, gatewayId, transportId, slug }) {
      const response = await postSignedJson<ConfigFreezeResponse>(
        transportId ?? gatewayId,
        `/config-freeze/${gatewayId}`,
        migrationId,
        configMutationBody({ action: "freeze", migrationId, slug }),
        transferMs,
      );
      assertConfigResponseBinding(response, migrationId, slug);
      if (
        response.frozen !== true ||
        !/^[0-9a-f]{40}$/.test(response.checkpointCommit) ||
        !/^[0-9a-f]{64}$/.test(response.configHash)
      ) {
        throw new Error("malformed config checkpoint response");
      }
      log(
        `[migration-client] config checkpoint migrationId=${migrationId} commit=${response.checkpointCommit}`,
      );
      return response;
    },

    async proveConfigRestore({ migrationId, gatewayId, transportId, slug, checkpointCommit }) {
      const response = await postSignedJson<ConfigRestoreProofResponse>(
        transportId ?? gatewayId,
        `/config-restore-proof/${gatewayId}`,
        migrationId,
        configMutationBody({
          action: "restore-proof",
          migrationId,
          slug,
          checkpointCommit,
        }),
        transferMs,
      );
      assertConfigResponseBinding(response, migrationId, slug);
      if (
        !/^[0-9a-f]{40}$/.test(response.restoredCommit) ||
        !/^[0-9a-f]{40}$/.test(response.acceptedCommit) ||
        !/^[0-9a-f]{64}$/.test(response.configHash) ||
        response.configReady !== true ||
        response.observedRevisionId !== (transportId ?? gatewayId) ||
        !Number.isFinite(response.restoreProvenAt) ||
        !Number.isFinite(response.configReadyAt) ||
        response.configReadyAt < response.restoreProvenAt ||
        typeof response.runtimeConfigHash !== "string" ||
        response.runtimeConfigHash.length === 0
      ) {
        throw new Error("malformed config restore proof response");
      }
      log(
        `[migration-client] config restore proof migrationId=${migrationId} restored=${response.restoredCommit} accepted=${response.acceptedCommit}`,
      );
      return response;
    },

    async reproveConfigRestore({ migrationId, gatewayId, transportId, slug, checkpointCommit }) {
      const response = await postSignedJson<ConfigRestoreProofResponse>(
        transportId ?? gatewayId,
        `/config-restore-proof/${gatewayId}`,
        migrationId,
        configMutationBody({
          action: "restore-proof",
          migrationId,
          slug,
          checkpointCommit,
          proofOnly: true,
        }),
        transferMs,
      );
      assertConfigResponseBinding(response, migrationId, slug);
      if (
        !/^[0-9a-f]{40}$/.test(response.restoredCommit) ||
        !/^[0-9a-f]{40}$/.test(response.acceptedCommit) ||
        !/^[0-9a-f]{64}$/.test(response.configHash) ||
        response.configReady !== true ||
        response.observedRevisionId !== (transportId ?? gatewayId) ||
        !Number.isFinite(response.restoreProvenAt) ||
        !Number.isFinite(response.configReadyAt) ||
        response.configReadyAt < response.restoreProvenAt ||
        typeof response.runtimeConfigHash !== "string" ||
        response.runtimeConfigHash.length === 0
      ) {
        throw new Error("malformed config reproof response");
      }
      log(
        `[migration-client] config restore reproof migrationId=${migrationId} accepted=${response.acceptedCommit}`,
      );
      return response;
    },

    async unfreezeConfig({ migrationId, gatewayId, transportId, slug }) {
      const response = await postSignedJson<ConfigUnfreezeResponse>(
        transportId ?? gatewayId,
        `/config-unfreeze/${gatewayId}`,
        migrationId,
        configMutationBody({ action: "unfreeze", migrationId, slug }),
        transferMs,
      );
      assertConfigResponseBinding(response, migrationId, slug);
      if (response.unfrozen !== true) {
        throw new Error("config unfreeze was not confirmed");
      }
      log(`[migration-client] config unfreeze migrationId=${migrationId}`);
      return response;
    },

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

    async flushGateway({ migrationId, gatewayId, transportId, slug, reason }) {
      const res = await postSignedJson<FlushGatewayResponse>(
        transportId ?? gatewayId,
        `/flush/${gatewayId}`,
        migrationId,
        { migrationId, slug, reason },
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

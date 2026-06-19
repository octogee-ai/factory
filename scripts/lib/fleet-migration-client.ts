

import { signFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  MIGRATION_VERIFY_TIMEOUT_MS,
  type ImportResponse,
  type QuiesceResponse,
  type RestoreMigrationResponse,
  type UnmountResponse,
  type VerifyMigrationResponse,
} from "../../shared/types/fleet-controller.js";
import type { FleetBrokerUserSnapshot } from "../../shared/types/fleet-broker.js";
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

export interface MigrationClient {
  quiesce(opts: {
    migrationId: string;
    gatewayId: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<QuiesceResponse>;

  restoreTarget(opts: {
    migrationId: string;
    gatewayId: string;
    uid: string;
    slug: string;
    snapshot: FleetBrokerUserSnapshot;
  }): Promise<RestoreMigrationResponse>;

  transferState(opts: {
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    slug: string;
    mode?: MigrationSyncMode;
    includeActivationManifest?: boolean;
  }): Promise<ImportResponse>;

  verifyTarget(opts: {
    migrationId: string;
    gatewayId: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<VerifyMigrationResponse>;

  unmount(opts: {
    migrationId: string;
    gatewayId: string;
    slug: string;
  }): Promise<UnmountResponse>;
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
        throw new Error(`${label} timed out after ${timeoutMs}ms (${url})`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };

  const postSignedJson = async <Resp>(
    gatewayId: string,
    path: string,
    migrationId: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Resp> => {
    const rawBody = JSON.stringify(body);
    const signature = signFleetRequest(deps.privateKey, migrationId, rawBody);
    const url = `${deps.resolveGatewayUrl(gatewayId)}${path}`;
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
      throw new Error(`${path}: ${res.status} ${text}`);
    }
    return (await res.json()) as Resp;
  };

  return {
    async restoreTarget({ migrationId, gatewayId, uid, slug, snapshot }) {
      const res = await postSignedJson<RestoreMigrationResponse>(
        gatewayId,
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

    async quiesce({ migrationId, gatewayId, slug, timeoutMs }) {
      const res = await postSignedJson<QuiesceResponse>(
        gatewayId,
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

    async unmount({ migrationId, gatewayId, slug }) {
      const res = await postSignedJson<UnmountResponse>(
        gatewayId,
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

    async transferState({ migrationId, fromGatewayId, toGatewayId, slug, mode, includeActivationManifest }) {
      const targetUrl = deps.resolveGatewayUrl(toGatewayId);
      const targetImportSignature = signFleetRequest(deps.privateKey, migrationId, slug);
      const parsed = await postSignedJson<ImportResponse>(
        fromGatewayId,
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

    async verifyTarget({ migrationId, gatewayId, slug, timeoutMs }) {
      const requestTimeoutMs =
        timeoutMs == null ? verifyMs : Math.max(verifyMs, timeoutMs + 30_000);
      const res = await postSignedJson<VerifyMigrationResponse>(
        gatewayId,
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

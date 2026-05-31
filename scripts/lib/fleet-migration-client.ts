

import { signFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_QUIESCE_TIMEOUT_MS,
  MIGRATION_TRANSFER_TIMEOUT_MS,
  MIGRATION_UNMOUNT_TIMEOUT_MS,
  type ImportResponse,
  type QuiesceResponse,
  type UnmountResponse,
} from "../../shared/types/fleet-controller.js";

export interface MigrationClientTimeouts {
  quiesceMs?: number;
  transferMs?: number;
  unmountMs?: number;
}

export interface MigrationClientDeps {
  
  secret: string;
  
  resolveGatewayUrl: (gatewayId: string) => string;
  
  fetch?: typeof globalThis.fetch;
  
  log?: (msg: string) => void;
  
  timeouts?: MigrationClientTimeouts;

  resolveRequestSecret?: (gatewayId: string) => Promise<string>;
}

export interface MigrationClient {
  quiesce(opts: {
    migrationId: string;
    gatewayId: string;
    slug: string;
    timeoutMs?: number;
  }): Promise<QuiesceResponse>;

  transferState(opts: {
    migrationId: string;
    fromGatewayId: string;
    toGatewayId: string;
    slug: string;
    includeActivationManifest?: boolean;
  }): Promise<ImportResponse>;

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
    const requestSecret = deps.resolveRequestSecret
      ? await deps.resolveRequestSecret(gatewayId)
      : deps.secret;
    const signature = signFleetRequest(requestSecret, migrationId, rawBody);
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

    async transferState({ migrationId, fromGatewayId, toGatewayId, slug, includeActivationManifest }) {
      const targetUrl = deps.resolveGatewayUrl(toGatewayId);
      const targetSecret = deps.resolveRequestSecret
        ? await deps.resolveRequestSecret(toGatewayId)
        : deps.secret;
      const targetImportSignature = signFleetRequest(targetSecret, migrationId, slug);
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
          ...(includeActivationManifest ? { includeActivationManifest: true } : {}),
        },
        transferMs,
      );
      log(
        `[migration-client] ✅ transferState migrationId=${migrationId} slug=${slug} ${fromGatewayId} → ${toGatewayId}`,
      );
      return parsed;
    },
  };
}

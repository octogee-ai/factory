

import { signFleetRequest } from "./fleet-signature.js";
import {
  SIGNATURE_HEADER,
  MIGRATION_ID_HEADER,
  MIGRATION_SLUG_HEADER,
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
    const signature = signFleetRequest(deps.secret, migrationId, rawBody);
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

    async transferState({ migrationId, fromGatewayId, toGatewayId, slug }) {

const exportRawBody = JSON.stringify({ migrationId, slug });
      const exportSig = signFleetRequest(deps.secret, migrationId, exportRawBody);
      const exportUrl = `${deps.resolveGatewayUrl(fromGatewayId)}/export/${fromGatewayId}`;
      const exportRes = await fetchWithTimeout(
        "export",
        exportUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: exportSig,
          },
          body: exportRawBody,
        },
        transferMs,
      );
      if (!exportRes.ok) {
        const text = await exportRes.text().catch(() => "<no body>");
        throw new Error(`export: ${exportRes.status} ${text}`);
      }

const importSig = signFleetRequest(deps.secret, migrationId, slug);
      const importUrl = `${deps.resolveGatewayUrl(toGatewayId)}/import/${toGatewayId}`;
      const importRes = await fetchWithTimeout(
        "import",
        importUrl,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-tar",
            [SIGNATURE_HEADER]: importSig,
            [MIGRATION_ID_HEADER]: migrationId,
            [MIGRATION_SLUG_HEADER]: slug,
          },
          body: exportRes.body,
          duplex: "half",
        } as RequestInit & { duplex: "half" },
        transferMs,
      );
      if (!importRes.ok) {
        const text = await importRes.text().catch(() => "<no body>");
        throw new Error(`import: ${importRes.status} ${text}`);
      }
      const parsed = (await importRes.json()) as ImportResponse;
      log(
        `[migration-client] ✅ transferState migrationId=${migrationId} slug=${slug} ${fromGatewayId} → ${toGatewayId}`,
      );
      return parsed;
    },
  };
}

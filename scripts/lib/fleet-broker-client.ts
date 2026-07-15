import type {
  FleetBrokerBlobSignedUrl,
  FleetBrokerGreetingResult,
  FleetBrokerMattermostUpdate,
  FleetBrokerPreStopFlushEvent,
  FleetBrokerProvisioningStatus,
  FleetBrokerUsageData,
  FleetBrokerUserSnapshot,
} from "../../shared/types/fleet-broker.js";
import { internalFetch } from "./internal-fetch.js";
import type { SystemConfigObservedStatus } from "./system-config-status.js";

function baseUrl(): string {
  if (process.env.FLEET_BROKER_URL) return process.env.FLEET_BROKER_URL;
  // In-cluster service URL; the projected gateway KSA token is the auth boundary.
  return process.env.OCTOGEE_API_URL || "http://octogee-api.octogee.svc.cluster.local:3001";
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`fleet-broker POST ${path} → ${resp.status} ${text}`);
  }
  return (await resp.json()) as T;
}

async function postNoContent(path: string, body: unknown): Promise<void> {
  const resp = await internalFetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`fleet-broker POST ${path} → ${resp.status} ${text}`);
  }
}

export interface FleetBrokerClient {
  assignedUsers(opts?: { completeOnly?: boolean }): Promise<FleetBrokerUserSnapshot[]>;
  uidForSlug(slug: string): Promise<string | null>;
  userSnapshot(uid: string): Promise<FleetBrokerUserSnapshot | null>;
  setProvisioningStatus(
    uid: string,
    status: Exclude<FleetBrokerProvisioningStatus, "">,
  ): Promise<void>;
  setRepoUrl(uid: string, repoUrl: string): Promise<void>;
  provisionMattermost(uid: string): Promise<FleetBrokerMattermostUpdate>;
  setMattermostFields(uid: string, mmUpdate: FleetBrokerMattermostUpdate): Promise<void>;
  setGreetingResult(uid: string, result: FleetBrokerGreetingResult): Promise<void>;
  setAgentIds(uid: string, agentIds: string[]): Promise<void>;
  setMounted(uid: string, mounted: boolean): Promise<void>;
  recordReconcileError(slug: string, message: string): Promise<void>;
  clearReconcileError(slug: string): Promise<void>;
  notifySignup(uid: string): Promise<void>;
  recordUsageEvent(input: {
    agentId: string;
    usage: FleetBrokerUsageData;
  }): Promise<void>;
  recordPreStopFlush(input: FleetBrokerPreStopFlushEvent): Promise<void>;
  recordSystemConfigStatus(input: SystemConfigObservedStatus): Promise<void>;
  blobDownloadUrl(input: {
    slug: string;
    path: string;
  }): Promise<FleetBrokerBlobSignedUrl>;
  blobUploadUrl(input: {
    slug: string;
    path: string;
    mimeType: string;
    size: number;
  }): Promise<FleetBrokerBlobSignedUrl>;
}

// `revisionId` ({gw}-r{n}) makes the roster (mount driver) revision-aware: the
// broker filters the assigned-users set to this pod's revision so two revisions
// of one rolling gateway never both mount the full roster. Empty on legacy pods.
export function createFleetBrokerClient(gatewayId: string, revisionId = ""): FleetBrokerClient {
  return {
    async assignedUsers(opts = {}) {
      const data = await postJson<{ users: FleetBrokerUserSnapshot[] }>(
        "/internal/fleet/assigned-users",
        { gatewayId, revisionId, completeOnly: opts.completeOnly === true },
      );
      return data.users;
    },
    async uidForSlug(slug) {
      try {
        const data = await postJson<{ uid: string }>("/internal/fleet/uid-for-slug", {
          gatewayId,
          slug,
        });
        return data.uid;
      } catch (err) {
        if (err instanceof Error && err.message.includes("→ 404")) return null;
        throw err;
      }
    },
    async userSnapshot(uid) {
      try {
        const data = await postJson<{ user: FleetBrokerUserSnapshot }>(
          "/internal/fleet/user-snapshot",
          { gatewayId, uid },
        );
        return data.user;
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message.includes("→ 404") || err.message.includes("→ 403"))
        ) {
          return null;
        }
        throw err;
      }
    },
    setProvisioningStatus(uid, status) {
      return postNoContent("/internal/fleet/set-provisioning-status", {
        gatewayId,
        uid,
        status,
      });
    },
    setRepoUrl(uid, repoUrl) {
      return postNoContent("/internal/fleet/set-repo-url", { gatewayId, uid, repoUrl });
    },
    async provisionMattermost(uid) {
      const data = await postJson<{ mmUpdate: FleetBrokerMattermostUpdate }>(
        "/internal/fleet/provision-mattermost",
        { gatewayId, uid },
      );
      return data.mmUpdate;
    },
    setMattermostFields(uid, mmUpdate) {
      return postNoContent("/internal/fleet/set-mattermost-fields", {
        gatewayId,
        uid,
        mmUpdate,
      });
    },
    setGreetingResult(uid, result) {
      return postNoContent("/internal/fleet/set-greeting-result", {
        gatewayId,
        uid,
        result,
      });
    },
    setAgentIds(uid, agentIds) {
      return postNoContent("/internal/fleet/set-agent-ids", { gatewayId, uid, agentIds });
    },
    setMounted(uid, mounted) {
      return postNoContent("/internal/fleet/mounted", { gatewayId, uid, mounted });
    },
    recordReconcileError(slug, message) {
      return postNoContent("/internal/fleet/reconcile-error", { gatewayId, slug, message });
    },
    clearReconcileError(slug) {
      return postNoContent("/internal/fleet/clear-reconcile-error", { gatewayId, slug });
    },
    notifySignup(uid) {
      return postNoContent("/internal/fleet/notify-signup", { gatewayId, uid });
    },
    recordUsageEvent(input) {
      return postNoContent("/internal/fleet/usage-event", { gatewayId, ...input });
    },
    recordPreStopFlush(input) {
      return postNoContent("/internal/fleet/prestop-flush", { gatewayId, ...input });
    },
    recordSystemConfigStatus(status) {
      return postNoContent("/internal/fleet/system-config-status", {
        gatewayId,
        revisionId,
        status,
      });
    },
    blobDownloadUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/blob/download-url",
        { gatewayId, ...input },
      );
    },
    blobUploadUrl(input) {
      return postJson<FleetBrokerBlobSignedUrl>(
        "/internal/fleet/blob/upload-url",
        { gatewayId, ...input },
      );
    },
  };
}

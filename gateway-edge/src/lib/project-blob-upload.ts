import { createHash } from "node:crypto";
import { gatewayCredentialHeaders, internalFetch, sidecarBrokerHeaders } from "@octogee/core/internal-fetch";
import type { FleetBrokerBlobSignedUrl } from "@octogee/shared/types/fleet-broker";
import type { ProjectBlobHydrationClient } from "@octogee/core/project-blob-materialization";
import type { StoredWorkspaceBlob, WorkspaceBlobTarget } from "./workspace-blob.js";

async function brokerRequest<T>(base: string, route: string, body: object, headers: Record<string, string>): Promise<T> {
  const response = await internalFetch(`${base.replace(/\/$/u, "")}/internal/fleet/blob/${route}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ gatewayId: process.env.GATEWAY_ID, ...body }),
  });
  if (!response.ok) throw new Error(`project asset ${route} failed: HTTP ${response.status}`);
  return response.json();
}

function assertUploadCapability(upload: FleetBrokerBlobSignedUrl, gcsPath: string, md5Hash: string, size: number): void {
  const url = new URL(upload.url);
  if (upload.gcsPath !== gcsPath || upload.method !== "PUT" || url.protocol !== "https:" ||
    url.hostname !== "storage.googleapis.com" || url.username || url.password ||
    upload.requiredHeaders?.["x-goog-if-generation-match"] !== "0" ||
    upload.requiredHeaders?.["content-md5"] !== md5Hash || upload.requiredHeaders?.["content-length"] !== String(size)) {
    throw new Error("project asset upload identity mismatch");
  }
}

export async function uploadProjectBlobViaBroker(base: string, target: WorkspaceBlobTarget, contents: Buffer, mimeType: string): Promise<StoredWorkspaceBlob> {
  if (!target.projectSlug || target.gcsPrefix !== `customers/${target.slug}/projects/${target.projectSlug}`) throw new Error("invalid project asset scope");
  const sha256 = createHash("sha256").update(contents).digest("hex");
  // eslint-disable-next-line sonarjs/hashing -- GCS validates Content-MD5 in transit; SHA-256 identifies the immutable object
  const md5Hash = createHash("md5").update(contents).digest("base64");
  const gcsPath = `${target.gcsPrefix}/.objects/${sha256}`;
  const upload: FleetBrokerBlobSignedUrl = await brokerRequest<FleetBrokerBlobSignedUrl>(base, "project/upload-url", {
    slug: target.slug, projectSlug: target.projectSlug, sha256, size: contents.length, md5Hash, mimeType,
  }, await sidecarBrokerHeaders());
  assertUploadCapability(upload, gcsPath, md5Hash, contents.length);
  const response = await fetch(upload.url, {
    method: "PUT", headers: { ...upload.requiredHeaders, "content-type": mimeType },
    body: new Uint8Array(contents), redirect: "error", signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok && response.status !== 412) throw new Error(`project asset upload failed: HTTP ${response.status}`);
  const verified = await brokerRequest<{ download: FleetBrokerBlobSignedUrl; size: number; md5Hash: string; generation: string }>(base, "materialization/read-url", {
    slug: target.slug, path: `projects/${target.projectSlug}/asset`, sha256, size: contents.length,
  }, await gatewayCredentialHeaders());
  if (verified.download?.gcsPath !== gcsPath || verified.size !== contents.length || verified.md5Hash !== md5Hash ||
    typeof verified.generation !== "string" || !/^[1-9]\d{0,19}$/u.test(verified.generation)) {
    throw new Error("project asset upload checksum mismatch");
  }
  return { gcsPath, sha256, size: contents.length };
}

export function projectBlobHydrationClient(base: string): ProjectBlobHydrationClient {
  return {
    workspaceManifestReadUrl: async input => brokerRequest(base, "materialization/manifest/read-url", input, await gatewayCredentialHeaders()),
    blobMaterializationReadUrl: async input => brokerRequest(base, "materialization/read-url", input, await gatewayCredentialHeaders()),
  };
}

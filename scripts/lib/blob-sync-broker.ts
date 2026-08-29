import { readFile, writeFile } from "node:fs/promises";
import {
  ManifestGenerationConflict,
  type ManifestStore,
} from "@octogee/core/workspace-manifest";
import type { BlobStore } from "./blob-sync.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";

async function requireOk(resp: Response, label: string): Promise<void> {
  if (resp.ok) return;
  const text = (await resp.text().catch(() => "")).slice(0, 300);
  throw new Error(`${label} failed: ${resp.status} ${text}`);
}

/**
 * The gateway container holds no GCS credentials, so the broker mints a URL and
 * the pod moves the bytes — the same shape as blob download/upload. The write
 * URL is minted against a specific generation, so a losing write fails at GCS
 * rather than dropping the other writer's entries.
 */
function brokeredManifestStore(client: FleetBrokerClient, slug: string): ManifestStore {
  return {
    async read(objectPath) {
      const signed = await client.workspaceManifestReadUrl({ slug });
      const resp = await fetch(signed.url, { method: signed.method });
      if (resp.status === 404) return null;
      await requireOk(resp, `manifest read ${slug}`);
      const generation = resp.headers.get("x-goog-generation");
      if (!generation) {
        throw new Error(`manifest read ${slug} returned no generation for ${objectPath}`);
      }
      return { contents: await resp.text(), generation };
    },
    async write(objectPath, contents, ifGenerationMatch) {
      const signed = await client.workspaceManifestWriteUrl({ slug, ifGenerationMatch });
      const resp = await fetch(signed.url, {
        method: signed.method,
        headers: { "Content-Type": "application/json" },
        body: contents,
      });
      if (resp.status === 412) throw new ManifestGenerationConflict(objectPath);
      await requireOk(resp, `manifest write ${slug}`);
    },
  };
}

export function createBrokeredBlobStore(client: FleetBrokerClient): BlobStore {
  return {
    manifestFor: (slug) => brokeredManifestStore(client, slug),
    async download(input) {
      const signed = await client.blobDownloadUrl({
        slug: input.slug,
        path: input.relativePath,
      });
      const resp = await fetch(signed.url, { method: signed.method });
      await requireOk(resp, `blob download ${input.slug}/${input.relativePath}`);
      const bytes = Buffer.from(await resp.arrayBuffer());
      await writeFile(input.destination, bytes);
    },
    async upload(input) {
      const signed = await client.blobUploadUrl({
        slug: input.slug,
        path: input.relativePath,
        mimeType: input.mimeType,
        size: input.size,
      });
      const body = await readFile(input.localPath);
      const resp = await fetch(signed.url, {
        method: signed.method,
        headers: { "Content-Type": input.mimeType },
        body,
      });
      await requireOk(resp, `blob upload ${input.slug}/${input.relativePath}`);
    },
  };
}

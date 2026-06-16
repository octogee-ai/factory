import { readFile, writeFile } from "node:fs/promises";
import type { BlobStore } from "./blob-sync.js";
import type { FleetBrokerClient } from "./fleet-broker-client.js";

async function requireOk(resp: Response, label: string): Promise<void> {
  if (resp.ok) return;
  const text = (await resp.text().catch(() => "")).slice(0, 300);
  throw new Error(`${label} failed: ${resp.status} ${text}`);
}

export function createBrokeredBlobStore(client: FleetBrokerClient): BlobStore {
  return {
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

import {
  DeleteObjectCommand, DeleteObjectsCommand, GetBucketVersioningCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand,
  ListObjectVersionsCommand, S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { BlobMetadata, BlobStore } from "../../../gateway-edge/src/lib/blob-store.js";

interface Options {
  bucket: string;
  workspaceBucket: string;
  endpoint: string;
  publicEndpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function conditions(value: string | number | undefined) {
  if (value === undefined) return {};
  return String(value) === "0" ? { IfNoneMatch: "*" } : { IfMatch: String(value) };
}

function metadataOf(item: {
  ContentLength?: number; ETag?: string; VersionId?: string;
}): BlobMetadata {
  const digest = item.ETag?.match(/^"([a-f0-9]{32})"$/u)?.[1];
  return {
    size: String(item.ContentLength ?? ""),
    storage: "s3",
    generation: item.VersionId === "null" ? undefined : item.VersionId,
    md5Hash: digest ? Buffer.from(digest, "hex").toString("base64") : undefined,
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function clientFor(options: Options, endpoint: string): S3Client {
  const { accessKeyId, secretAccessKey, region } = options;
  return new S3Client({
    endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

export function createS3BlobStore(options: Options): BlobStore {
  const { bucket, workspaceBucket } = options;
  if (bucket === workspaceBucket) throw new Error("mutable workspace blobs need a separate unversioned S3 bucket");
  const client = clientFor(options, options.endpoint);
  const signer = options.publicEndpoint && options.publicEndpoint !== options.endpoint
    ? clientFor(options, options.publicEndpoint)
    : client;
  let validatedWorkspace: Promise<void> | undefined;
  async function bucketFor(key: string): Promise<string> {
    const [root, , subtree] = key.split("/", 3);
    if (root !== "customers" || subtree === "projects") return bucket;
    validatedWorkspace ??= client.send(new GetBucketVersioningCommand({ Bucket: workspaceBucket }))
      .then(({ Status }) => {
        if (Status) throw new Error("the S3 workspace bucket must never have had versioning enabled");
      })
      .catch((error: unknown) => {
        validatedWorkspace = undefined;
        throw error;
      });
    await validatedWorkspace;
    return workspaceBucket;
  }
  return {
    async save(Key, Body, options) {
      const Bucket = await bucketFor(Key);
      try {
        await client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType: options.contentType, ...conditions(options.ifGenerationMatch) }));
      } catch (error) {
        if (statusOf(error) === 412 || statusOf(error) === 409) {
          throw Object.assign(new Error("object changed before the conditional write", { cause: error }), { code: 412 });
        }
        throw error;
      }
    },
    async download(Key) {
      const Bucket = await bucketFor(Key);
      try {
        const result = await client.send(new GetObjectCommand({ Bucket, Key }));
        if (!result.Body || !result.ETag) throw new Error("object response has no body or ETag");
        return { bytes: Buffer.from(await result.Body.transformToByteArray()), revision: result.ETag };
      } catch (error) {
        if (statusOf(error) === 404) return null;
        throw error;
      }
    },
    async delete(Key, VersionId) {
      const Bucket = await bucketFor(Key);
      await client.send(new DeleteObjectCommand({ Bucket, Key, VersionId }));
    },
    async deletePrefix(Prefix) {
      if (!Prefix || !Prefix.endsWith("/")) throw new Error("object deletion requires a directory prefix");
      const Bucket = await bucketFor(Prefix);
      for (;;) {
        const page = await client.send(new ListObjectVersionsCommand({ Bucket, Prefix }));
        const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(({ Key, VersionId }) => {
          if (!Key?.startsWith(Prefix) || !VersionId) throw new Error("object version listing returned an invalid deletion target");
          return { Key, VersionId };
        });
        if (!objects.length) {
          if (page.IsTruncated) throw new Error("object version listing returned an empty truncated page");
          return;
        }
        const deleted = await client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } }));
        if (deleted.Errors?.length) throw new Error(`could not delete ${deleted.Errors.length} object versions`);
      }
    },
    async metadata(Key) {
      const Bucket = await bucketFor(Key);
      return metadataOf(await client.send(new HeadObjectCommand({ Bucket, Key })));
    },
    async signedUrl(input, expires) {
      const { gcsPath: Key, contentMd5, contentType, contentLength } = input;
      const Bucket = await bucketFor(Key);
      const expiresIn = Math.max(1, Math.ceil((expires - Date.now()) / 1_000));
      const response = { gcsPath: Key, expiresAt: new Date(expires).toISOString(), storage: "s3" as const };
      if (input.action === "read") {
        const url = await getSignedUrl(signer, new GetObjectCommand({ Bucket, Key, VersionId: input.generation }), { expiresIn });
        return { ...response, url, method: "GET" };
      }
      const headers = {
        ...(contentMd5 ? { "content-md5": contentMd5 } : {}),
        ...(contentType ? { "content-type": contentType } : {}),
        ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
        ...s3ConditionHeaders(input.ifGenerationMatch),
      };
      const command = new PutObjectCommand({
        Bucket, Key, ContentType: contentType, ContentMD5: contentMd5, ContentLength: contentLength,
        ...conditions(input.ifGenerationMatch),
      });
      const url = await getSignedUrl(signer, command, { expiresIn, signableHeaders: new Set(Object.keys(headers)) });
      return { ...response, url, method: "PUT", requiredHeaders: headers };
    },
  };
}

function s3ConditionHeaders(value: number | string | undefined): Record<string, string> {
  if (value === undefined) return {};
  return String(value) === "0" ? { "if-none-match": "*" } : { "if-match": String(value) };
}

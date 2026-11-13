import { createHash } from "node:crypto";
import { S3Client, CreateBucketCommand, ListObjectVersionsCommand, PutBucketVersioningCommand } from "@aws-sdk/client-s3";
import { beforeAll, describe, expect, it } from "vitest";
import { createS3BlobStore } from "./s3-blob-store.js";

const endpoint = process.env.OCTOGEE_TEST_S3_ENDPOINT;
const bucket = "octogee-blob-store-integration";
const workspaceBucket = "octogee-workspace-blobs-integration";
const region = "us-east-1";
const accessKeyId = "fixture-s3-key";
const secretAccessKey = "fixture-s3-secret";

describe.skipIf(!endpoint)("SeaweedFS blob storage", () => {
  const options = { endpoint: endpoint!, bucket, workspaceBucket, region, accessKeyId, secretAccessKey };
  const store = () => createS3BlobStore(options);
  const client = new S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

  beforeAll(async () => {
    for (const name of [bucket, workspaceBucket]) {
      try {
        await client.send(new CreateBucketCommand({ Bucket: name }));
      } catch (error) {
        if (!(error instanceof Error) || error.name !== "BucketAlreadyOwnedByYou") throw error;
      }
    }
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
  });

  it("writes, reads, lists and deletes objects and enforces conditional updates", async () => {
    const blobs = store();
    const key = "workspace/manifest.json";
    const original = Buffer.from("original");

    await blobs.save(key, original, { contentType: "application/json" });
    const found = await blobs.download(key);
    expect(found?.bytes).toEqual(original);

    await blobs.save(key, "updated", { contentType: "application/json", ifGenerationMatch: found!.revision });
    await expect(blobs.save(key, "stale", { contentType: "application/json", ifGenerationMatch: found!.revision }))
      .rejects.toMatchObject({ code: 412 });
    const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: "workspace/" }));
    expect(versions.Versions).toHaveLength(2);
    await blobs.deletePrefix("workspace/");
    await expect(blobs.download(key)).resolves.toBeNull();
  });

  it("purges every version and delete marker under a project prefix", async () => {
    const blobs = store();
    const prefix = "workspace/project/";
    const asset = prefix + "asset.bin";
    const sibling = "workspace/project-2/asset.bin";
    const contentType = "application/octet-stream";
    try {
      await blobs.save(asset, "first", { contentType });
      await blobs.save(asset, "second", { contentType });
      await blobs.delete(asset);
      await blobs.save(sibling, "keep", { contentType });
      const before = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
      expect(before.Versions).toHaveLength(2);
      await blobs.deletePrefix(prefix);
      await expect(blobs.download(sibling)).resolves.toMatchObject({ bytes: Buffer.from("keep") });
      const versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix }));
      expect(versions.Versions ?? []).toEqual([]);
      expect(versions.DeleteMarkers ?? []).toEqual([]);
    } finally {
      await blobs.deletePrefix(prefix);
      await blobs.deletePrefix("workspace/project-2/");
    }
  });

  it("overwrites and deletes mutable workspace blobs without retaining hidden versions", async () => {
    const blobs = store();
    const key = "customers/alice/photo.png";
    const contentType = "application/octet-stream";
    await blobs.save(key, "first", { contentType });
    const signed = await blobs.signedUrl({ gcsPath: key, action: "write", contentType }, Date.now() + 30_000);
    expect(new URL(signed.url).pathname).toBe(`/${workspaceBucket}/${key}`);
    expect((await fetch(signed.url, { method: "PUT", headers: signed.requiredHeaders, body: "second" })).status).toBe(200);
    const listing = (Bucket: string) => client.send(new ListObjectVersionsCommand({ Bucket, Prefix: key }));
    expect((await listing(workspaceBucket)).Versions).toHaveLength(1);
    expect((await listing(bucket)).Versions ?? []).toEqual([]);
    await blobs.delete(key);
    const after = await listing(workspaceBucket);
    expect(after.Versions ?? []).toEqual([]);
    expect(after.DeleteMarkers ?? []).toEqual([]);
    await expect(blobs.download(key)).resolves.toBeNull();
    expect(() => createS3BlobStore({ ...options, workspaceBucket: bucket })).toThrow(/separate unversioned/);
    const misconfigured = createS3BlobStore({ ...options, bucket: workspaceBucket, workspaceBucket: bucket });
    await expect(misconfigured.save(key, "data", { contentType })).rejects.toThrow(/never have had versioning enabled/);
  });

  it("signs an immutable upload and a version-pinned download", async () => {
    const blobs = store();
    const key = "project/attachment with spaces.bin";
    const data = Buffer.from("bounded attachment");
    // eslint-disable-next-line sonarjs/hashing -- S3 transport checksum
    const contentMd5 = createHash("md5").update(data).digest("base64");
    const expires = Date.now() + 30_000;
    const upload = await blobs.signedUrl({
      gcsPath: key, action: "write", contentType: "application/octet-stream",
      ifGenerationMatch: 0, contentLength: data.length, contentMd5,
    }, expires);
    const put = () => fetch(upload.url, { method: "PUT", headers: upload.requiredHeaders, body: data });
    expect((await put()).status).toBe(200);
    expect((await put()).status).toBe(412);

    const metadata = await blobs.metadata(key);
    expect(metadata).toMatchObject({ size: String(data.length), md5Hash: contentMd5 });
    expect(metadata.generation).toBeTruthy();

    const download = await blobs.signedUrl({ gcsPath: key, action: "read", generation: metadata.generation }, expires);
    const response = await fetch(download.url);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-amz-version-id")).toBe(metadata.generation);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    await blobs.delete(key, metadata.generation);
  });
});

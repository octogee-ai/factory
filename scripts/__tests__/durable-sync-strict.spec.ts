import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
  root: `/tmp/octogee-durable-sync-${process.pid}`,
  customers: `/tmp/octogee-durable-sync-${process.pid}/customers`,
  keys: `/tmp/octogee-durable-sync-${process.pid}/keys`,
}));

vi.mock("../lib/config.js", () => ({
  log: vi.fn(),
  dlog: vi.fn(),
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  OPENCLAW_DIR: paths.root,
  CUSTOMERS_DIR: paths.customers,
  CUSTOMER_KEYS_DIR: paths.keys,
  AGENTS_DIR: "/tmp/octogee-test/agents",
  BLOB_SYNC_MAX_CONCURRENT: 2,
  BLOB_SYNC_MAX_SIZE: 100 * 1024 * 1024,
}));

const {
  externalizeCustomerGitDir,
} = await import("../lib/git.js");
const { blobSyncForSlug } = await import("../lib/blob-sync.js");
const { workspaceGitignore } = await import("../lib/git.js");

beforeEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
  fs.mkdirSync(paths.customers, { recursive: true });
  fs.mkdirSync(paths.keys, { recursive: true });
});

afterEach(() => {
  fs.rmSync(paths.root, { recursive: true, force: true });
});

describe("blob sync without a manifest", () => {
  it("uploads and records local blobs when no manifest exists yet", async () => {
    const blobsDir = path.join(paths.customers, "aug29", ".blobs");
    fs.mkdirSync(blobsDir, { recursive: true });
    fs.writeFileSync(path.join(blobsDir, "avatar.png"), "png-bytes");

    const written: Array<{ contents: string; ifGenerationMatch: string }> = [];
    const upload = vi.fn(async () => {});

    await blobSyncForSlug("aug29", {
      store: {
        manifestFor: () => ({
          read: async () => null,
          write: async (_p: string, contents: string, ifGenerationMatch: string) => {
            written.push({ contents, ifGenerationMatch });
          },
        }),
        download: vi.fn(async () => {}),
        upload,
      },
    });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
    expect(written[0].ifGenerationMatch).toBe("0");
    expect(JSON.parse(written[0].contents)["avatar.png"]).toMatchObject({
      type: "blob",
      gcsPath: "customers/aug29/avatar.png",
    });
  });
});

describe("canonical customer git config", () => {
  it("configures main's upstream, without which a clean checkout never fast-forwards", () => {
    const repo = path.join(paths.customers, "upstreamcheck");
    fs.mkdirSync(repo, { recursive: true });
    const gitDir = externalizeCustomerGitDir(repo, { fetchCanonical: () => {} });
    expect(gitDir).not.toBeNull();
    const config = fs.readFileSync(path.join(gitDir!, "config"), "utf8");
    expect(config).toContain('[branch "main"]');
    expect(config).toContain("remote = origin");
    expect(config).toContain("merge = refs/heads/main");
  });

  it("ignores the blob manifest — it is server-side state, not repo content", () => {
    const ignore = workspaceGitignore();
    expect(ignore).toContain(".files/");
    expect(ignore).toContain("projects/");
  });
});

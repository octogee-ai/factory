import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const paths = vi.hoisted(() => ({
  customers: `/tmp/octogee-durable-sync-${process.pid}`,
  keys: `/tmp/octogee-durable-sync-keys-${process.pid}`,
}));

vi.mock("../lib/config.js", () => ({
  log: vi.fn(),
  dlog: vi.fn(),
  GIT_API_URL: "https://gitea.test/api/v1",
  GIT_SSH_HOST: "gitea.test",
  CUSTOMERS_DIR: paths.customers,
  CUSTOMER_KEYS_DIR: paths.keys,
  AGENTS_DIR: "/tmp/octogee-test/agents",
  BLOB_SYNC_MAX_CONCURRENT: 2,
  BLOB_SYNC_MAX_SIZE: 100 * 1024 * 1024,
}));

const { syncAllWorkspaces } = await import("../lib/git.js");
const { blobSyncAllWithOptions } = await import("../lib/blob-sync.js");

beforeEach(() => {
  fs.rmSync(paths.customers, { recursive: true, force: true });
  fs.rmSync(paths.keys, { recursive: true, force: true });
  fs.mkdirSync(paths.customers, { recursive: true });
  fs.mkdirSync(paths.keys, { recursive: true });
});

afterEach(() => {
  fs.rmSync(paths.customers, { recursive: true, force: true });
  fs.rmSync(paths.keys, { recursive: true, force: true });
});

describe("strict durable sync", () => {
  it("rejects the final workspace flush when a real git push fails", async () => {
    const workspace = path.join(paths.customers, "alice");
    fs.mkdirSync(workspace, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@octogee.test"], { cwd: workspace });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    fs.writeFileSync(path.join(workspace, "README.md"), "durable\n");
    execFileSync("git", ["add", "-A"], { cwd: workspace });
    execFileSync("git", ["commit", "-q", "-m", "local state"], { cwd: workspace });
    execFileSync("git", ["remote", "add", "origin", path.join(paths.customers, "missing.git")], {
      cwd: workspace,
    });

    await expect(syncAllWorkspaces({ strict: true })).rejects.toThrow(/alice.*push/i);
  });

  it("rejects the final blob flush when a per-customer upload fails", async () => {
    const customer = path.join(paths.customers, "alice");
    fs.mkdirSync(path.join(customer, ".files"), { recursive: true });
    fs.mkdirSync(path.join(customer, ".blobs"), { recursive: true });
    fs.writeFileSync(path.join(customer, ".files", "manifest.json"), "{}\n");
    fs.writeFileSync(path.join(customer, ".blobs", "pending.txt"), "not uploaded\n");

    await expect(blobSyncAllWithOptions({
      strict: true,
      storeForSlug: () => ({
        download: vi.fn(async () => {}),
        upload: vi.fn(async () => { throw new Error("storage unavailable"); }),
      }),
    })).rejects.toThrow(/alice.*storage unavailable/i);
  });
});

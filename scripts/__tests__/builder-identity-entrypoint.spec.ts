import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBuilderClaim, writeBuilderClaim, builderClaimFromIdentity } from "@octogee/shared/server/builder-claim";
import type { BuilderIdentity } from "../../shared/types/builder-identity.js";
import {
  BUILDER_IDENTITY_FATAL_EXIT,
  resolveBuilderIdentityBoot,
  runBuilderIdentityEntrypoint,
} from "../entrypoints/builder-identity.js";

const dirs: string[] = [];

function openclawDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-builder-identity-"));
  dirs.push(dir);
  return dir;
}

const CLAIMED: BuilderIdentity = {
  gatewayId: "gw-alice",
  state: "claimed",
  ownerUid: "uid-alice",
  builderSlug: "alice",
  leaseId: "lease-1",
  generation: 2,
};

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function boot(dir: string, fetchIdentity: () => Promise<BuilderIdentity>) {
  const log = vi.fn();
  const result = resolveBuilderIdentityBoot({
    env: { OPENCLAW_DIR: dir, GATEWAY_ID: "gw-alice", GATEWAY_CLASS: "builder" },
    fetchIdentity,
    now: () => 1_700_000_000_000,
    log,
  });
  return { result, log };
}

describe("Builder identity pre-boot", () => {
  it("writes the claimed identity to the claim file and reports its slug", async () => {
    const dir = openclawDir();
    const { result } = boot(dir, async () => CLAIMED);

    await expect(result).resolves.toEqual({ exitCode: 0, builderSlug: "alice" });
    expect(readBuilderClaim(dir, "gw-alice")).toMatchObject({
      ownerUid: "uid-alice",
      builderSlug: "alice",
      leaseId: "lease-1",
      generation: 2,
      claimedAt: 1_700_000_000_000,
      overlayAppliedAt: null,
    });
  });

  it("keeps an existing claim for the same owner across a container restart", async () => {
    const dir = openclawDir();
    writeBuilderClaim(dir, builderClaimFromIdentity({ ...CLAIMED, state: "claimed" }, 1_600_000_000_000));

    await expect(boot(dir, async () => CLAIMED).result).resolves.toEqual({ exitCode: 0, builderSlug: "alice" });
    expect(readBuilderClaim(dir, "gw-alice")?.claimedAt).toBe(1_600_000_000_000);
  });

  it("is fatal when the broker names another owner than the pod's claim", async () => {
    const dir = openclawDir();
    writeBuilderClaim(dir, builderClaimFromIdentity({ ...CLAIMED, ownerUid: "uid-mallory", builderSlug: "mallory" }, 1));
    const { result, log } = boot(dir, async () => CLAIMED);

    await expect(result).resolves.toEqual({ exitCode: BUILDER_IDENTITY_FATAL_EXIT });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("refusing to rebind"));
    expect(readBuilderClaim(dir, "gw-alice")?.ownerUid).toBe("uid-mallory");
  });

  it("is fatal for a retired gateway and writes no claim", async () => {
    const dir = openclawDir();
    const { result, log } = boot(dir, async () => ({ gatewayId: "gw-alice", state: "unavailable", reason: "retired" }));

    await expect(result).resolves.toEqual({ exitCode: BUILDER_IDENTITY_FATAL_EXIT });
    expect(log).toHaveBeenCalled();
    expect(readBuilderClaim(dir, "gw-alice")).toBeNull();
  });

  it("asks the entrypoint to retry when the broker is unreachable", async () => {
    const dir = openclawDir();
    const { result, log } = boot(dir, async () => { throw new Error("fleet-broker POST /internal/fleet/builder-identity → 503"); });

    await expect(result).resolves.toEqual({ exitCode: 1 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("503"));
    expect(readBuilderClaim(dir, "gw-alice")).toBeNull();
  });
});

describe("Builder identity entrypoint output", () => {
  it("reports success only after the slug has been delivered to stdout", async () => {
    const dir = openclawDir();
    const written: string[] = [];
    let flush: (() => void) | null = null;
    const stdout = {
      write: (chunk: string, callback: (error?: Error | null) => void) => {
        written.push(chunk);
        flush = () => callback();
        return false;
      },
    };
    let settled = false;
    const exitCode = runBuilderIdentityEntrypoint({
      env: { OPENCLAW_DIR: dir, GATEWAY_ID: "gw-alice", GATEWAY_CLASS: "builder" },
      fetchIdentity: async () => CLAIMED,
      now: () => 1,
      log: vi.fn(),
      stdout,
    }).then((code) => { settled = true; return code; });

    await vi.waitFor(() => expect(flush).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    flush!();
    await expect(exitCode).resolves.toBe(0);
    expect(written).toEqual(["alice\n"]);
  });

  it("delivers the slug through a piped stdout from the real entrypoint process", async () => {
    const dir = openclawDir();
    const tokenPath = path.join(dir, "credential-token");
    writeFileSync(tokenPath, "projected-credential");
    const broker = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ identity: CLAIMED }));
    });
    await new Promise<void>((resolve) => broker.listen(0, "127.0.0.1", resolve));
    try {
      const child = spawn(path.resolve(import.meta.dirname, "../node_modules/.bin/tsx"), [
        path.resolve(import.meta.dirname, "../entrypoints/builder-identity.ts"),
      ], {
        env: {
          ...process.env,
          OPENCLAW_DIR: dir,
          GATEWAY_ID: "gw-alice",
          GATEWAY_CLASS: "builder",
          FLEET_BROKER_URL: `http://127.0.0.1:${(broker.address() as AddressInfo).port}`,
          OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH: tokenPath,
          INTERNAL_SERVICE_KEY: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      expect(code, stderr).toBe(0);
      expect(stdout).toBe("alice\n");
      expect(readBuilderClaim(dir, "gw-alice")?.builderSlug).toBe("alice");
    } finally {
      await new Promise<void>((resolve) => broker.close(() => resolve()));
    }
  });
});

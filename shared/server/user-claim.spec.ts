import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UserClaimError,
  userClaimFromIdentity,
  userClaimOverlaySlug,
  userClaimOwnerUid,
  userClaimPath,
  userClaimSlug,
  markUserClaimOverlayApplied,
  readUserClaim,
  writeUserClaim,
} from "./user-claim.js";

const dirs: string[] = [];

function openclawDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "octogee-user-claim-"));
  dirs.push(dir);
  return dir;
}

function claim(overrides: Partial<Parameters<typeof userClaimFromIdentity>[0]> = {}) {
  return userClaimFromIdentity({
    gatewayId: "gw-alice",
    state: "claimed",
    ownerUid: "uid-alice",
    builderSlug: "alice",
    leaseId: "lease-1",
    generation: 3,
    ...overrides,
  }, 1_700_000_000_000);
}

afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("User claim file", () => {
  it("round-trips the claimed identity as an owner-only file", () => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());

    expect(readUserClaim(dir, "gw-alice")).toEqual({
      schemaVersion: 1,
      gatewayId: "gw-alice",
      ownerUid: "uid-alice",
      builderSlug: "alice",
      leaseId: "lease-1",
      generation: 3,
      claimedAt: 1_700_000_000_000,
      overlayAppliedAt: null,
    });
    expect(statSync(userClaimPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("reports no claim when the file is absent", () => {
    expect(readUserClaim(openclawDir(), "gw-alice")).toBeNull();
  });

  it("is fatal when the claim names another gateway", () => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());
    expect(() => readUserClaim(dir, "gw-bob")).toThrow(UserClaimError);
  });

  it("is fatal when a malformed claim is on disk", () => {
    const dir = openclawDir();
    writeFileSync(userClaimPath(dir), JSON.stringify({ schemaVersion: 1, gatewayId: "gw-alice", ownerUid: "uid-alice" }));
    expect(() => readUserClaim(dir, "gw-alice")).toThrow(/malformed/);
  });

  it("keeps the existing claim when the same owner is claimed again", () => {
    const dir = openclawDir();
    const first = writeUserClaim(dir, claim());
    const second = writeUserClaim(dir, { ...claim(), claimedAt: 1_800_000_000_000 });

    expect(second).toEqual(first);
    expect(JSON.parse(readFileSync(userClaimPath(dir), "utf8")).claimedAt).toBe(1_700_000_000_000);
  });

  it.each([
    ["owner", { ownerUid: "uid-mallory" }],
    ["user slug", { builderSlug: "mallory" }],
    ["gateway", { gatewayId: "gw-mallory" }],
  ])("is fatal when a second claim names another %s", (_label, overrides) => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());
    expect(() => writeUserClaim(dir, claim(overrides))).toThrow(UserClaimError);
    expect(readUserClaim(dir, "gw-alice")?.ownerUid).toBe("uid-alice");
  });

  it("derives the slug and owner from the claim, never from the environment", () => {
    const dir = openclawDir();
    const env = { OPENCLAW_DIR: dir, GATEWAY_ID: "gw-alice", GATEWAY_BUILDER_SLUG: "mallory", GATEWAY_OWNER_UID: "uid-mallory" };
    expect(userClaimSlug(env)).toBeNull();
    expect(userClaimOwnerUid(env)).toBeNull();

    writeUserClaim(dir, claim());
    expect(userClaimSlug(env)).toBe("alice");
    expect(userClaimOwnerUid(env)).toBe("uid-alice");
  });

  it("refuses to read a claim without knowing this gateway's id", () => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());
    expect(() => userClaimSlug({ OPENCLAW_DIR: dir })).toThrow(/GATEWAY_ID/);
  });
});

describe("User claim overlay stamp", () => {
  it("records when the overlay was applied and keeps the identity", () => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());

    const stamped = markUserClaimOverlayApplied(dir, "gw-alice", 1_700_000_000_500);

    expect(stamped).toEqual({ ...claim(), overlayAppliedAt: 1_700_000_000_500 });
    expect(readUserClaim(dir, "gw-alice")).toEqual(stamped);
    expect(statSync(userClaimPath(dir)).mode & 0o777).toBe(0o600);
  });

  it("keeps the first stamp when the overlay is re-applied", () => {
    const dir = openclawDir();
    writeUserClaim(dir, claim());
    markUserClaimOverlayApplied(dir, "gw-alice", 1_700_000_000_500);

    expect(markUserClaimOverlayApplied(dir, "gw-alice", 1_700_000_009_000).overlayAppliedAt).toBe(1_700_000_000_500);
  });

  it("names the user slug only once the overlay is applied", () => {
    const dir = openclawDir();
    const env = { OPENCLAW_DIR: dir, GATEWAY_ID: "gw-alice" };
    expect(userClaimOverlaySlug(env)).toBeNull();
    writeUserClaim(dir, claim());
    expect(userClaimOverlaySlug(env)).toBeNull();
    markUserClaimOverlayApplied(dir, "gw-alice", 1_700_000_000_500);
    expect(userClaimOverlaySlug(env)).toBe("alice");
  });

  it("refuses to stamp a gateway that has no claim", () => {
    expect(() => markUserClaimOverlayApplied(openclawDir(), "gw-alice", 1_700_000_000_500))
      .toThrow(UserClaimError);
  });
});

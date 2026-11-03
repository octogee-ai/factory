import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWorkspaceIdentityReady, beginWorkspaceIdentityBoot, bootstrapWorkspaceIdentities, workspaceIdentityReady, workspaceOwnerIdentityReady } from "./openclaw-workspace-bootstrap.js";

const dirs: string[] = [];
function writeClaim(dir: string, ownerUid: string, gatewayId = "b-alice"): void {
  fs.writeFileSync(path.join(dir, "builder-claim.json"), JSON.stringify({
    schemaVersion: 1, gatewayId, ownerUid, builderSlug: ownerUid,
    leaseId: null, generation: null, claimedAt: 1, overlayAppliedAt: null,
  }));
}
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-workspace-bootstrap-")); dirs.push(dir);
  const env = { OPENCLAW_DIR: dir, GATEWAY_ID: "b-alice", GATEWAY_CLASS: "builder", OPENCLAW_CONTROL_IDENTITY: "per-user" };
  writeClaim(dir, "alice");
  const profiles: Array<{ id: string; emails: string[]; role: string | null }> = [];
  const request = vi.fn(async (method: string, params: Record<string, unknown>, options: { scopes: string[] }) => {
    expect(options.scopes).toEqual(["operator.admin"]);
    if (method === "users.list") return { profiles: structuredClone(profiles) };
    const profile = profiles.find(profile => profile.id === params.profileId)!;
    profile.role = params.role as string;
    return { profile };
  });
  const createProfile = vi.fn(async (uid: string) => { profiles.push({ id: `native-${uid}`, emails: [uid.toLowerCase()], role: null }); });
  const args = { env, request: request as Parameters<typeof bootstrapWorkspaceIdentities>[0]["request"], createProfile };
  beginWorkspaceIdentityBoot(env);
  return { env, profiles, request, createProfile, args };
}

describe("native workspace identity initialization", () => {
  it("initializes an empty native profile store before admitting users or services", async () => {
    const { env, profiles, args } = fixture();
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    expect(workspaceIdentityReady(env)).toBe(false);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
    expect(workspaceIdentityReady(env)).toBe(true);
  });

  it("forces the owner back to admin on later boots", async () => {
    const { env, profiles, request, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[2].role = "member";
    request.mockClear();
    beginWorkspaceIdentityBoot(env);
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[2].role).toBe("admin");
    expect(request).toHaveBeenCalledWith("users.setRole", { profileId: profiles[2].id, role: "admin" }, expect.anything());
  });

  it("leaves correctly assigned roles untouched", async () => {
    const { env, args, request } = fixture();
    await bootstrapWorkspaceIdentities(args);
    request.mockClear();
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(request).not.toHaveBeenCalledWith("users.setRole", expect.anything(), expect.anything());
  });

  it("resumes after a crash between native profile creation and role assignment", async () => {
    const { env, profiles, createProfile, args } = fixture();
    createProfile.mockImplementationOnce(async uid => {
      profiles.push({ id: "created-before-crash", emails: [uid], role: null });
      throw new Error("interrupted");
    });
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("interrupted");
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(profiles[0].id).toBe("created-before-crash");
  });

  it("restores the same owner's identities on a replacement gateway with the owner as admin", async () => {
    const { env, profiles, args, request } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[2].role = "custom";
    env.GATEWAY_ID = "b-alice-replacement";
    writeClaim(env.OPENCLAW_DIR, "alice", "b-alice-replacement");
    beginWorkspaceIdentityBoot(env);
    request.mockClear();
    await bootstrapWorkspaceIdentities(args);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
    expect(profiles[2].role).toBe("admin");
  });

  it("assigns roles to platform and owner identities restored without one", async () => {
    const { profiles, args } = fixture();
    profiles.push(
      { id: "restored-edge", emails: ["svc:gateway-edge"], role: null },
      { id: "restored-provisioner", emails: ["svc:octogee-provisioner"], role: null },
      { id: "restored-owner", emails: ["alice"], role: null },
    );
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => [profile.id, profile.role])).toEqual([
      ["restored-edge", "service"],
      ["restored-provisioner", "service"],
      ["restored-owner", "admin"],
    ]);
  });

  it("restores the service role of a platform identity on a later boot", async () => {
    const { env, profiles, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[1].role = "member";
    beginWorkspaceIdentityBoot(env);
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
  });

  it("rejects an identity journal belonging to a different owner", async () => {
    const { env, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    writeClaim(env.OPENCLAW_DIR, "bob");
    beginWorkspaceIdentityBoot(env);
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("does not match");
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
  });

  it("refuses to admit an owner that is not the Builder claim's", async () => {
    const { env, profiles, args, createProfile } = fixture();
    fs.rmSync(path.join(env.OPENCLAW_DIR, "builder-claim.json"));
    await expect(bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_OWNER_UID: "mallory" } as typeof env })).rejects.toThrow("claimed owner");
    expect(createProfile).not.toHaveBeenCalled();
    expect(profiles).toEqual([]);
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
  });

  it("refuses to initialize identities for a Builder with no claim", async () => {
    const { env, profiles, args, createProfile } = fixture();
    fs.rmSync(path.join(env.OPENCLAW_DIR, "builder-claim.json"));
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow("claimed owner");
    expect(createProfile).not.toHaveBeenCalled();
    expect(profiles).toEqual([]);
    expect(workspaceIdentityReady(env)).toBe(false);
  });

  it("marks the owner identity ready only after the owner is admin", async () => {
    const { env, args, request } = fixture();
    request.mockImplementation(async (method: string) => {
      if (method === "users.setRole") throw new Error("role write refused");
      return { profiles: [] };
    });
    await expect(bootstrapWorkspaceIdentities(args)).rejects.toThrow();
    expect(workspaceOwnerIdentityReady(env, "alice")).toBe(false);
  });

  it("forces a preexisting owner to admin and does nothing on shared gateways", async () => {
    const { env, profiles, args, request } = fixture();
    profiles.push({ id: "existing-owner", emails: ["alice"], role: "custom" });
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[0].role).toBe("admin");
    request.mockClear();
    await bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_CLASS: "shared" } });
    expect(request).not.toHaveBeenCalled();
  });
});

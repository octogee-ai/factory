import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertWorkspaceIdentityReady, beginWorkspaceIdentityBoot, bootstrapWorkspaceIdentities } from "./openclaw-workspace-bootstrap.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "native-workspace-bootstrap-")); dirs.push(dir);
  const env = { OPENCLAW_DIR: dir, GATEWAY_ID: "b-alice", GATEWAY_OWNER_UID: "alice", GATEWAY_CLASS: "builder", OPENCLAW_CONTROL_IDENTITY: "per-user" };
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
    await bootstrapWorkspaceIdentities(args);
    expect(profiles.map(profile => profile.role)).toEqual(["service", "service", "admin"]);
    expect(() => assertWorkspaceIdentityReady(env)).not.toThrow();
  });

  it("preserves native role edits, including default/null, on later boots", async () => {
    const { env, profiles, request, args } = fixture();
    await bootstrapWorkspaceIdentities(args);
    profiles[2].role = null;
    request.mockClear();
    beginWorkspaceIdentityBoot(env);
    expect(() => assertWorkspaceIdentityReady(env)).toThrow("not initialized");
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[2].role).toBeNull();
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

  it("never changes preexisting owner assignments and does nothing on shared gateways", async () => {
    const { env, profiles, args, request } = fixture();
    profiles.push({ id: "existing-owner", emails: ["alice"], role: "custom" });
    await bootstrapWorkspaceIdentities(args);
    expect(profiles[0].role).toBe("custom");
    request.mockClear();
    await bootstrapWorkspaceIdentities({ ...args, env: { ...env, GATEWAY_CLASS: "shared" } });
    expect(request).not.toHaveBeenCalled();
  });
});

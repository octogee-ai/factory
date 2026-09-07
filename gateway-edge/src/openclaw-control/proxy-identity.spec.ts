import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import {
  createOpenClawControlProxyIdentity,
  openClawControlClientAddress,
} from "./proxy-identity.js";

interface ConnectRecord {
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, unknown>;
}

interface MockGateway {
  base: URL;
  connects: ConnectRecord[];
  calls: Array<{ method: string; params: Record<string, unknown>; user: string | undefined }>;
  profiles: Array<{ id: string; emails: string[]; role: string | null; displayName?: string | null; hasAvatar?: boolean; updatedAt?: number }>;
  rejectMethod?: string;
  close(): Promise<void>;
}

const servers: MockGateway[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mockGateway(
  profiles: MockGateway["profiles"] = [],
): Promise<MockGateway> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  const state: MockGateway = {
    base: new URL("http://127.0.0.1"),
    connects: [],
    calls: [],
    profiles,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
  wss.on("connection", (ws, req) => {
    const user = req.headers["x-octogee-user"];
    ws.send(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { id: string; method: string; params: Record<string, unknown> };
      if (frame.method === "connect") {
        state.connects.push({ headers: req.headers, params: frame.params });
        if (typeof user === "string" && !user.startsWith("svc:") &&
          !state.profiles.some((profile) => profile.emails.includes(user.toLowerCase()))) {
          state.profiles.push({ id: `profile-${state.profiles.length + 1}`, emails: [user.toLowerCase()], role: null });
        }
        ws.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", features: { methods: ["users.list", "users.setRole"] } },
        }));
        return;
      }
      state.calls.push({ method: frame.method, params: frame.params, user: typeof user === "string" ? user : undefined });
      if (frame.method === state.rejectMethod) {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "refused" } }));
        return;
      }
      if (frame.method === "users.setDisplayName" || frame.method === "users.setAvatar") {
        const profile = state.profiles.find((entry) => entry.id === frame.params.profileId)!;
        if (frame.method === "users.setDisplayName") profile.displayName = frame.params.displayName as string;
        else profile.hasAvatar = true;
        profile.updatedAt = (profile.updatedAt ?? 0) + 1;
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profile } }));
        return;
      }
      if (frame.method === "users.list") {
        ws.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { profiles: state.profiles } }));
        return;
      }
      if (frame.method === "users.setRole") {
        const profile = state.profiles.find((entry) => entry.id === frame.params.profileId);
        const accepted = Boolean(profile) && profile!.id !== "ghost";
        if (accepted) profile!.role = frame.params.role as string;
        ws.send(JSON.stringify(accepted
          ? { type: "res", id: frame.id, ok: true, payload: { profile } }
          : { type: "res", id: frame.id, ok: false, error: { message: "role assignment refused" } }));
        return;
      }
      ws.send(JSON.stringify({ type: "res", id: frame.id, ok: false, error: { message: "unknown" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  servers.push(state);
  return state;
}

function identityFor(gateway: MockGateway, env: NodeJS.ProcessEnv = {}) {
  return createOpenClawControlProxyIdentity({
    env: { OPENCLAW_CONTROL_IDENTITY: "per-user", OPENCLAW_GATEWAY_TOKEN: "pod-secret", API_PUBLIC_URL: "https://api-test.octogee.com/", ...env },
    upstreamBase: () => gateway.base,
    timeoutMs: 2_000,
    podAddress: () => "10.8.0.4",
    loadAppearance: async () => ({ displayName: null, avatar: null }),
  });
}

const helper = { uid: "uid-Helper", gatewayId: "bender", brokerProfile: "delegated-config" as const };

describe("OpenClaw control proxy identity", () => {
  it("is disabled unless the pod runs per-user control identity", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: {},
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    expect(identity.enabled).toBe(false);
  });

  it("creates the person's profile through their own identity, then assigns their role from the service socket", async () => {
    const gateway = await mockGateway();

    await identityFor(gateway).syncProfile(helper);

    expect(gateway.connects.map((connect) => connect.headers["x-octogee-user"])).toEqual([
      "svc:gateway-edge",
      "uid-Helper",
    ]);
    expect(gateway.connects.every((connect) => connect.headers["x-octogee-proxy"] === "1")).toBe(true);
    expect(gateway.connects.every((connect) => connect.headers["x-forwarded-for"] === "10.8.0.4")).toBe(true);
    expect(gateway.connects.every((connect) => connect.headers.origin === "https://api-test.octogee.com")).toBe(true);
    expect(gateway.connects[0]!.params).toMatchObject({
      client: { id: "openclaw-control-ui", mode: "backend" },
      role: "operator",
    });
    expect(gateway.connects[0]!.params).not.toHaveProperty("auth");
    expect(gateway.calls.map((call) => [call.method, call.user])).toEqual([
      ["users.list", "svc:gateway-edge"],
      ["users.list", "svc:gateway-edge"],
      ["users.setRole", "svc:gateway-edge"],
    ]);
    expect(gateway.calls[2]!.params).toEqual({ profileId: "profile-1", role: "trusted-helper" });
    expect(gateway.profiles[0]).toEqual({ id: "profile-1", emails: ["uid-helper"], role: "trusted-helper" });
  });

  it("syncs Octogee appearance through the service even when the role is unchanged", async () => {
    const gateway = await mockGateway([{ id: "person", emails: ["uid-helper"], role: "trusted-helper" }]);
    const read = vi.fn(async () => Buffer.from("avatar"));
    const appearance = { displayName: "Chris", avatar: { revision: "upload-1", read } };
    const loadAppearance = vi.fn(async () => appearance);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4", loadAppearance,
    });
    await identity.syncProfile(helper);
    expect(loadAppearance).toHaveBeenCalledWith(helper.uid);
    expect(gateway.calls.filter((call) => call.method !== "users.list")).toEqual([
      { method: "users.setDisplayName", params: { profileId: "person", displayName: "Chris" }, user: "svc:gateway-edge" },
      { method: "users.setAvatar", params: { profileId: "person", mime: "image/jpeg", avatarBase64: Buffer.from("avatar").toString("base64") }, user: "svc:gateway-edge" },
    ]);
    await identity.syncProfile(helper);
    expect(read).toHaveBeenCalledTimes(1);
    appearance.displayName = "Christopher";
    appearance.avatar.revision = "upload-2";
    await identity.syncProfile(helper);
    expect(gateway.profiles[0]!.displayName).toBe("Christopher");
    expect(read).toHaveBeenCalledTimes(2);
    gateway.profiles[0]!.updatedAt! += 1;
    await identity.syncProfile(helper);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("refreshes appearance without reassigning roles on an established connection", async () => {
    const gateway = await mockGateway([{ id: "person", emails: ["uid-helper"], role: "viewer" }]);
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadAppearance: async () => ({ displayName: "Chris", avatar: null }),
    });
    await identity.syncProfile(helper, { assignRole: false });
    expect(gateway.profiles[0]).toMatchObject({ displayName: "Chris", role: "viewer" });
    expect(gateway.calls.map((call) => call.method)).toEqual(["users.list", "users.setDisplayName"]);
  });

  it("shares concurrent profile syncs for the same user and keeps other users separate", async () => {
    const gateway = await mockGateway();
    const loadAppearance = vi.fn(async (uid: string) => ({ displayName: uid, avatar: null }));
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4", loadAppearance,
    });
    await Promise.all([identity.syncProfile(helper), identity.syncProfile(helper),
      identity.syncProfile({ ...helper, uid: "another-user" })]);
    expect(loadAppearance).toHaveBeenCalledTimes(2);
    expect(gateway.profiles.map((profile) => profile.displayName).sort()).toEqual(["another-user", "uid-Helper"]);
  });

  it("retries refused avatar writes instead of caching them as synchronized", async () => {
    const gateway = await mockGateway([{ id: "person", emails: ["uid-helper"], role: "trusted-helper" }]);
    const read = vi.fn(async () => Buffer.from("avatar"));
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", API_PUBLIC_URL: "https://api-test.octogee.com" },
      upstreamBase: () => gateway.base, podAddress: () => "10.8.0.4",
      loadAppearance: async () => ({ displayName: null, avatar: { revision: "one", read } }),
    });
    gateway.rejectMethod = "users.setAvatar";
    await expect(identity.syncProfile(helper)).rejects.toThrow("users.setAvatar failed");
    gateway.rejectMethod = undefined;
    await identity.syncProfile(helper);
    expect(gateway.profiles[0]!.hasAvatar).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("uses the configured API origin for user and service connections", async () => {
    const identity = identityFor(await mockGateway());
    expect(identity.serviceHeaders().origin).toBe("https://api-test.octogee.com");
    expect(identity.userHeaders(helper, { socket: { remoteAddress: "10.1.2.3" } as never }).origin)
      .toBe("https://api-test.octogee.com");
  });

  it("leaves an already-correct role alone and corrects a stale one", async () => {
    const gateway = await mockGateway([
      { id: "profile-9", emails: ["uid-helper"], role: "trusted-helper" },
    ]);
    const identity = identityFor(gateway);

    await identity.syncProfile(helper);
    expect(gateway.calls.map((call) => call.method)).toEqual(["users.list"]);

    await identity.syncProfile({ ...helper, brokerProfile: "delegated-read" });
    expect(gateway.calls.map((call) => call.method)).toEqual(["users.list", "users.list", "users.setRole"]);
    expect(gateway.calls[2]!.params).toEqual({ profileId: "profile-9", role: "viewer" });
    expect(gateway.connects).toHaveLength(2);
  });

  it("fails loudly when the gateway refuses the role assignment", async () => {
    const gateway = await mockGateway([{ id: "ghost", emails: ["uid-helper"], role: null }]);

    await expect(identityFor(gateway).syncProfile(helper)).rejects.toThrow(/users.setRole failed/);
    expect(gateway.profiles[0]!.role).toBeNull();
  });

  it("binds devices to each person and role while preserving Team identity during support elevation", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user", OPENCLAW_GATEWAY_TOKEN: "pod-secret" },
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    const first = identity.deviceIdentity(helper);
    expect(identity.deviceIdentity(helper)).toEqual(first);
    const member = { ...helper, brokerProfile: "native-member" as const };
    expect(identity.deviceIdentity(member).deviceId).not.toBe(first.deviceId);
    expect(identity.deviceIdentity({ ...member, brokerProfile: "native-member-helper" })).toEqual(identity.deviceIdentity(member));
    expect(identity.deviceIdentity({ ...helper, brokerProfile: "delegated-read" }).deviceId).not.toBe(first.deviceId);
    expect(identity.deviceIdentity({ ...helper, uid: "uid-other" }).deviceId).not.toBe(first.deviceId);
    expect(identity.deviceIdentity({ ...helper, gatewayId: "other-gateway" }).deviceId).not.toBe(first.deviceId);
    expect(identity.connectScopes(helper)).toEqual(["operator.read", "operator.write", "operator.approvals"]);
    expect(identity.connectScopes({ ...helper, brokerProfile: "native-owner" })).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.questions",
    ]);
    expect(identity.connectScopes({ ...helper, brokerProfile: "delegated-read" })).toEqual(["operator.read"]);
  });

  it("refuses to derive devices without the pod secret", () => {
    const identity = createOpenClawControlProxyIdentity({
      env: { OPENCLAW_CONTROL_IDENTITY: "per-user" },
      upstreamBase: () => new URL("http://127.0.0.1:18789"),
    });
    expect(() => identity.deviceIdentity(helper)).toThrow(/OPENCLAW_GATEWAY_TOKEN is required/);
  });

  it("attributes a loopback peer to the pod address and keeps a real peer address", () => {
    const fallback = () => "10.8.0.4";
    expect(openClawControlClientAddress({ socket: { remoteAddress: "127.0.0.1" } as never }, fallback)).toBe("10.8.0.4");
    expect(openClawControlClientAddress({ socket: { remoteAddress: "::ffff:10.1.2.3" } as never }, fallback)).toBe("10.1.2.3");
    expect(openClawControlClientAddress({ socket: undefined } as never, () => undefined)).toBeUndefined();
  });
});

import { randomUUID } from "node:crypto";
import type http from "node:http";
import { isIP } from "node:net";
import os from "node:os";
import type { OpenClawBrokerProfile } from "@octogee/core/gateway-principal-access";
import { deriveDeviceIdentity, type DeviceIdentity } from "@octogee/shared/types/device-identity";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import {
  sendWsRequest,
  startConnectChallengeTracker,
  waitForWsOpen,
} from "@octogee/shared/types/openclaw-wire-core";
import {
  OPENCLAW_CONTROL_UI_CLIENT_ID,
  OPENCLAW_CONTROL_UI_CLIENT_MODE,
  OPENCLAW_EDGE_SERVICE_IDENTITY,
  isPerUserControlIdentity,
  openClawDeviceRequestScopes,
  openClawDeviceSubject,
  openClawProxyIdentityHeaders,
  openClawProxyOrigin,
  openClawRoleForBrokerProfile,
  type OpenClawOperatorRole,
} from "@octogee/shared/types/openclaw-proxy-identity";
import { WebSocket } from "ws";

import { attachUpstreamRpcClient } from "../chat-proxy/openclaw/bridge-upstream-rpc.js";

const DEFAULT_ROLE_SYNC_TIMEOUT_MS = 10_000;

export interface OpenClawControlProxyIdentitySession {
  uid: string;
  gatewayId: string;
  brokerProfile: OpenClawBrokerProfile;
}

export interface OpenClawControlProxyIdentity {
  enabled: boolean;
  userHeaders(session: OpenClawControlProxyIdentitySession, req: Pick<http.IncomingMessage, "socket">): Record<string, string>;
  serviceHeaders(): Record<string, string>;
  deviceIdentity(session: OpenClawControlProxyIdentitySession): DeviceIdentity;
  connectScopes(session: OpenClawControlProxyIdentitySession): string[];
  syncProfile(session: OpenClawControlProxyIdentitySession, options?: { assignRole: boolean }): Promise<void>;
}

interface OpenClawProfileListItem {
  id: string;
  emails: string[];
  role?: string | null;
  displayName?: string | null;
  hasAvatar?: boolean;
  updatedAt?: number;
}

export interface OpenClawProfileAppearance {
  displayName: string | null;
  avatar: { revision: string; read(): Promise<Buffer> } | null;
}

export interface CreateOpenClawControlProxyIdentityOptions {
  env?: NodeJS.ProcessEnv;
  upstreamBase: () => URL;
  timeoutMs?: number;
  podAddress?: () => string | undefined;
  openSocket?: typeof openProxyIdentitySocket;
  loadAppearance?: (uid: string) => Promise<OpenClawProfileAppearance>;
}

function loopback(address: string | undefined): boolean {
  if (!address) return true;
  const bare = address.replace(/^::ffff:/u, "");
  return bare === "::1" || bare === "localhost" || bare.startsWith("127.");
}

export function podClientAddress(): string | undefined {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.internal && entry.family === "IPv4" && isIP(entry.address) === 4) return entry.address;
    }
  }
  return undefined;
}

export function openClawControlClientAddress(
  req: Pick<http.IncomingMessage, "socket">,
  fallback: () => string | undefined,
): string | undefined {
  const peer = req.socket?.remoteAddress?.replace(/^::ffff:/u, "");
  return peer && !loopback(peer) ? peer : fallback();
}

export async function openProxyIdentitySocket(args: {
  url: URL;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<WebSocket> {
  const ws = new WebSocket(args.url, { headers: args.headers });
  ws.on("error", () => {});
  const nonceTracker = startConnectChallengeTracker(ws);
  try {
    await waitForWsOpen(ws, args.timeoutMs);
    await nonceTracker.wait(args.timeoutMs);
    await sendWsRequest({
      ws,
      id: randomUUID(),
      method: "connect",
      params: {
        minProtocol: OPENCLAW_PROTOCOL_VERSION,
        maxProtocol: OPENCLAW_PROTOCOL_VERSION,
        client: {
          id: OPENCLAW_CONTROL_UI_CLIENT_ID,
          displayName: "octogee-identity-sync",
          version: "1.0.0",
          platform: process.platform,
          mode: OPENCLAW_CONTROL_UI_CLIENT_MODE,
        },
        role: "operator",
      },
      timeoutMs: args.timeoutMs,
      mapConnectErrors: true,
    });
    return ws;
  } catch (error) {
    ws.terminate();
    throw error;
  }
}

function profileFor(profiles: OpenClawProfileListItem[], uid: string): OpenClawProfileListItem | undefined {
  const subject = uid.trim().toLowerCase();
  return profiles.find((profile) => profile.emails.some((email) => email === subject));
}

function deviceSecret(env: NodeJS.ProcessEnv): string {
  const secret = env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (!secret) throw new Error("OPENCLAW_GATEWAY_TOKEN is required to derive per-user OpenClaw devices");
  return secret;
}

export function createOpenClawControlProxyIdentity(
  options: CreateOpenClawControlProxyIdentityOptions,
): OpenClawControlProxyIdentity {
  const env = options.env ?? process.env;
  const enabled = isPerUserControlIdentity(env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_SYNC_TIMEOUT_MS;
  const fallbackAddress = options.podAddress ?? podClientAddress;
  const openSocket = options.openSocket ?? openProxyIdentitySocket;
  const loadAppearance = options.loadAppearance ?? (async (uid: string) => {
    const { loadOpenClawProfileAppearance } = await import("./profile-appearance.js");
    return loadOpenClawProfileAppearance(uid);
  });
  const avatarSyncs = new Map<string, { revision: string; updatedAt: number | undefined }>();
  const pendingSyncs = new Map<string, Promise<void>>();
  const avatarAlreadySynced = (profile: OpenClawProfileListItem, appearance: OpenClawProfileAppearance): boolean => {
    const previous = avatarSyncs.get(profile.id);
    return Boolean(profile.hasAvatar && previous?.revision === appearance.avatar?.revision
      && previous?.updatedAt === profile.updatedAt);
  };

  const roleFor = (session: OpenClawControlProxyIdentitySession): OpenClawOperatorRole =>
    openClawRoleForBrokerProfile(session.brokerProfile);

  const identityHeaders = (user: string, clientAddress: string | undefined): Record<string, string> => ({
    ...openClawProxyIdentityHeaders({ user, clientAddress }),
    origin: openClawProxyOrigin(env),
  });
  const serviceHeaders = (): Record<string, string> =>
    identityHeaders(OPENCLAW_EDGE_SERVICE_IDENTITY, fallbackAddress());

  const identityUrl = (): URL => {
    const url = new URL("/", options.upstreamBase());
    url.protocol = "ws:";
    return url;
  };

  const ensureProfile = async (uid: string): Promise<void> => {
    const ws = await openSocket({
      url: identityUrl(),
      headers: identityHeaders(uid, fallbackAddress()),
      timeoutMs,
    });
    ws.close();
  };

  const synchronizeProfile = async (session: OpenClawControlProxyIdentitySession, assignRole: boolean): Promise<void> => {
    const desired = roleFor(session);
    const ws = await openSocket({ url: identityUrl(), headers: serviceHeaders(), timeoutMs });
    const rpc = attachUpstreamRpcClient(ws, { timeoutMs });
    try {
      const listProfiles = async (): Promise<OpenClawProfileListItem[]> => {
        const listed = await rpc.call<{ profiles: OpenClawProfileListItem[] }>("users.list", {});
        if (!listed.ok) throw new Error(`users.list failed: ${listed.reason}`);
        return listed.result.profiles;
      };
      let profile = profileFor(await listProfiles(), session.uid);
      if (!profile) {
        await ensureProfile(session.uid);
        profile = profileFor(await listProfiles(), session.uid);
      }
      if (!profile) throw new Error(`OpenClaw did not create a profile for ${session.uid}`);
      const appearance = await loadAppearance(session.uid);
      const avatarUnchanged = avatarAlreadySynced(profile, appearance);
      const update = async (method: string, params: Record<string, unknown>): Promise<void> => {
        const result = await rpc.call<{ profile: OpenClawProfileListItem }>(method, { profileId: profile!.id, ...params });
        if (!result.ok) throw new Error(`${method} failed: ${result.reason}`);
        profile = result.result.profile;
      };
      if (assignRole && (profile.role ?? null) !== desired) await update("users.setRole", { role: desired });
      if ((profile.displayName ?? null) !== appearance.displayName) {
        await update("users.setDisplayName", { displayName: appearance.displayName });
      }
      if (appearance.avatar) {
        if (!avatarUnchanged) {
          const bytes = await appearance.avatar.read();
          await update("users.setAvatar", { mime: "image/jpeg", avatarBase64: bytes.toString("base64") });
        }
        avatarSyncs.delete(profile.id);
        avatarSyncs.set(profile.id, { revision: appearance.avatar.revision, updatedAt: profile.updatedAt });
        if (avatarSyncs.size > 256) avatarSyncs.delete(avatarSyncs.keys().next().value!);
      }
    } finally {
      rpc.dispose();
      ws.close();
    }
  };

  const syncProfile = (session: OpenClawControlProxyIdentitySession, { assignRole = true } = {}): Promise<void> => {
    const key = JSON.stringify([session.gatewayId, session.uid, roleFor(session), assignRole]);
    const pending = pendingSyncs.get(key);
    if (pending) return pending;
    const sync = synchronizeProfile(session, assignRole).finally(() => { pendingSyncs.delete(key); });
    pendingSyncs.set(key, sync);
    return sync;
  };

  return {
    enabled,
    userHeaders: (session, req) =>
      identityHeaders(session.uid, openClawControlClientAddress(req, fallbackAddress)),
    serviceHeaders,
    deviceIdentity: (session) =>
      deriveDeviceIdentity({
        secret: deviceSecret(env),
        subject: openClawDeviceSubject(session.gatewayId, session.uid, roleFor(session)),
      }),
    connectScopes: (session) => openClawDeviceRequestScopes(roleFor(session)),
    syncProfile,
  };
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { OPENCLAW_PROTOCOL_VERSION } from "@octogee/shared/types/openclaw-wire";
import { sendWsRequest, startConnectChallengeTracker, waitForWsOpen } from "@octogee/shared/types/openclaw-wire-core";
import { OPENCLAW_EDGE_SERVICE_IDENTITY, OPENCLAW_PROVISIONER_SERVICE_IDENTITY, openClawProxyIdentityHeaders, openClawProxyOrigin } from "@octogee/shared/types/openclaw-proxy-identity";
import { userClaimOwnerUid } from "@octogee/shared/server/user-claim";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

interface BootstrapIdentity { uid: string; role: "admin" | "service" }
interface BootstrapJournal { ownerUid: string }
interface NativeProfile { id: string; emails: string[]; role?: string | null }
type NativeRequest = <T>(method: string, params: Record<string, unknown>, options: { scopes: string[] }) => Promise<T>;

function enabled(env: NodeJS.ProcessEnv): boolean {
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && env.OPENCLAW_CONTROL_IDENTITY === "per-user";
}

function files(env: NodeJS.ProcessEnv) {
  if (!env.OPENCLAW_DIR || !env.GATEWAY_ID) throw new Error("Workspace identity initialization requires gateway and state directory");
  return {
    boot: path.join(env.OPENCLAW_DIR, "workspace-identity-boot"),
    ready: path.join(env.OPENCLAW_DIR, "workspace-identity-ready"),
    journal: path.join(env.OPENCLAW_DIR, "workspace-identity-bootstrap.json"),
    owner: path.join(env.OPENCLAW_DIR, "workspace-identity-owner"),
  };
}

function atomicWrite(file: string, value: string): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, value, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function beginWorkspaceIdentityBoot(env: NodeJS.ProcessEnv = process.env): void {
  if (!enabled(env)) return;
  const state = files(env);
  atomicWrite(state.boot, randomUUID());
  fs.rmSync(state.ready, { force: true });
}

export function workspaceIdentityReady(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!enabled(env)) return true;
  const state = files(env);
  return fs.existsSync(state.boot) && fs.existsSync(state.ready)
    && fs.readFileSync(state.boot, "utf8") === fs.readFileSync(state.ready, "utf8");
}

export function workspaceOwnerIdentityReady(env: NodeJS.ProcessEnv, ownerUid: string): boolean {
  if (!enabled(env)) return true;
  const owner = files(env).owner;
  return fs.existsSync(owner) && fs.readFileSync(owner, "utf8") === ownerUid;
}

export function assertWorkspaceIdentityReady(env: NodeJS.ProcessEnv = process.env): void {
  if (!workspaceIdentityReady(env)) {
    throw new Error("OpenClaw workspace identities are not initialized for this boot");
  }
}

async function createProfile(uid: string, env: NodeJS.ProcessEnv): Promise<void> {
  const address = Object.values(os.networkInterfaces()).flatMap(entries => entries ?? []).find(entry => !entry.internal && entry.family === "IPv4")?.address;
  if (!address) throw new Error("Workspace identity initialization requires the pod address");
  const url = new URL(env.OPENCLAW_GATEWAY_URL ?? "http://127.0.0.1:18789");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.protocol !== "http:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error("Workspace identity initialization requires a bare loopback HTTP origin");
  url.protocol = "ws:";
  const ws = new WebSocket(url, { headers: { ...openClawProxyIdentityHeaders({ user: uid, clientAddress: address }), origin: openClawProxyOrigin(env) } });
  ws.on("error", () => {});
  const challenge = startConnectChallengeTracker(ws);
  try {
    await waitForWsOpen(ws, 5000);
    await challenge.wait(5000);
    await sendWsRequest({ ws, id: randomUUID(), method: "connect", timeoutMs: 5000, params: {
      minProtocol: OPENCLAW_PROTOCOL_VERSION, maxProtocol: OPENCLAW_PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", mode: "backend", version: "1.0.0", platform: process.platform }, role: "operator",
    } });
  } finally { ws.terminate(); }
}

function recordOwnerJournal(journalPath: string, ownerUid: string): void {
  if (!fs.existsSync(journalPath)) {
    atomicWrite(journalPath, JSON.stringify({ ownerUid }));
    return;
  }
  const journal: BootstrapJournal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (journal.ownerUid !== ownerUid) throw new Error("Workspace identity initialization journal does not match this owner");
}

export async function bootstrapWorkspaceIdentities(args: {
  request: NativeRequest; env?: NodeJS.ProcessEnv;
  createProfile?: (uid: string, env: NodeJS.ProcessEnv) => Promise<void>;
}): Promise<void> {
  const env = args.env ?? process.env;
  if (!enabled(env)) return;
  const state = files(env);
  const ownerUid = userClaimOwnerUid(env);
  if (!ownerUid) throw new Error("Workspace identity initialization requires this user's claimed owner");
  const boot = fs.readFileSync(state.boot, "utf8");
  const identities: BootstrapIdentity[] = [
    { uid: OPENCLAW_EDGE_SERVICE_IDENTITY, role: "service" },
    { uid: OPENCLAW_PROVISIONER_SERVICE_IDENTITY, role: "service" },
    { uid: ownerUid, role: "admin" },
  ];
  const list = async () => (await args.request<{ profiles: NativeProfile[] }>("users.list", {}, { scopes: ["operator.admin"] })).profiles;
  const find = (profiles: NativeProfile[], uid: string) => profiles.find(profile => profile.emails.includes(uid.toLowerCase()));
  recordOwnerJournal(state.journal, ownerUid);
  for (const identity of identities) {
    let profile = find(await list(), identity.uid);
    if (!profile) {
      await (args.createProfile ?? createProfile)(identity.uid, env);
      profile = find(await list(), identity.uid);
    }
    if (!profile) throw new Error(`OpenClaw did not create the profile for ${identity.uid}`);
    if ((profile.role ?? null) !== identity.role) {
      await args.request("users.setRole", { profileId: profile.id, role: identity.role }, { scopes: ["operator.admin"] });
    }
  }
  if (fs.readFileSync(state.boot, "utf8") !== boot) throw new Error("Workspace identity boot changed during initialization");
  atomicWrite(state.ready, boot);
  atomicWrite(state.owner, ownerUid);
}

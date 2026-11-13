import { Router } from "express";
import { requireAuthenticatedUid } from "../middleware/auth.js";
import { resolveWorkspaceNativeIdentity, WorkspaceNativeAccessError } from "../lib/workspace-native-access.js";
import { openNativeUserClient } from "../openclaw-control/native-user-client.js";
import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

interface NativeProfile { id: string; emails: string[]; role: string | null }
type NativeClient = Awaited<ReturnType<typeof openNativeUserClient>>;

function assignedRole(profile: NativeProfile): string | null {
  return profile.role ?? null;
}

async function verifyRoleAfterReconnect(
  openClient: typeof openNativeUserClient,
  uid: string,
  gatewayId: string,
  profileId: string,
  role: string | null,
): Promise<boolean> {
  const client = await openClient(uid, gatewayId);
  try {
    const refreshed = await client.call<{ profiles: NativeProfile[] }>("users.list", {});
    const updated = refreshed.ok ? refreshed.result.profiles.find(item => item.id === profileId) : undefined;
    return Boolean(updated && assignedRole(updated) === role);
  } finally {
    client.close();
  }
}

function isNativeRole(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= 128;
}
export function createWorkspaceRolesRouter(deps = { resolveIdentity: resolveWorkspaceNativeIdentity, openClient: openNativeUserClient }) {
  const router = Router({ mergeParams: true });
  router.use(requireAuthenticatedUid);
  router.use(async (req, res, next) => {
    if (!isIsolatedGatewayClassValue(process.env.GATEWAY_CLASS) || process.env.OPENCLAW_CONTROL_IDENTITY !== "per-user") {
      res.status(404).json({ error: "builder_workspace_required" }); return;
    }
    next();
  });
  router.get("/", async (req, res, next) => {
    let client: NativeClient | undefined;
    try {
      const identity = await deps.resolveIdentity({ gatewayId: String((req.params as Record<string, string>).gatewayId), authorization: req.headers.authorization });
      client = await deps.openClient(identity.uid, identity.gatewayId);
      if (!client.scopes.has("operator.admin")) {
        res.json({ canManageRoles: false, roles: [], profiles: [] }); return;
      }
      const profiles = await client.call<{ profiles: NativeProfile[] }>("users.list", {});
      const config = await client.call<{ config: { gateway?: { roles?: { default?: string; definitions?: Record<string, unknown> } } } }>("config.get", {});
      if (!profiles.ok) throw new Error(profiles.reason);
      if (!config.ok) throw new Error(config.reason);
      const roles = config.result.config?.gateway?.roles;
      if (!roles?.definitions) throw new Error("OpenClaw role definitions are unavailable");
      res.set("cache-control", "no-store").json({ canManageRoles: true, roles: Object.keys(roles.definitions), defaultRole: roles.default ?? null,
        profiles: profiles.result.profiles.map(({ id, emails, role }) => ({ id, uids: emails, role })) });
    } catch (error) {
      if (error instanceof WorkspaceNativeAccessError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    } finally { client?.close(); }
  });
  router.patch("/:uid", async (req, res, next) => {
    let client: NativeClient | undefined;
    try {
      const role = req.body?.role;
      if (!isNativeRole(role)) { res.status(400).json({ error: "A native OpenClaw role is required" }); return; }
      const identity = await deps.resolveIdentity({ gatewayId: String((req.params as Record<string, string>).gatewayId), authorization: req.headers.authorization, targetUid: String(req.params.uid) });
      client = await deps.openClient(identity.uid, identity.gatewayId);
      const listed = await client.call<{ profiles: NativeProfile[] }>("users.list", {});
      if (!listed.ok) { res.status(403).json({ error: listed.reason }); return; }
      let profile = listed.result.profiles.find(item => item.emails.includes(identity.targetUid!.toLowerCase()));
      if (!profile) {
        const target = await deps.openClient(identity.targetUid!, identity.gatewayId); target.close();
        const refreshed = await client.call<{ profiles: NativeProfile[] }>("users.list", {});
        if (!refreshed.ok) throw new Error(refreshed.reason);
        profile = refreshed.result.profiles.find(item => item.emails.includes(identity.targetUid!.toLowerCase()));
      }
      if (!profile) throw new Error("OpenClaw did not create the member profile");
      const result = await client.call<{ profile: NativeProfile }>("users.setRole", { profileId: profile.id, role });
      if (!result.ok && result.reason === "upstream-ws-closed" && identity.targetUid === identity.uid) {
        client.close();
        client = undefined;
        if (await verifyRoleAfterReconnect(deps.openClient, identity.uid, identity.gatewayId, profile.id, role)) {
          res.set("cache-control", "no-store").json({ role }); return;
        }
        res.status(409).json({ error: "Connection ended while changing your role. Reload to check your current permissions." }); return;
      }
      if (!result.ok) { res.status(403).json({ error: result.reason }); return; }
      res.set("cache-control", "no-store").json({ role: assignedRole(result.result.profile) });
    } catch (error) {
      if (error instanceof WorkspaceNativeAccessError) { res.status(error.status).json({ error: error.message }); return; }
      next(error);
    } finally { client?.close(); }
  });
  return router;
}

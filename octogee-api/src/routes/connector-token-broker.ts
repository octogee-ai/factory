import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import {
  getConnector,
  isConnectorAgentRuntimeTokenMaterializable,
  isConnectorTokenBrokerable,
} from "../../../gateway-edge/src/lib/connectors/index.js";
import { getFreshAccessTokenFromDb } from "../../../gateway-edge/src/lib/connector-tokens.js";
import { decryptSecret } from "../../../gateway-edge/src/lib/kms.js";
import { readServingGatewayAuthorization } from "@octogee/core/gateway-live-release";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;
const OWNER_RUNTIME_ACCESS_KIND = "owner-runtime";

interface ProjectAccessContext {
  kind: "project";
  requestingUid: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface OwnerRuntimeAccessContext {
  kind: typeof OWNER_RUNTIME_ACCESS_KIND;
}

type ConnectorAccessContext = ProjectAccessContext | OwnerRuntimeAccessContext;
type FreshTokenFailureReason = "not_connected" | "reauth_required";
type OwnerRuntimeTokenRead =
  | { status: "connected"; accessToken: string }
  | { status: "disconnected"; reason: FreshTokenFailureReason };

function boundGateway(req: Request, res: Response): GatewayBinding | null {
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  const claimed = (req.body as { gatewayId?: unknown } | undefined)?.gatewayId;
  if (typeof claimed === "string" && claimed.length > 0 && claimed !== bound.gatewayId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return bound;
}

function stringBody(req: Request, key: string): string {
  const value = (req.body as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : "";
}

function requestAccess(req: Request): ConnectorAccessContext | null {
  const access = (req.body as Record<string, unknown> | undefined)?.access;
  if (!access || typeof access !== "object") return null;
  const data = access as Record<string, unknown>;
  if (data.kind === OWNER_RUNTIME_ACCESS_KIND) return { kind: OWNER_RUNTIME_ACCESS_KIND };
  if (data.kind !== "project") return null;
  const requestingUid = typeof data.requestingUid === "string" ? data.requestingUid : "";
  const workspaceSlug = typeof data.workspaceSlug === "string" ? data.workspaceSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  if (
    !safeDocId(requestingUid) ||
    !WORKSPACE_SLUG_RE.test(workspaceSlug) ||
    !PROJECT_ID_RE.test(projectSlug)
  ) {
    return null;
  }
  return { kind: "project", requestingUid, workspaceSlug, projectSlug };
}

function safeDocId(value: string): boolean {
  return value.length > 0 && !value.includes("/");
}

function projectRepoSourceProvider(data: Record<string, unknown> | undefined): string | null {
  const repoSource = data?.repoSource;
  if (!repoSource || typeof repoSource !== "object") return null;
  const provider = (repoSource as Record<string, unknown>).provider;
  return typeof provider === "string" ? provider : null;
}

async function projectAccessAuthorized(
  db: Firestore,
  uid: string,
  connectorId: string,
  access: ProjectAccessContext,
): Promise<boolean> {
  const projectPath = `workspaces/${access.workspaceSlug}/projects/${access.projectSlug}`;
  const projectSnap = await db.doc(projectPath).get();
  if (!projectSnap.exists) return false;
  const project = projectSnap.data() as Record<string, unknown> | undefined;
  if (project?.ownerUid !== uid) return false;
  if (projectRepoSourceProvider(project) !== connectorId) return false;
  if (access.requestingUid === uid) return true;

  const memberSnap = await db.doc(`${projectPath}/members/${access.requestingUid}`).get();
  return memberSnap.exists;
}

async function accessAuthorized(
  db: Firestore,
  bound: GatewayBinding,
  uid: string,
  connectorId: string,
  access: ConnectorAccessContext | null,
): Promise<boolean> {
  if (!safeDocId(uid) || !bound.ownerUid) return false;
  const authorization = await readServingGatewayAuthorization(db, bound.gatewayId);
  if (!authorization || authorization.config.ownerUid !== bound.ownerUid) return false;
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) {
    return (
      uid === bound.ownerUid &&
      (authorization.config.gatewayClass === "builder" ||
        authorization.config.gatewayClass === "operator")
    );
  }
  if (uid === bound.ownerUid) return true;

  if (!access) return false;
  if (access.requestingUid !== bound.ownerUid) return false;
  return projectAccessAuthorized(db, uid, connectorId, access);
}

function connectorAllowedForAccess(
  connectorId: string,
  access: ConnectorAccessContext | null,
): boolean {
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) {
    return isConnectorAgentRuntimeTokenMaterializable(connectorId);
  }
  return isConnectorTokenBrokerable(connectorId);
}

async function readEncryptedAccessToken(
  db: Firestore,
  uid: string,
  connectorId: string,
): Promise<string | null> {
  const snap = await db.doc(`users/${uid}/secrets/${connectorId}`).get();
  const enc = (snap.data() as { tokens?: { encryptedAccessToken?: unknown } } | undefined)
    ?.tokens?.encryptedAccessToken;
  return typeof enc === "string" && enc.length > 0 ? enc : null;
}

async function readOwnerRuntimeAccessToken(
  db: Firestore,
  uid: string,
  connectorId: string,
): Promise<OwnerRuntimeTokenRead> {
  const def = getConnector(connectorId);
  if (!def) return { status: "disconnected", reason: "not_connected" };
  const fresh = await getFreshAccessTokenFromDb(db, uid, def);
  if (!fresh.ok) return { status: "disconnected", reason: fresh.reason };
  return { status: "connected", accessToken: fresh.accessToken };
}

export function createConnectorTokenBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();
  const { db } = opts;

  router.post("/access-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const connectorId = stringBody(req, "connectorId");
    if (!connectorId) {
      res.status(400).json({ error: "connectorId required" });
      return;
    }
    const access = requestAccess(req);
    const uid = access?.kind === OWNER_RUNTIME_ACCESS_KIND ? bound.ownerUid : stringBody(req, "uid");
    if (!uid) {
      res.status(400).json({ error: "uid required" });
      return;
    }
    if (!connectorAllowedForAccess(connectorId, access)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    if (!(await accessAuthorized(db, bound, uid, connectorId, access))) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) {
      const token = await readOwnerRuntimeAccessToken(db, uid, connectorId);
      if (token.status === "disconnected") {
        res.status(token.reason === "reauth_required" ? 409 : 404).json({ error: token.reason });
        return;
      }
      res.json({ accessToken: token.accessToken });
      return;
    }

    const enc = await readEncryptedAccessToken(db, uid, connectorId);
    if (!enc) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ accessToken: await decryptSecret(enc) });
  });

  return router;
}

import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import { isConnectorTokenBrokerable } from "../../../gateway-edge/src/lib/connectors/index.js";
import { decryptSecret } from "../../../gateway-edge/src/lib/kms.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;

interface ProjectAccessContext {
  kind: "project";
  requestingUid: string;
  workspaceSlug: string;
  projectSlug: string;
}

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

function requestAccess(req: Request): ProjectAccessContext | null {
  const access = (req.body as Record<string, unknown> | undefined)?.access;
  if (!access || typeof access !== "object") return null;
  const data = access as Record<string, unknown>;
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
  req: Request,
): Promise<boolean> {
  if (!safeDocId(uid) || !bound.ownerUid) return false;
  if (uid === bound.ownerUid) return true;

  const access = requestAccess(req);
  if (!access) return false;
  if (access.requestingUid !== bound.ownerUid) return false;
  return projectAccessAuthorized(db, uid, connectorId, access);
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

export function createConnectorTokenBrokerRoutes(opts: { db: Firestore }): Router {
  const router = Router();
  const { db } = opts;

  router.post("/access-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const uid = stringBody(req, "uid");
    const connectorId = stringBody(req, "connectorId");
    if (!uid || !connectorId) {
      res.status(400).json({ error: "uid and connectorId required" });
      return;
    }
    if (!isConnectorTokenBrokerable(connectorId)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    if (!(await accessAuthorized(db, bound, uid, connectorId, req))) {
      res.status(403).json(FORBIDDEN);
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

import { Router, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import {
  getConnector,
  isConnectorAgentRuntimeTokenMaterializable,
  isConnectorTokenBrokerable,
} from "../../../gateway-edge/src/lib/connectors/index.js";
import { getFreshAccessTokenFromDb } from "../../../gateway-edge/src/lib/connector-tokens.js";
import { isSafeCanvasPath, resolveCanvasFile } from "../../../gateway-edge/src/lib/canvas-file.js";
import { decryptSecret } from "../../../gateway-edge/src/lib/kms.js";
import { readServingGatewayAuthorization } from "@octogee/core/gateway-live-release";
import type { GatewayPodOwnerIdentityReader } from "../lib/gateway-pod-owner-identity.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const FORBIDDEN = { error: "forbidden" } as const;
const WORKSPACE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PROJECT_ID_RE = /^[a-z0-9]{1,16}$/;
const OWNER_RUNTIME_ACCESS_KIND = "owner-runtime";
const PUBLIC_CANVAS_ACCESS_KIND = "public-canvas";

interface ProjectAccessContext {
  kind: "project";
  requestingUid: string;
  workspaceSlug: string;
  projectSlug: string;
}

interface OwnerRuntimeAccessContext {
  kind: typeof OWNER_RUNTIME_ACCESS_KIND;
  builderSlug: string;
}

interface PublicCanvasAccessContext {
  kind: typeof PUBLIC_CANVAS_ACCESS_KIND;
  workspaceSlug: string;
  projectSlug: string;
  canvasPath: string;
}

type ConnectorAccessContext =
  | ProjectAccessContext
  | OwnerRuntimeAccessContext
  | PublicCanvasAccessContext;
type ParsedAccess =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; value: ConnectorAccessContext };
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

function requestAccess(req: Request): ParsedAccess {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || !("access" in body)) return { status: "absent" };
  const access = body.access;
  if (!access || typeof access !== "object") return { status: "invalid" };
  const data = access as Record<string, unknown>;
  if (data.kind === OWNER_RUNTIME_ACCESS_KIND) return parseOwnerRuntimeAccess(data);
  if (data.kind === PUBLIC_CANVAS_ACCESS_KIND) return parsePublicCanvasAccess(data);
  if (data.kind === "project") return parseProjectAccess(data);
  return { status: "invalid" };
}

function parseOwnerRuntimeAccess(data: Record<string, unknown>): ParsedAccess {
  const builderSlug = typeof data.builderSlug === "string" ? data.builderSlug : "";
  return WORKSPACE_SLUG_RE.test(builderSlug)
    ? { status: "valid", value: { kind: OWNER_RUNTIME_ACCESS_KIND, builderSlug } }
    : { status: "invalid" };
}

function parseProjectAccess(data: Record<string, unknown>): ParsedAccess {
  const requestingUid = typeof data.requestingUid === "string" ? data.requestingUid : "";
  const workspaceSlug = typeof data.workspaceSlug === "string" ? data.workspaceSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  if (
    !safeDocId(requestingUid) ||
    !WORKSPACE_SLUG_RE.test(workspaceSlug) ||
    !PROJECT_ID_RE.test(projectSlug)
  ) {
    return { status: "invalid" };
  }
  return { status: "valid", value: { kind: "project", requestingUid, workspaceSlug, projectSlug } };
}

function parsePublicCanvasAccess(data: Record<string, unknown>): ParsedAccess {
  const workspaceSlug = typeof data.workspaceSlug === "string" ? data.workspaceSlug : "";
  const projectSlug = typeof data.projectSlug === "string" ? data.projectSlug : "";
  const canvasPath = data.canvasPath;
  if (
    !WORKSPACE_SLUG_RE.test(workspaceSlug) ||
    !PROJECT_ID_RE.test(projectSlug) ||
    !isSafeCanvasPath(canvasPath)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "valid",
    value: { kind: PUBLIC_CANVAS_ACCESS_KIND, workspaceSlug, projectSlug, canvasPath },
  };
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

// The public project page has no caller identity, so this kind stands in for one. It
// authorizes a single file — the canvas the owner published — on a listed project, and
// the path is re-derived from the project doc rather than trusted from the request. A
// private repo behind such a project stays private everywhere except that one file.
async function publicCanvasAccessAuthorized(
  db: Firestore,
  uid: string,
  connectorId: string,
  access: PublicCanvasAccessContext,
): Promise<boolean> {
  const projectSnap = await db
    .doc(`workspaces/${access.workspaceSlug}/projects/${access.projectSlug}`)
    .get();
  if (!projectSnap.exists) return false;
  const project = projectSnap.data() as Record<string, unknown> | undefined;
  if (project?.ownerUid !== uid) return false;
  if (projectRepoSourceProvider(project) !== connectorId) return false;
  if (project?.visibility !== "public" && project?.visibility !== "unlisted") return false;
  return access.canvasPath === resolveCanvasFile(project?.canvasFile);
}

async function verifiedGatewayAuthorization(
  db: Firestore,
  bound: GatewayBinding,
  readPodOwnerIdentity: GatewayPodOwnerIdentityReader,
): Promise<{ builderSlug: string; gatewayClass: string } | null> {
  const authorization = await readServingGatewayAuthorization(db, bound.gatewayId);
  if (!authorization || authorization.config.ownerUid !== bound.ownerUid) return null;
  const podOwnerIdentity = await readPodOwnerIdentity({
    podName: bound.podName!,
    podUid: bound.podUid!,
  });
  if (
    !podOwnerIdentity
    || podOwnerIdentity.ownerUid !== authorization.config.ownerUid
    || podOwnerIdentity.builderSlug !== authorization.config.builderSlug
  ) {
    return null;
  }
  return {
    builderSlug: podOwnerIdentity.builderSlug,
    gatewayClass: authorization.config.gatewayClass,
  };
}

async function accessAuthorized(
  input: {
    db: Firestore;
    bound: GatewayBinding;
    uid: string;
    connectorId: string;
    access: ConnectorAccessContext | null;
    readPodOwnerIdentity: GatewayPodOwnerIdentityReader;
  },
): Promise<boolean> {
  const { db, bound, uid, connectorId, access, readPodOwnerIdentity } = input;
  if (!safeDocId(uid) || !bound.ownerUid || !bound.podName || !bound.podUid) return false;
  const authorization = await verifiedGatewayAuthorization(db, bound, readPodOwnerIdentity);
  if (!authorization) return false;
  if (access?.kind === OWNER_RUNTIME_ACCESS_KIND) return ownerRuntimeAccessAuthorized({
    db,
    access,
    uid,
    ownerUid: bound.ownerUid,
    builderSlug: authorization.builderSlug,
    gatewayClass: authorization.gatewayClass,
  });
  if (access?.kind === PUBLIC_CANVAS_ACCESS_KIND) {
    return publicCanvasAccessAuthorized(db, uid, connectorId, access);
  }
  if (uid === bound.ownerUid) return true;

  if (!access) return false;
  if (access.requestingUid !== bound.ownerUid) return false;
  return projectAccessAuthorized(db, uid, connectorId, access);
}

async function ownerRuntimeAccessAuthorized(input: {
  db: Firestore;
  access: OwnerRuntimeAccessContext;
  uid: string;
  ownerUid: string;
  builderSlug: string;
  gatewayClass: string;
}): Promise<boolean> {
  if (
    input.uid !== input.ownerUid
    || input.builderSlug !== input.access.builderSlug
    || (input.gatewayClass !== "builder" && input.gatewayClass !== "operator")
  ) {
    return false;
  }
  const workspace = await input.db.doc(`workspaces/${input.access.builderSlug}`).get();
  const workspaceOwnerUid = workspace.exists
    ? (workspace.data() as Record<string, unknown> | undefined)?.ownerUid
    : undefined;
  return workspaceOwnerUid === input.ownerUid;
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

export function createConnectorTokenBrokerRoutes(opts: {
  db: Firestore;
  readPodOwnerIdentity: GatewayPodOwnerIdentityReader;
}): Router {
  const router = Router();
  const { db, readPodOwnerIdentity } = opts;

  router.post("/access-token", async (req, res) => {
    const bound = boundGateway(req, res);
    if (!bound) return;

    const connectorId = stringBody(req, "connectorId");
    if (!connectorId) {
      res.status(400).json({ error: "connectorId required" });
      return;
    }
    const parsedAccess = requestAccess(req);
    if (parsedAccess.status === "invalid") {
      res.status(400).json({ error: "invalid_access" });
      return;
    }
    const access = parsedAccess.status === "valid" ? parsedAccess.value : null;
    const uid = access?.kind === OWNER_RUNTIME_ACCESS_KIND ? bound.ownerUid : stringBody(req, "uid");
    if (!uid) {
      res.status(400).json({ error: "uid required" });
      return;
    }
    if (!connectorAllowedForAccess(connectorId, access)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    if (!(await accessAuthorized({
      db,
      bound,
      uid,
      connectorId,
      access,
      readPodOwnerIdentity,
    }))) {
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

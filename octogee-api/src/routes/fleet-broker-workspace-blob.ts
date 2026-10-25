import type { Request, Response, Router } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { slugFromAssignedUser, nativeSharedContextRestoreHeld } from "@octogee/core/assigned-roster";
import { parseAssignmentDoc } from "@octogee/core/assignment-doc";
import { isManifestPath } from "@octogee/core/workspace-manifest";
import { parseMultipart, MAX_UPLOAD_BYTES, UploadTooLargeError } from "../../../gateway-edge/src/routes/workspace/upload.js";
import { validateFilePath } from "../../../gateway-edge/src/lib/path-validation.js";
import { pathHasReservedOrHiddenSegment } from "../../../gateway-edge/src/routes/workspace/helpers.js";
import { WorkspaceStorageQuotaError, type storeWorkspaceBlobCentrally } from "../../../gateway-edge/src/lib/workspace-blob.js";
import { logger } from "../../../gateway-edge/src/middleware/logging.js";
import { workspaceGiteaOrg, workspaceRepoName } from "../../../gateway-edge/src/lib/gitea-naming.js";

export type WorkspaceBlobStore = typeof storeWorkspaceBlobCentrally;
interface AssignedWorkspace { uid: string; slug: string; gatewayId: string }
interface WorkspaceBlobBrokerDeps {
  db: Firestore;
  authorize: (req: Request, res: Response, slug: string) => Promise<AssignedWorkspace | null>;
  store?: WorkspaceBlobStore;
}

function workspaceOwnerMatches(user: FirebaseFirestore.DocumentData | undefined, workspace: FirebaseFirestore.DocumentData | undefined, scope: AssignedWorkspace): boolean {
  const openclaw = user?.provisioning?.openclaw;
  return accountAllowsInteractiveAccess(user) && slugFromAssignedUser(user) === scope.slug && openclaw?.gatewayId === scope.gatewayId && openclaw.status === "complete" &&
    !nativeSharedContextRestoreHeld(user) && openclaw.restoreFence === undefined && workspace?.ownerUid === scope.uid && workspace.ownerActive !== false;
}

function checkpointAssignmentMatches(raw: FirebaseFirestore.DocumentData | undefined, scope: AssignedWorkspace): boolean {
  if (!raw) return false;
  const assignment = parseAssignmentDoc(scope.uid, raw);
  return assignment?.slug === scope.slug && assignment.gatewayId === scope.gatewayId && ["serving", "quiescing"].includes(raw.state) &&
    Number.isSafeInteger(raw.epoch) && raw.epoch >= 0 && (raw.uid === undefined || raw.uid === scope.uid);
}

async function canonicalWorkspaceOwned(db: Firestore, scope: AssignedWorkspace): Promise<boolean> {
  return db.runTransaction(async transaction => {
    const [userDoc, workspaceDoc, assignmentDoc] = await Promise.all([
      transaction.get(db.doc(`users/${scope.uid}`)), transaction.get(db.doc(`workspaces/${scope.slug}`)),
      transaction.get(db.doc(`gateways/${scope.gatewayId}/assignments/${scope.uid}`)),
    ]);
    const user = userDoc.data(), workspace = workspaceDoc.data(), raw = assignmentDoc.data();
    return workspaceOwnerMatches(user, workspace, scope) && checkpointAssignmentMatches(raw, scope);
  }, { readOnly: true });
}

const centralStore: WorkspaceBlobStore = async (...args) => (await import("../../../gateway-edge/src/lib/workspace-blob.js")).storeWorkspaceBlobCentrally(...args);

function workspaceBlobPathAllowed(parsed: Awaited<ReturnType<typeof parseMultipart>>): boolean {
  return parsed.projectSlug === null && isManifestPath(parsed.path) && !validateFilePath(parsed.path) && !pathHasReservedOrHiddenSegment(parsed.path) && parsed.path !== "projects" && !parsed.path.startsWith("projects/");
}

export function installWorkspaceBlobBrokerRoute(router: Router, deps: WorkspaceBlobBrokerDeps): void {
  router.post("/blob/workspace/upload", async (req, res) => {
    if (req.boundTenant?.kind !== "gateway") { res.status(403).json({ error: "forbidden" }); return; }
    let parsed: Awaited<ReturnType<typeof parseMultipart>>;
    try { parsed = await parseMultipart(req, MAX_UPLOAD_BYTES, { rejectUnexpectedFields: true }); }
    catch (error) {
      res.status(error instanceof UploadTooLargeError ? 413 : 400).json({ error: "invalid_workspace_blob" }); return;
    }
    if (!workspaceBlobPathAllowed(parsed)) {
      res.status(400).json({ error: "invalid_workspace_blob" }); return;
    }
    const assigned = await deps.authorize(req, res, parsed.slug);
    if (!assigned) return;
    if (!await canonicalWorkspaceOwned(deps.db, assigned)) { res.status(403).json({ error: "forbidden" }); return; }
    try {
      const stored = await (deps.store ?? centralStore)({ slug: assigned.slug, projectSlug: null, gcsPrefix: `customers/${assigned.slug}`, provider: "gitea", org: workspaceGiteaOrg(assigned.slug), repoName: workspaceRepoName() }, parsed.path, parsed.fileBuffer, parsed.mimeType);
      res.json(stored);
    } catch (error) {
      if (error instanceof WorkspaceStorageQuotaError) {
        res.status(413).json({ code: error.code, limitBytes: error.limitBytes, projectedBytes: error.projectedBytes }); return;
      }
      logger.error("workspace blob broker storage failed", { slug: assigned.slug, gatewayId: assigned.gatewayId, error: error instanceof Error ? error.message : String(error) });
      res.status(503).json({ error: "workspace_blob_save_failed" });
    }
  });
}

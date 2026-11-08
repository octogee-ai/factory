import { Router, Request, Response, NextFunction } from "express";
import { db } from "../../lib/db.js";
import { platformStateStore } from "../../lib/platform-state.js";
import {
  WORKSPACE_GATEWAY_STATUS_MAX_SLUGS,
  type WorkspaceGatewayStatus,
  type WorkspaceGatewayStatusResponse,
} from "@octogee/shared/types/gateway-control";
import { isValidUsername } from "@octogee/shared/types/identity";
import { resolveGatewayClass } from "@octogee/shared/types/glm";
import {
  gatewayAuthorizationFromRootDocument,
  readGatewayRuntimeDoc,
} from "@octogee/core/gateway-live-release";
import { isCanonicalWorkspaceMembership } from "@octogee/core/gateway-principal-access";
import { userAssignmentMatchesGateway } from "@octogee/core/assigned-roster";
import {
  projectGatewayRuntimeStatus,
  projectOwnerActivation,
} from "../../lib/gateway-runtime-status.js";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

type RequestedSlugs =
  | { kind: "ok"; slugs: string[] }
  | { kind: "invalid"; error: string };

export function parseRequestedWorkspaceSlugs(raw: unknown): RequestedSlugs {
  if (raw === undefined) return { kind: "ok", slugs: [] };
  if (typeof raw !== "string") return { kind: "invalid", error: "invalid-workspace-slug" };
  const slugs = [...new Set(raw.split(",").map((slug) => slug.trim()).filter((slug) => slug.length > 0))];
  if (slugs.length > WORKSPACE_GATEWAY_STATUS_MAX_SLUGS) return { kind: "invalid", error: "too-many-workspaces" };
  if (!slugs.every((slug) => isValidUsername(slug))) return { kind: "invalid", error: "invalid-workspace-slug" };
  return { kind: "ok", slugs };
}

function workspaceSlugOfMembership(ref: FirebaseFirestore.DocumentReference): string | null {
  const container = ref.parent.parent;
  if (!container) return null;
  if (container.parent.id === "workspaces") return container.id;
  const workspace = container.parent.parent;
  return container.parent.id === "projects" && workspace?.parent.id === "workspaces" ? workspace.id : null;
}

async function memberWorkspaceSlugs(uid: string): Promise<Set<string>> {
  const memberships = await db.collectionGroup("members").where("id", "==", uid).get();
  const slugs = new Set<string>();
  for (const membership of memberships.docs) {
    const slug = workspaceSlugOfMembership(membership.ref);
    if (!slug) continue;
    const workspaceLevel = membership.ref.parent.parent?.parent.id === "workspaces";
    if (!workspaceLevel || isCanonicalWorkspaceMembership(membership.data())) slugs.add(slug);
  }
  return slugs;
}

async function workspaceGatewayStatus(
  workspaceSlug: string,
  ownerUid: string,
  now: number,
): Promise<WorkspaceGatewayStatus> {
  const owner = record((await db.doc(`users/${ownerUid}`).get()).data());
  const assignedGatewayId = record(record(owner?.provisioning)?.openclaw)?.gatewayId;
  const activation = projectOwnerActivation(owner);
  const gatewayId = typeof assignedGatewayId === "string" &&
    userAssignmentMatchesGateway(owner ?? undefined, assignedGatewayId, workspaceSlug)
    ? assignedGatewayId
    : null;
  if (!gatewayId) {
    return { workspaceSlug, gatewayId: null, gatewayClass: null, runtimeStatus: "unknown", activation };
  }
  const root = await db.doc(`gateways/${gatewayId}`).get();
  const authorization = root.exists ? gatewayAuthorizationFromRootDocument(root.data(), gatewayId) : null;
  if (!authorization) {
    return { workspaceSlug, gatewayId, gatewayClass: null, runtimeStatus: "unknown", activation };
  }
  const runtime = await readGatewayRuntimeDoc(platformStateStore, authorization.gateway);
  return {
    workspaceSlug,
    gatewayId,
    gatewayClass: resolveGatewayClass({
      gatewayClass: authorization.config.gatewayClass,
      profile: authorization.config.profile ?? undefined,
      imageProfile: authorization.config.imageProfile,
    }),
    runtimeStatus: projectGatewayRuntimeStatus(runtime, { gatewayId, now }),
    activation,
  };
}

export async function workspaceGatewayStatusesFor(
  uid: string,
  slugs: string[],
  now = Date.now(),
): Promise<WorkspaceGatewayStatus[]> {
  if (slugs.length === 0) return [];
  const memberOf = await memberWorkspaceSlugs(uid);
  const statuses = await Promise.all(slugs.map(async (workspaceSlug) => {
    const workspace = record((await db.doc(`workspaces/${workspaceSlug}`).get()).data());
    const ownerUid = workspace?.ownerUid;
    if (typeof ownerUid !== "string" || ownerUid.length === 0) return null;
    if (ownerUid !== uid && !memberOf.has(workspaceSlug)) return null;
    return workspaceGatewayStatus(workspaceSlug, ownerUid, now);
  }));
  return statuses.filter((status): status is WorkspaceGatewayStatus => status !== null);
}

export function registerWorkspaceGatewayStatusRoute(router: Router): void {
  router.get("/workspaces/gateway-status", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const requested = parseRequestedWorkspaceSlugs(req.query.slugs);
      if (requested.kind === "invalid") {
        res.status(400).json({ error: requested.error });
        return;
      }
      const body: WorkspaceGatewayStatusResponse = {
        workspaces: await workspaceGatewayStatusesFor(req.uid!, requested.slugs),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });
}

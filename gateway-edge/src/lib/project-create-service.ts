import { FieldValue, db } from "./db.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import { getWorkspaceMmContext } from "./mattermost-context.js";
import {
  projectGeneralChannelName,
  isValidProjectId,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
} from "@shared/types/identity.js";
import { projectRepoName } from "./gitea-naming.js";
import { provisionProjectRepo } from "../routes/projects/provisioning.js";
import { isValidGithubRepoSource } from "./github.js";
import type { FleetBrokerProjectCreateInput } from "@shared/types/fleet-broker.js";

const RESERVED_PROJECT_SLUGS = new Set([
  "channels", "members", "files", "canvas", "chat",
  "settings", "discover", "admin", "new", "create",
]);

export interface ProjectCreateActor {
  uid: string;
  userData: FirebaseFirestore.DocumentData | undefined;
  workspaceId: string | null | undefined;
  isAdmin?: boolean;
  source?: "ui" | "agent";
}

export type ProjectCreateInput = FleetBrokerProjectCreateInput;

export interface ProjectCreateResult {
  status: number;
  body: Record<string, unknown>;
}

function validateProjectSlug(slug: string): string | null {
  if (!isValidProjectId(slug)) {
    return `Slug must be ${PROJECT_ID_MIN_LENGTH}-${PROJECT_ID_MAX_LENGTH} chars, lowercase letters and digits only (no hyphens).`;
  }
  if (RESERVED_PROJECT_SLUGS.has(slug)) return "That slug is reserved.";
  return null;
}

type RepoSourceResult =
  | { ok: true; value: { provider: "github"; owner: string; repo: string } | null }
  | { ok: false; status: number; error: string };

function resolveCreateRepoSource(repoSource: unknown, isAdmin: boolean): RepoSourceResult {
  if (repoSource === undefined || repoSource === null) return { ok: true, value: null };
  if (!isAdmin) return { ok: false, status: 403, error: "GitHub-backed projects are operator-only" };
  if (!isValidGithubRepoSource(repoSource)) {
    return { ok: false, status: 400, error: "Invalid repoSource (expected { provider: 'github', owner, repo })" };
  }
  return { ok: true, value: repoSource };
}

function bad(status: number, error: string, extra: Record<string, unknown> = {}): ProjectCreateResult {
  return { status, body: { error, ...extra } };
}

export async function createProjectForActor(
  actor: ProjectCreateActor,
  input: ProjectCreateInput | null | undefined,
): Promise<ProjectCreateResult> {
  const request = input && typeof input === "object" ? input : {};
  const { uid, userData, workspaceId } = actor;
  const name = typeof request.name === "string" ? request.name : "";
  const slug = typeof request.slug === "string" ? request.slug : "";
  const tagline = typeof request.tagline === "string" ? request.tagline : "";
  const category =
    typeof request.category === "string" && request.category.length > 0
      ? request.category
      : "other";
  const projectType =
    typeof request.projectType === "string" && request.projectType.length > 0
      ? request.projectType
      : null;
  const status =
    typeof request.status === "string" && request.status.length > 0
      ? request.status
      : "building";
  const visibility =
    typeof request.visibility === "string" && request.visibility.length > 0
      ? request.visibility
      : "private";
  const { repoSource } = request;

  const trimmedName = name.trim();
  const trimmedTagline = tagline.trim();

  if (trimmedName.length === 0) {
    return bad(400, "Project name is required");
  }
  if (slug.length === 0) {
    return bad(400, "Project slug is required");
  }

  const slugErr = validateProjectSlug(slug);
  if (slugErr) return bad(400, slugErr);

  const rs = resolveCreateRepoSource(repoSource, actor.isAdmin === true);
  if (!rs.ok) return bad(rs.status, rs.error);
  const ghRepoSource = rs.value;

  if (!workspaceId) {
    return bad(422, "Workspace not provisioned");
  }

  const projectRef = db.doc(`workspaces/${workspaceId}/projects/${slug}`);
  const existing = await projectRef.get();
  if (existing.exists) {
    return bad(409, "A project with this slug already exists in your workspace");
  }

  const targetVisibility = visibility || "private";
  const giteaRepoName = projectRepoName(slug);

  await projectRef.set({
    id: slug,
    ownerUid: uid,
    workspaceId,
    slug,
    name: trimmedName,
    tagline: trimmedTagline,
    description: "",
    category,
    projectType,
    status,
    visibility: "private",
    pendingVisibility: targetVisibility,
    provisioningState: "provisioning",
    canvasFile: "README.md",
    previewUrl: null,
    giteaRepoName,
    repoSource: ghRepoSource,
    starCount: 0,
    memberCount: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await projectRef.collection("members").doc(uid).set({
    id: uid,
    role: "owner",
    joinedAt: FieldValue.serverTimestamp(),
  });

  const callerCtx = await getWorkspaceMmContext(uid, workspaceId, userData);
  const teamId = callerCtx?.teamId;
  if (!teamId) {
    await projectRef.update({
      provisioningState: "failed",
      provisioningError: "Workspace has no Mattermost team context",
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.error(`[projects] Create failed - no MM teamId for workspace ${workspaceId}`);
    return bad(502, "Project provisioning failed - workspace chat is not ready", {
      workspaceId,
      slug,
    });
  }

  const channelName = projectGeneralChannelName(workspaceId, slug);
  let mmChannelId: string;
  try {
    const ch = (await mmApi("/channels", "POST", {
      team_id: teamId,
      name: channelName,
      display_name: trimmedName,
      type: "P",
    })) as { id?: string };
    if (!ch?.id) throw new Error("MM returned no channel id");
    mmChannelId = ch.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await projectRef.update({
      provisioningState: "failed",
      provisioningError: message.slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.error(`[projects] MM channel creation failed for ${workspaceId}/${slug}:`, { err });
    return bad(502, "Project provisioning failed - could not create chat channel", {
      workspaceId,
      slug,
    });
  }

  const memberAdds: Array<{ id: string | null; label: string }> = [
    { id: callerCtx.userId, label: "owner" },
    { id: callerCtx.coachUserId, label: "agent" },
  ];
  const memberFailure = await (async (): Promise<string | null> => {
    for (const m of memberAdds) {
      if (!m.id) {
        return `${m.label} has no Mattermost userId - provisioning incomplete`;
      }
      try {
        await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: m.id });
      } catch (err) {
        return `Add ${m.label} ${m.id} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return null;
  })();
  if (memberFailure) {
    await projectRef.update({
      provisioningState: "failed",
      provisioningError: memberFailure.slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.error(`[projects] Channel membership failed for ${workspaceId}/${slug}: ${memberFailure}`);
    return bad(502, "Project provisioning failed - could not add channel members", {
      workspaceId,
      slug,
    });
  }

  await projectRef.collection("channels").doc("general").set({
    id: "general",
    kind: "general",
    name: "general",
    mattermost: { channelId: mmChannelId },
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { provisionActivityPair } = await import("./activityPair.js");
    await provisionActivityPair({
      primaryName: channelName,
      primaryChannelId: mmChannelId,
      teamId,
      type: "P",
      kind: "project",
      members: memberAdds.map((m) => m.id),
      recordActivityChannelId: async (activityChannelId) => {
        await projectRef
          .collection("channels")
          .doc("general")
          .set({ mattermost: { activityChannelId } }, { merge: true });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await projectRef.update({
      provisioningState: "failed",
      provisioningError: message.slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.error(`[projects] activity-pair provisioning failed for ${workspaceId}/${slug}: ${message}`);
    return bad(502, "Project provisioning failed - could not create activity channel", {
      workspaceId,
      slug,
    });
  }

  const repoErr = await provisionProjectRepo({
    workspaceId,
    slug,
    name: trimmedName,
    tagline: trimmedTagline,
    projectType,
    visibility: targetVisibility,
  });
  if (repoErr) {
    await projectRef.update({
      provisioningState: "failed",
      provisioningError: repoErr.slice(0, 500),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.error(`[projects] Gitea repo creation failed for ${workspaceId}/${slug}: ${repoErr}`);
    return bad(502, "Project provisioning failed - could not create code repo", {
      workspaceId,
      slug,
    });
  }

  await projectRef.update({
    provisioningState: "active",
    provisioningError: null,
    visibility: targetVisibility,
    pendingVisibility: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  logger.info(`[projects] Created project ${workspaceId}/${slug}`, {
    source: actor.source ?? "ui",
    uid,
  });

  return {
    status: 200,
    body: {
      success: true,
      workspaceId,
      slug,
      channelId: mmChannelId,
    },
  };
}

export function projectSlugAvailability(slug: string): { ok: true } | { ok: false; reason: string } {
  const err = validateProjectSlug(slug);
  return err ? { ok: false, reason: err } : { ok: true };
}

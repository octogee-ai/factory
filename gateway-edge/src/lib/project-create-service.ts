import { FieldValue, db } from "./db.js";
import { logger } from "../middleware/logging.js";
import { mmApi } from "./mattermost.js";
import { getWorkspaceMmContext, type WorkspaceMmContext } from "./mattermost-context.js";
import {
  projectGeneralChannelName,
  isValidProjectId,
  PROJECT_ID_MIN_LENGTH,
  PROJECT_ID_MAX_LENGTH,
} from "@octogee/shared/types/identity";
import { projectRepoName } from "./gitea-naming.js";
import { provisionProjectRepo } from "../routes/projects/provisioning.js";
import { isValidGithubRepoSource } from "./github.js";
import { resolveEntitlements } from "@octogee/shared/types/billing";
import type { FleetBrokerProjectCreateInput } from "@octogee/shared/types/fleet-broker";

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

interface ProjectCreatePlan {
  uid: string;
  userData: FirebaseFirestore.DocumentData | undefined;
  workspaceId: string;
  slug: string;
  trimmedName: string;
  trimmedTagline: string;
  category: string;
  projectType: string | null;
  status: string;
  targetVisibility: string;
  ghRepoSource: { provider: "github"; owner: string; repo: string } | null;
  giteaRepoName: string;
  source: "ui" | "agent";
}

interface NormalizedProjectCreateRequest {
  name: string;
  slug: string;
  tagline: string;
  category: string;
  projectType: string | null;
  status: string;
  visibility: string;
  repoSource: unknown;
}

interface MattermostMemberAdd {
  id: string | null;
  label: string;
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
  if (!isAdmin) return { ok: false, status: 403, error: "GitHub-backed projects are not enabled for this account" };
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
  const planResult = buildProjectCreatePlan(actor, input);
  if (!planResult.ok) return planResult.result;
  const plan = planResult.plan;

  const projectRef = db.doc(`workspaces/${plan.workspaceId}/projects/${plan.slug}`);
  const existing = await projectRef.get();
  if (existing.exists) {
    // Deterministic 409 before the plan gate — a duplicate slug is a slug
    // problem, not an upgrade prompt, and this avoids the aggregate count read.
    return bad(409, "A project with this slug already exists in your workspace");
  }

  const limitFailure = await enforceProjectLimit(plan);
  if (limitFailure) return limitFailure;

  await writeProvisioningProject(projectRef, plan);
  await writeProjectOwnerMember(projectRef, plan.uid);

  const callerCtx = await getWorkspaceMmContext(plan.uid, plan.workspaceId, plan.userData);
  const channelResult = await provisionProjectMattermost(projectRef, plan, callerCtx);
  if (!channelResult.ok) return channelResult.result;

  const activityResult = await provisionProjectActivityPair(projectRef, plan, channelResult);
  if (!activityResult.ok) return activityResult.result;

  const repoResult = await provisionProjectCodeRepo(projectRef, plan);
  if (!repoResult.ok) return repoResult.result;

  await markProjectActive(projectRef, plan.targetVisibility);
  logger.info(`[projects] Created project ${plan.workspaceId}/${plan.slug}`, {
    source: plan.source,
    uid: plan.uid,
  });

  return {
    status: 200,
    body: {
      success: true,
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      channelId: channelResult.mmChannelId,
    },
  };
}

// Per-plan project ceiling (pricing v3): Personal Free 0, Personal 1, Pro 5,
// Pro Max + any Builder unlimited. Counts only the actor's OWN projects in the
// workspace (membership is independent), and skips the read entirely on an
// unlimited plan. A 402 so the client can route to upgrade.
async function enforceProjectLimit(
  plan: ProjectCreatePlan,
): Promise<ProjectCreateResult | null> {
  const maxProjects = resolveEntitlements(plan.userData ?? {}).maxProjects;
  if (maxProjects === "unlimited") return null;

  // Personal Free (0) can never create — 402 without the count read.
  if (maxProjects <= 0) {
    return bad(402, "Projects are available on paid plans — upgrade to start building", { maxProjects });
  }

  const owned = await db
    .collection(`workspaces/${plan.workspaceId}/projects`)
    .where("ownerUid", "==", plan.uid)
    .count()
    .get();
  if (owned.data().count < maxProjects) return null;

  return bad(
    402,
    `Your plan includes ${maxProjects} project${maxProjects === 1 ? "" : "s"}. Upgrade for more.`,
    { maxProjects },
  );
}

function buildProjectCreatePlan(
  actor: ProjectCreateActor,
  input: ProjectCreateInput | null | undefined,
): { ok: true; plan: ProjectCreatePlan } | { ok: false; result: ProjectCreateResult } {
  const { uid, userData, workspaceId } = actor;
  const request = normalizeProjectCreateRequest(input);
  const validation = validateProjectCreateRequest(request);
  if (!validation.ok) return validation;

  const rs = resolveCreateRepoSource(request.repoSource, actor.isAdmin === true);
  if (!rs.ok) return { ok: false, result: bad(rs.status, rs.error) };

  if (!workspaceId) {
    return { ok: false, result: bad(422, "Workspace not provisioned") };
  }

  return {
    ok: true,
    plan: {
      uid,
      userData,
      workspaceId,
      slug: request.slug,
      trimmedName: validation.trimmedName,
      trimmedTagline: request.tagline.trim(),
      category: request.category,
      projectType: request.projectType,
      status: request.status,
      targetVisibility: request.visibility,
      ghRepoSource: rs.value,
      giteaRepoName: projectRepoName(request.slug),
      source: actor.source ?? "ui",
    },
  };
}

function normalizeProjectCreateRequest(
  input: ProjectCreateInput | null | undefined,
): NormalizedProjectCreateRequest {
  const request = input && typeof input === "object" ? input : {};
  return {
    name: stringValue(request.name),
    slug: stringValue(request.slug),
    tagline: stringValue(request.tagline),
    category: nonEmptyStringOr(request.category, "other"),
    projectType: nonEmptyStringOr(request.projectType, null),
    status: nonEmptyStringOr(request.status, "building"),
    visibility: nonEmptyStringOr(request.visibility, "private"),
    repoSource: request.repoSource,
  };
}

function validateProjectCreateRequest(
  request: NormalizedProjectCreateRequest,
): { ok: true; trimmedName: string } | { ok: false; result: ProjectCreateResult } {
  const trimmedName = request.name.trim();
  if (trimmedName.length === 0) {
    return { ok: false, result: bad(400, "Project name is required") };
  }
  if (request.slug.length === 0) {
    return { ok: false, result: bad(400, "Project slug is required") };
  }
  const slugErr = validateProjectSlug(request.slug);
  return slugErr
    ? { ok: false, result: bad(400, slugErr) }
    : { ok: true, trimmedName };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nonEmptyStringOr<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

async function writeProvisioningProject(
  projectRef: FirebaseFirestore.DocumentReference,
  plan: ProjectCreatePlan,
): Promise<void> {
  await projectRef.set({
    id: plan.slug,
    ownerUid: plan.uid,
    workspaceId: plan.workspaceId,
    slug: plan.slug,
    name: plan.trimmedName,
    tagline: plan.trimmedTagline,
    description: "",
    category: plan.category,
    projectType: plan.projectType,
    status: plan.status,
    visibility: "private",
    pendingVisibility: plan.targetVisibility,
    provisioningState: "provisioning",
    canvasFile: "README.md",
    publishedUrl: null,
    giteaRepoName: plan.giteaRepoName,
    repoSource: plan.ghRepoSource,
    starCount: 0,
    memberCount: 1,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

async function writeProjectOwnerMember(
  projectRef: FirebaseFirestore.DocumentReference,
  uid: string,
): Promise<void> {
  await projectRef.collection("members").doc(uid).set({
    id: uid,
    role: "owner",
    joinedAt: FieldValue.serverTimestamp(),
  });
}

async function provisionProjectMattermost(
  projectRef: FirebaseFirestore.DocumentReference,
  plan: ProjectCreatePlan,
  callerCtx: WorkspaceMmContext | null,
): Promise<
  | { ok: true; teamId: string; mmChannelId: string; memberAdds: MattermostMemberAdd[] }
  | { ok: false; result: ProjectCreateResult }
> {
  const teamId = callerCtx?.teamId;
  if (!teamId) {
    return failProjectProvisioning(projectRef, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      provisioningError: "Workspace has no Mattermost team context",
      logMessage: `[projects] Create failed - no MM teamId for workspace ${plan.workspaceId}`,
      responseError: "Project provisioning failed - workspace chat is not ready",
    });
  }

  const channelResult = await createMattermostProjectChannel(projectRef, plan, teamId);
  if (!channelResult.ok) return channelResult;

  const memberAdds = mattermostMemberAdds(callerCtx);
  const memberFailure = await addMattermostChannelMembers(channelResult.mmChannelId, memberAdds);
  if (memberFailure) {
    return failProjectProvisioning(projectRef, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      provisioningError: memberFailure,
      logMessage: `[projects] Channel membership failed for ${plan.workspaceId}/${plan.slug}: ${memberFailure}`,
      responseError: "Project provisioning failed - could not add channel members",
    });
  }

  await writeProjectGeneralChannel(projectRef, channelResult.mmChannelId);
  return { ok: true, teamId, mmChannelId: channelResult.mmChannelId, memberAdds };
}

async function createMattermostProjectChannel(
  projectRef: FirebaseFirestore.DocumentReference,
  plan: ProjectCreatePlan,
  teamId: string,
): Promise<{ ok: true; mmChannelId: string } | { ok: false; result: ProjectCreateResult }> {
  const channelName = projectGeneralChannelName(plan.workspaceId, plan.slug);
  try {
    const ch = (await mmApi("/channels", "POST", {
      team_id: teamId,
      name: channelName,
      display_name: plan.trimmedName,
      type: "P",
    })) as { id?: string };
    if (!ch?.id) throw new Error("MM returned no channel id");
    return { ok: true, mmChannelId: ch.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failProjectProvisioning(projectRef, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      provisioningError: message,
      logMessage: `[projects] MM channel creation failed for ${plan.workspaceId}/${plan.slug}:`,
      logMeta: { err },
      responseError: "Project provisioning failed - could not create chat channel",
    });
  }
}

function mattermostMemberAdds(callerCtx: WorkspaceMmContext): MattermostMemberAdd[] {
  return [
    { id: callerCtx.userId, label: "owner" },
    { id: callerCtx.coachUserId, label: "agent" },
  ];
}

async function addMattermostChannelMembers(
  mmChannelId: string,
  memberAdds: MattermostMemberAdd[],
): Promise<string | null> {
  for (const m of memberAdds) {
    const failure = await addMattermostChannelMember(mmChannelId, m);
    if (failure) return failure;
  }
  return null;
}

async function addMattermostChannelMember(
  mmChannelId: string,
  member: MattermostMemberAdd,
): Promise<string | null> {
  if (!member.id) return `${member.label} has no Mattermost userId - provisioning incomplete`;
  try {
    await mmApi(`/channels/${mmChannelId}/members`, "POST", { user_id: member.id });
    return null;
  } catch (err) {
    return `Add ${member.label} ${member.id} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function writeProjectGeneralChannel(
  projectRef: FirebaseFirestore.DocumentReference,
  mmChannelId: string,
): Promise<void> {
  await projectRef.collection("channels").doc("general").set({
    id: "general",
    kind: "general",
    name: "general",
    mattermost: { channelId: mmChannelId },
    createdAt: FieldValue.serverTimestamp(),
  });
}

async function provisionProjectActivityPair(
  projectRef: FirebaseFirestore.DocumentReference,
  plan: ProjectCreatePlan,
  channel: { teamId: string; mmChannelId: string; memberAdds: MattermostMemberAdd[] },
): Promise<{ ok: true } | { ok: false; result: ProjectCreateResult }> {
  try {
    const { provisionActivityPair } = await import("./activityPair.js");
    await provisionActivityPair({
      primaryName: projectGeneralChannelName(plan.workspaceId, plan.slug),
      primaryChannelId: channel.mmChannelId,
      teamId: channel.teamId,
      type: "P",
      kind: "project",
      members: channel.memberAdds.map((m) => m.id),
      recordActivityChannelId: async (activityChannelId) => {
        await projectRef
          .collection("channels")
          .doc("general")
          .set({ mattermost: { activityChannelId } }, { merge: true });
      },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failProjectProvisioning(projectRef, {
      workspaceId: plan.workspaceId,
      slug: plan.slug,
      provisioningError: message,
      logMessage: `[projects] activity-pair provisioning failed for ${plan.workspaceId}/${plan.slug}: ${message}`,
      responseError: "Project provisioning failed - could not create activity channel",
    });
  }
}

async function provisionProjectCodeRepo(
  projectRef: FirebaseFirestore.DocumentReference,
  plan: ProjectCreatePlan,
): Promise<{ ok: true } | { ok: false; result: ProjectCreateResult }> {
  const repoErr = await provisionProjectRepo({
    workspaceId: plan.workspaceId,
    slug: plan.slug,
    name: plan.trimmedName,
    tagline: plan.trimmedTagline,
    projectType: plan.projectType,
    visibility: plan.targetVisibility,
  });
  if (!repoErr) return { ok: true };
  return failProjectProvisioning(projectRef, {
    workspaceId: plan.workspaceId,
    slug: plan.slug,
    provisioningError: repoErr,
    logMessage: `[projects] Gitea repo creation failed for ${plan.workspaceId}/${plan.slug}: ${repoErr}`,
    responseError: "Project provisioning failed - could not create code repo",
  });
}

async function failProjectProvisioning(
  projectRef: FirebaseFirestore.DocumentReference,
  args: {
    workspaceId: string;
    slug: string;
    provisioningError: string;
    logMessage: string;
    responseError: string;
    logMeta?: Record<string, unknown>;
  },
): Promise<{ ok: false; result: ProjectCreateResult }> {
  await projectRef.update({
    provisioningState: "failed",
    provisioningError: args.provisioningError.slice(0, 500),
    updatedAt: FieldValue.serverTimestamp(),
  });
  if (args.logMeta) {
    logger.error(args.logMessage, args.logMeta);
  } else {
    logger.error(args.logMessage);
  }
  return {
    ok: false,
    result: bad(502, args.responseError, {
      workspaceId: args.workspaceId,
      slug: args.slug,
    }),
  };
}

async function markProjectActive(
  projectRef: FirebaseFirestore.DocumentReference,
  targetVisibility: string,
): Promise<void> {
  await projectRef.update({
    provisioningState: "active",
    provisioningError: null,
    visibility: targetVisibility,
    pendingVisibility: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

export function projectSlugAvailability(slug: string): { ok: true } | { ok: false; reason: string } {
  const err = validateProjectSlug(slug);
  return err ? { ok: false, reason: err } : { ok: true };
}

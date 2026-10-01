import { logger } from "../middleware/logging.js";
import { db, FieldValue } from "./db.js";
import { readAgent } from "./firestoreReads.js";
import { mmApi, mmUploadAvatarBuffer } from "./mattermost.js";
import { resolveFileTarget, type FileTarget } from "./fileTarget.js";
import { storeWorkspaceBlob, removeWorkspaceBlob } from "./workspace-blob.js";
import { parseAgentLook, type AgentLook } from "@octogee/shared/types/agent-look";

export interface CoachIdentityPatch {
  name?: string;
  persona?: string;
  emoji?: string;
  /** Speech-engine voice id for Talk mode; "" restores the engine default. */
  voice?: string;
  avatarPng?: Buffer;
  look?: AgentLook;
}

export interface CoachIdentityContext {
  slug?: string;
}

export interface CoachTextIdentitySnapshot {
  name: string | null;
  persona: string | null;
  emoji: string | null;
}

export function avatarFileName(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9 _-]/g, "").trim().replace(/\s+/g, "-");
  return `${base || "Coach"}-avatar.png`;
}

async function workspaceTarget(slug: string, uid: string): Promise<FileTarget> {
  const result = await resolveFileTarget({
    slug,
    projectSlug: null,
    callerUid: uid,
    callerWorkspaceSlug: slug,
  });
  if (!result.ok) throw new Error(`workspace target unavailable for ${slug}: ${result.error}`);
  return result.target;
}

function applyTextIdentity(
  update: Record<string, unknown>,
  updated: string[],
  patch: CoachIdentityPatch,
): void {
  if (typeof patch.name === "string" && patch.name) {
    update.name = patch.name;
    updated.push("name");
  }
  if (typeof patch.persona === "string") {
    update.persona = patch.persona;
    updated.push("persona");
  }
  if (typeof patch.emoji === "string" && patch.emoji) {
    update.avatarEmoji = patch.emoji;
    updated.push("emoji");
  }
  if (typeof patch.voice === "string") {
    update.voice = patch.voice;
    updated.push("voice");
  }
}

async function removeOldAvatar(target: FileTarget, uid: string, oldPath: string | undefined, nextPath: string): Promise<void> {
  if (!oldPath || oldPath === nextPath) return;
  await removeWorkspaceBlob(target, oldPath).catch((err) =>
    logger.warn("stale coach avatar cleanup failed (non-fatal)", {
      uid,
      oldPath,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

async function applyAvatarIdentity(args: {
  uid: string;
  patch: CoachIdentityPatch;
  ctx: CoachIdentityContext;
  agent: Awaited<ReturnType<typeof readAgent>>;
  update: Record<string, unknown>;
  updated: string[];
}): Promise<void> {
  const { uid, patch, ctx, agent, update, updated } = args;
  if (!patch.avatarPng) return;
  if (!ctx.slug) throw new Error("slug required to persist the coach avatar");
  const fileName = avatarFileName((patch.name ?? agent?.name ?? "") || "Coach");
  const target = await workspaceTarget(ctx.slug, uid);
  const { gcsPath } = await storeWorkspaceBlob(target, fileName, patch.avatarPng, "image/png");
  update.avatar = { path: fileName, gcsPath, updatedAt: FieldValue.serverTimestamp() };
  update.avatarVersion = FieldValue.increment(1);
  update.look = patch.look ?? FieldValue.delete();
  updated.push("avatar");
  await removeOldAvatar(target, uid, agent?.avatar?.path, fileName);
}

export async function syncCoachIdentity(
  uid: string,
  patch: CoachIdentityPatch,
  ctx: CoachIdentityContext = {},
): Promise<string[]> {
  if (patch.look !== undefined && !parseAgentLook(patch.look)) {
    throw new Error(`coach look must be a known style with a #rrggbb colour, got ${JSON.stringify(patch.look)}`);
  }
  const update: Record<string, unknown> = {
    id: uid,
    updatedAt: FieldValue.serverTimestamp(),
  };
  const updated: string[] = [];

  applyTextIdentity(update, updated, patch);
  const agent = patch.avatarPng || patch.name ? await readAgent(uid) : null;
  await applyAvatarIdentity({ uid, patch, ctx, agent, update, updated });

  if (updated.length === 0) return [];

  // Only the avatar constrains ordering: the client re-fetches the MM image the
  // instant avatarVersion changes, so the upload must land first. Name-only
  // updates stay Firestore-first — the app reads the name from Firestore and the
  // MM bot rename is best-effort, so a failed MM call can't strand the write.
  if (patch.avatarPng) {
    await syncCoachToMattermost(uid, patch, agent);
    await db.doc(`agents/${uid}`).set(update, { merge: true });
  } else {
    await db.doc(`agents/${uid}`).set(update, { merge: true });
    await syncCoachToMattermost(uid, patch, agent);
  }
  return updated;
}

export async function replaceCoachTextIdentity(
  uid: string,
  identity: CoachTextIdentitySnapshot,
): Promise<void> {
  const agent = await readAgent(uid);
  await db.doc(`agents/${uid}`).set({
    id: uid,
    updatedAt: FieldValue.serverTimestamp(),
    name: identity.name ?? FieldValue.delete(),
    persona: identity.persona ?? FieldValue.delete(),
    avatarEmoji: identity.emoji ?? FieldValue.delete(),
  }, { merge: true });
  await syncCoachToMattermost(uid, { name: identity.name ?? "Coach" }, agent);
}

async function syncCoachToMattermost(
  uid: string,
  patch: CoachIdentityPatch,
  preread: Awaited<ReturnType<typeof readAgent>>,
): Promise<void> {
  if (!patch.name && !patch.avatarPng) return;
  try {
    const agent = preread ?? (await readAgent(uid));
    const coachMmUserId = agent?.mattermost?.userId;
    if (!coachMmUserId) return;
    if (patch.name) {
      await mmApi(`/bots/${coachMmUserId}`, "PUT", { display_name: patch.name });
    }
    if (patch.avatarPng) {
      await mmUploadAvatarBuffer(coachMmUserId, patch.avatarPng);
    }
  } catch (err) {
    logger.warn("coach identity Mattermost sync failed (non-fatal)", {
      uid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

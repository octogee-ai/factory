import { addAbortSignal } from "node:stream";
import sharp from "sharp";
import { db, storage } from "../../../gateway-edge/src/lib/db.js";
import { MM_URL } from "../../../gateway-edge/src/lib/mattermost.js";
import type { OpenClawProfileAppearance } from "../../../gateway-edge/src/openclaw-control/proxy-identity.js";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const PROFILE_TIMEOUT_MS = 5_000;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fullName(first: unknown, last: unknown): string {
  return [text(first), text(last)].filter(Boolean).join(" ");
}

function mattermostName(user: Record<string, unknown>): string {
  return fullName(user.first_name, user.last_name) || text(user.nickname) || text(user.username);
}

async function avatarJpeg(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > MAX_AVATAR_BYTES) throw new Error("Avatar exceeds 5 MB");
    chunks.push(Buffer.from(chunk));
  }
  return sharp(Buffer.concat(chunks), { limitInputPixels: 16_777_216 })
    .resize(256, 256, { fit: "cover", position: "centre" })
    .jpeg({ quality: 85 }).toBuffer();
}

async function mattermostProfileRequest(path: string, token: string): Promise<Response> {
  const response = await fetch(`${MM_URL}/api/v4${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Mattermost profile request failed: ${response.status}`);
  }
  return response;
}

async function uploadedAvatar(uid: string): Promise<OpenClawProfileAppearance["avatar"]> {
  const bucket = storage.bucket();
  const objectPath = `avatars/${uid}/user.jpg`;
  let generation: string;
  try {
    const [metadata] = await bucket.file(objectPath).getMetadata();
    generation = text(metadata.generation);
    if (!generation) throw new Error("Uploaded avatar has no storage generation");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === 404) return null;
    throw error;
  }
  return {
    revision: `octogee:${generation}`,
    read: () => avatarJpeg(addAbortSignal(
      AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      bucket.file(objectPath, { generation }).createReadStream(),
    )),
  };
}

async function mattermostAppearance(uid: string, mmUserId: string): Promise<OpenClawProfileAppearance> {
  const secret = await db.doc(`users/${uid}/secrets/mattermost`).get();
  const token = text(secret.data()?.personalToken);
  if (!token) throw new Error("Mattermost personal token missing for profile sync");
  const mmUser = await (await mattermostProfileRequest("/users/me", token)).json() as Record<string, unknown>;
  if (mmUser.id !== mmUserId) throw new Error("Mattermost profile identity mismatch");
  return {
    displayName: mattermostName(mmUser) || null,
    avatar: {
      revision: `mattermost:${mmUserId}:${mmUser.last_picture_update ?? 0}`,
      read: async () => {
        const response = await mattermostProfileRequest(`/users/${encodeURIComponent(mmUserId)}/image`, token);
        if (!response.body) throw new Error("Mattermost avatar response has no body");
        return avatarJpeg(response.body);
      },
    },
  };
}

export async function loadOpenClawProfileAppearance(uid: string): Promise<OpenClawProfileAppearance> {
  const [userSnap, publicSnap] = await Promise.all([
    db.doc(`users/${uid}`).get(),
    db.doc(`users/${uid}/profile/public`).get(),
  ]);
  if (!userSnap.exists) throw new Error("Octogee user not found for profile sync");
  const user = userSnap.data()!;
  const profile = publicSnap.data() ?? {};
  const avatar = await uploadedAvatar(uid);
  const mmUserId = text(user.mattermost?.userId);
  const displayName = text(profile.displayName) || text(user.displayName)
    || fullName(user.firstName, user.lastName);
  const mattermost = mmUserId && (!displayName || !avatar)
    ? await mattermostAppearance(uid, mmUserId) : null;
  return {
    displayName: displayName || mattermost?.displayName || null,
    avatar: avatar ?? mattermost?.avatar ?? null,
  };
}

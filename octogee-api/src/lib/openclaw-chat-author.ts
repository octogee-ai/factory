import { authorizeChannel } from "../../../gateway-edge/src/lib/channel-session-authorization.js";
import { db } from "../../../gateway-edge/src/lib/db.js";
import { USERNAME_RE } from "@octogee/shared/types/identity";

export async function resolveOpenClawChatAuthor(
  viewerUid: string,
  workspaceSlug: string,
  channelId: string,
  postId: string,
): Promise<{ uid: string; username: string; mattermostUserId: string } | null> {
  const access = await authorizeChannel(viewerUid, channelId, workspaceSlug, {
    requireActiveLedger: true, signal: AbortSignal.timeout(5_000),
  });
  if (!access || access.forbidden) throw new Error("Chat author channel access denied");
  const post = await access.client.getJson(["posts", postId]) as Record<string, unknown>;
  if (post.id !== postId || post.channel_id !== channelId || typeof post.user_id !== "string") {
    throw new Error("Chat author post does not belong to the authorized channel");
  }
  const users = await db.collection("users").where("mattermost.userId", "==", post.user_id).limit(2).get();
  if (users.docs.length === 0) return null;
  if (users.docs.length !== 1) throw new Error("Chat author Mattermost identity is ambiguous");
  const user = users.docs[0]!;
  const username: unknown = user.data().username;
  if (typeof username !== "string" || !USERNAME_RE.test(username)) throw new Error("Chat author builder slug is invalid");
  return { uid: user.id, username, mattermostUserId: post.user_id };
}

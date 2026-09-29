import { mattermostAccountIdForAgentId } from "@octogee/shared/types/identity";
import { parseMattermostSessionRoute } from "@octogee/shared/types/mattermost-session-route";
const FIELDS = new Set(["schemaVersion", "accountId", "sessionKey", "to", "messageId"]);
export function parseFinalReply(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const body = value;
    if (Object.keys(body).some(key => !FIELDS.has(key)) || body.schemaVersion !== 1
        || typeof body.accountId !== "string" || !/^[a-z0-9-]{1,128}$/u.test(body.accountId)
        || typeof body.sessionKey !== "string" || body.sessionKey.length > 512 || !body.sessionKey
        || typeof body.to !== "string" || !/^(?:channel|user):[a-z0-9]{26}$/u.test(body.to)
        || typeof body.messageId !== "string" || !/^[a-z0-9]{26}$/u.test(body.messageId))
        return null;
    return { schemaVersion: 1, accountId: body.accountId, sessionKey: body.sessionKey,
        to: body.to, messageId: body.messageId };
}
export class ReplyBindingDeniedError extends Error {
    constructor() { super("reply_binding_denied"); }
}
function authorizedRoute(input) {
    const route = parseMattermostSessionRoute(input.sessionKey);
    if (!route || mattermostAccountIdForAgentId(route.agentId) !== input.accountId
        || input.to !== `${route.peerKind === "direct" ? "user" : "channel"}:${route.primaryChannelId}`) {
        throw new ReplyBindingDeniedError();
    }
    return route;
}
function matchesThread(post, route) {
    if (route.threadRootPostId !== undefined)
        return post.rootId === route.threadRootPostId;
    return route.peerKind !== "direct" || post.rootId === "";
}
function authorizedPost(post, input, route, identity) {
    return Boolean(post && post.id === input.messageId && post.userId === identity.coachMmUserId
        && !post.deleteAt && matchesThread(post, route)
        && (route.peerKind === "direct" || post.channelId === route.primaryChannelId));
}
function authorizedTarget(target, route, identity, channelId) {
    if (!target || target.primaryChannelId !== channelId || !target.recipientUid || !target.recipientMmUserId)
        return false;
    if (route.peerKind === "direct") {
        return target.expectedChannelType === "D" && target.recipientUid === identity.uid
            && target.recipientMmUserId === route.primaryChannelId && target.expectedMemberIds?.length === 2
            && target.expectedMemberIds.includes(identity.coachMmUserId)
            && target.expectedMemberIds.includes(route.primaryChannelId);
    }
    return target.expectedChannelType === "P" && target.expectedMemberIds === undefined
        && Boolean(target.expectedChannelName && target.expectedChannelTeamId);
}
export async function notifyNativeFinalReply(input, deps) {
    const route = authorizedRoute(input);
    const identity = await deps.resolveAgentIdentity(route.agentId);
    if (!identity || identity.agentId !== route.agentId || !identity.coachMmUserId || !identity.coachToken) {
        throw new ReplyBindingDeniedError();
    }
    const post = await deps.getPost(identity, input.messageId);
    if (!authorizedPost(post, input, route, identity))
        throw new ReplyBindingDeniedError();
    const target = await deps.resolveReplyTarget(identity, post.channelId, route.peerKind === "direct" ? route.primaryChannelId : undefined);
    if (!authorizedTarget(target, route, identity, post.channelId))
        throw new ReplyBindingDeniedError();
    await deps.verifyChannel(identity, target);
    const message = post.message?.trim() || (post.fileIds.length ? "Sent an attachment" : "");
    if (!message)
        return;
    await deps.notify({ coachMmUserId: identity.coachMmUserId, channelId: post.channelId,
        postId: post.id, message }, target.recipientUid);
}

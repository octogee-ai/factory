export interface NativeFinalReply {
    schemaVersion: 1;
    accountId: string;
    sessionKey: string;
    to: string;
    messageId: string;
}
export declare function parseFinalReply(value: unknown): NativeFinalReply | null;
export interface FinalReplyIdentity {
    agentId: string;
    uid: string;
    defaultAgentMmUserId: string;
    coachToken: string;
}
export interface FinalReplyPost {
    id: string;
    channelId: string;
    rootId: string;
    userId?: string;
    message?: string;
    fileIds: string[];
    deleteAt?: number;
}
export interface FinalReplyTarget {
    primaryChannelId: string;
    expectedChannelType: "P" | "D";
    expectedChannelName: string | null;
    expectedChannelTeamId: string | null;
    expectedMemberIds?: string[];
    recipientUid: string;
    recipientMmUserId: string;
}
export interface FinalReplyNotification {
    defaultAgentMmUserId: string;
    channelId: string;
    postId: string;
    message: string;
}
export interface NativeFinalReplyDeps {
    resolveAgentIdentity(agentId: string): Promise<FinalReplyIdentity | null>;
    resolveReplyTarget(identity: FinalReplyIdentity, channelId: string, directPeerId?: string): Promise<FinalReplyTarget | null>;
    verifyChannel(identity: FinalReplyIdentity, target: FinalReplyTarget): Promise<unknown>;
    getPost(identity: FinalReplyIdentity, postId: string): Promise<FinalReplyPost | null>;
    notify(signal: FinalReplyNotification, recipientUid: string): Promise<void>;
}
export declare class ReplyBindingDeniedError extends Error {
    constructor();
}
export declare function notifyNativeFinalReply(input: NativeFinalReply, deps: NativeFinalReplyDeps): Promise<void>;

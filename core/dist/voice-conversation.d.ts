export declare class VoiceConversationAccessError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare class VoiceConversationConfigurationError extends Error {
    constructor();
}
export declare const VOICE_TURN_POST_KIND = "voice-turn";
export declare const VOICE_TURN_MARKER = "\uD83C\uDF99";
export declare const VOICE_TURN_TEXT_MAX = 8000;
export declare const VOICE_ARCHIVE_POST_KIND = "voice-archive";
export declare const VOICE_ARCHIVE_ENTRIES_MAX = 128;
export declare const VOICE_ARCHIVE_ENTRY_TEXT_MAX = 2000;
export declare const VOICE_ARCHIVE_TEXT_MAX = 12000;
export declare const VOICE_ARCHIVE_TRANSCRIPT_ID_MAX = 256;
export declare function voiceTurnMessage(transcript: string): string;
export interface VoiceConversation {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    channelId: string;
    threadRootPostId: string;
    agentId: string;
    sessionKey: string;
    callerMmUserId: string;
    nativeInterrupt: boolean;
}
export interface VoiceGrantRequest {
    voiceGrant: string;
    sessionId: string;
}
export interface VoiceGrantEndRequest {
    voiceGrant: string;
    sessionId?: string;
}
export interface VoiceGrantBinding extends VoiceConversation {
    sessionId: string;
    expiresAt: number;
}
export interface VoiceTurnRequest extends VoiceGrantRequest {
    text: string;
    turnId: string;
    ingressToken?: string;
}
export interface VoiceArchiveEntry {
    transcriptId: string;
    role: 'user' | 'assistant';
    text: string;
}
export interface VoiceArchiveRequest extends VoiceGrantRequest {
    entries: readonly VoiceArchiveEntry[];
    truncated: boolean;
}
export interface VoiceTurnPost {
    postId: string;
    channelId: string;
    threadRootPostId: string;
    userId: string;
}
export declare function isVoiceGrantRequest(value: unknown): value is VoiceGrantRequest;
export declare function isVoiceGrantEndRequest(value: unknown): value is VoiceGrantEndRequest;
export declare function isVoiceTurnRequest(value: unknown): value is VoiceTurnRequest;
export declare function isVoiceArchiveRequest(value: unknown): value is VoiceArchiveRequest;
export interface VoiceBrokerOptions {
    brokerUrl?: string;
    tokenPath?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}
export declare function resolveVoiceConversation(args: {
    uid: string;
    gatewayId: string;
    channelId: string;
    threadRootPostId: string;
    expectedAgentId?: string;
} & VoiceBrokerOptions): Promise<VoiceConversation>;
export declare function bindVoiceGrant(args: VoiceGrantRequest & VoiceBrokerOptions): Promise<VoiceGrantBinding>;
export declare function endVoiceGrant(args: VoiceGrantEndRequest & VoiceBrokerOptions): Promise<{
    revoked: true;
}>;
export declare function postVoiceTurn(args: VoiceTurnRequest & VoiceBrokerOptions): Promise<VoiceTurnPost>;
export declare function archiveVoiceCall(args: VoiceArchiveRequest & VoiceBrokerOptions): Promise<VoiceTurnPost>;

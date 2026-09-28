export declare class VoiceConversationAccessError extends Error {
    readonly status: number;
    constructor(status: number, message: string);
}
export declare const VOICE_TURN_POST_KIND = "voice-turn";
export declare const VOICE_TURN_MARKER = "\uD83C\uDF99";
export declare const VOICE_TURN_TEXT_MAX = 8000;
export declare function voiceTurnMessage(transcript: string): string;
export interface VoiceConversation {
    uid: string;
    gatewayId: string;
    workspaceSlug: string;
    channelId: string;
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
export interface VoiceTurnPost {
    postId: string;
    channelId: string;
    userId: string;
}
export declare function isVoiceGrantRequest(value: unknown): value is VoiceGrantRequest;
export declare function isVoiceGrantEndRequest(value: unknown): value is VoiceGrantEndRequest;
export declare function isVoiceTurnRequest(value: unknown): value is VoiceTurnRequest;
export declare function resolveVoiceConversation(args: {
    uid: string;
    gatewayId: string;
    channelId: string;
    expectedAgentId?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<VoiceConversation>;
type VoiceBrokerOptions = {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
};
export declare function bindVoiceGrant(args: VoiceGrantRequest & VoiceBrokerOptions): Promise<VoiceGrantBinding>;
export declare function endVoiceGrant(args: VoiceGrantEndRequest & VoiceBrokerOptions): Promise<{
    revoked: true;
}>;
export declare function postVoiceTurn(args: VoiceTurnRequest & VoiceBrokerOptions): Promise<VoiceTurnPost>;
export {};

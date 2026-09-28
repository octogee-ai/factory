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
export interface VoiceTurnRequest {
    uid: string;
    gatewayId: string;
    channelId: string;
    text: string;
    turnId?: string;
    ingressToken?: string;
}
export interface VoiceTurnPost {
    postId: string;
    channelId: string;
    userId: string;
}
export declare function isVoiceTurnRequest(value: unknown): value is VoiceTurnRequest;
export declare function resolveVoiceConversation(args: {
    uid: string;
    gatewayId: string;
    channelId: string;
    expectedAgentId?: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<VoiceConversation>;
export declare function postVoiceTurn(args: VoiceTurnRequest & {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
}): Promise<VoiceTurnPost>;

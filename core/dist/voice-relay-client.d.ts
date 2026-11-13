import { WebSocket } from "ws";
export declare const VOICE_RELAY_TTS_TIMEOUT_MS = 30000;
export interface SttStreamEvents {
    onReady?: () => void;
    onPartial?: (text: string) => void;
    onFinal?: (text: string) => void;
    onError?: (error: Error) => void;
}
export interface SttStream {
    sendAudio(pcm16le16k: Buffer): void;
    end(): void;
    abort(): void;
}
export interface TtsRequest {
    text: string;
    voice?: string;
    speed?: number;
    signal?: AbortSignal;
}
export interface VoiceRelayClient {
    openStt(events: SttStreamEvents): SttStream;
    tts(request: TtsRequest): AsyncIterable<Buffer>;
}
export declare class VoiceRelayError extends Error {
    readonly status?: number | undefined;
    readonly name = "VoiceRelayError";
    constructor(message: string, status?: number | undefined);
}
export interface VoiceRelayClientOptions {
    baseUrl: string;
    gatewayId: string;
    tokenPath?: string;
    fetchImpl?: typeof fetch;
    WebSocketImpl?: typeof WebSocket;
}
export declare function createVoiceRelayClient(options: VoiceRelayClientOptions): VoiceRelayClient;

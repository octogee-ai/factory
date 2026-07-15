export interface DeviceIdentity {
    deviceId: string;
    publicKeyPem: string;
    privateKeyPem: string;
}
export declare function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string;
export declare function generateIdentity(): DeviceIdentity;
export interface DeviceAuthPayloadV3Params {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | null;
    nonce: string;
    platform?: string | null;
    deviceFamily?: string | null;
}
export declare function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string;
export declare function signDevicePayload(privateKeyPem: string, payload: string): string;
export interface SignedDevicePayload {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
}
export interface SignConnectDeviceParams {
    identity: DeviceIdentity;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    nonce: string;
    token?: string | null;
    platform?: string | null;
    deviceFamily?: string | null;
    signedAtMs?: number;
}
export declare function signConnectDevice(params: SignConnectDeviceParams): SignedDevicePayload;

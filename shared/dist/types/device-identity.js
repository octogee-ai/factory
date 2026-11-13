import * as crypto from "node:crypto";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
function base64UrlEncode(buf) {
    let s = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    while (s.endsWith("="))
        s = s.slice(0, -1);
    return s;
}
function derivePublicKeyRaw(publicKeyPem) {
    const key = crypto.createPublicKey(publicKeyPem);
    const spki = key.export({ type: "spki", format: "der" });
    if (spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}
function fingerprintPublicKey(publicKeyPem) {
    return crypto
        .createHash("sha256")
        .update(derivePublicKeyRaw(publicKeyPem))
        .digest("hex");
}
export function publicKeyRawBase64UrlFromPem(publicKeyPem) {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
function identityFromKeyPair(publicKey, privateKey) {
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
    return {
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
    };
}
export function generateIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    return identityFromKeyPair(publicKey, privateKey);
}
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export function deriveDeviceIdentity(params) {
    if (params.secret.length === 0) {
        throw new Error("device identity derivation requires a non-empty secret");
    }
    if (!params.subject.trim())
        throw new Error("device identity derivation requires a subject");
    const seed = crypto.createHmac("sha256", params.secret).update(params.subject).digest();
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
    });
    return identityFromKeyPair(crypto.createPublicKey(privateKey), privateKey);
}
function normalizeDeviceMetadataForAuth(value) {
    if (typeof value !== "string")
        return "";
    const trimmed = value.trim();
    if (!trimmed)
        return "";
    return trimmed.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}
export function buildDeviceAuthPayloadV3(params) {
    return [
        "v3",
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        params.scopes.join(","),
        String(params.signedAtMs),
        params.token ?? "",
        params.nonce,
        normalizeDeviceMetadataForAuth(params.platform),
        normalizeDeviceMetadataForAuth(params.deviceFamily),
    ].join("|");
}
export function signDevicePayload(privateKeyPem, payload) {
    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
    return base64UrlEncode(sig);
}
export function signConnectDevice(params) {
    const signedAtMs = params.signedAtMs ?? Date.now();
    const payload = buildDeviceAuthPayloadV3({
        deviceId: params.identity.deviceId,
        clientId: params.clientId,
        clientMode: params.clientMode,
        role: params.role,
        scopes: params.scopes,
        signedAtMs,
        token: params.token ?? null,
        nonce: params.nonce,
        platform: params.platform ?? null,
        deviceFamily: params.deviceFamily ?? null,
    });
    return {
        id: params.identity.deviceId,
        publicKey: publicKeyRawBase64UrlFromPem(params.identity.publicKeyPem),
        signature: signDevicePayload(params.identity.privateKeyPem, payload),
        signedAt: signedAtMs,
        nonce: params.nonce,
    };
}

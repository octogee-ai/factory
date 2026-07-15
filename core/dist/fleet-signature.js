import { createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, } from "node:crypto";
export function canonicalPayload(jobId, rawBody) {
    return `${jobId}\n${rawBody}`;
}
export function signFleetRequest(privateKeyPem, jobId, rawBody) {
    const payload = Buffer.from(canonicalPayload(jobId, rawBody), "utf8");
    return cryptoSign(null, payload, createPrivateKey(normalizeKeyMaterial(privateKeyPem)))
        .toString("base64url");
}
export function verifyFleetRequest(publicKeyPem, jobId, rawBody, headerValue) {
    if (!headerValue)
        return false;
    try {
        const signature = Buffer.from(headerValue, "base64url");
        if (signature.length !== 64)
            return false;
        return cryptoVerify(null, Buffer.from(canonicalPayload(jobId, rawBody), "utf8"), createPublicKey(normalizeKeyMaterial(publicKeyPem)), signature);
    }
    catch {
        return false;
    }
}
function normalizeKeyMaterial(raw) {
    const value = raw.trim().replace(/\\n/g, "\n");
    if (value.includes("-----BEGIN "))
        return value;
    for (const encoding of ["base64url", "base64"]) {
        try {
            const decoded = Buffer.from(value, encoding).toString("utf8").trim().replace(/\\n/g, "\n");
            if (decoded.includes("-----BEGIN "))
                return decoded;
        }
        catch {
            // Try the next encoding.
        }
    }
    return value;
}

import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

export const OPERATOR_KEY_ISSUER = "octogee-operator-key";
const OPERATOR_TOKEN_MAX_SECONDS = 3600;
const OPERATOR_TOKEN_CLOCK_SKEW_MILLISECONDS = 60_000;

function decodeSegment(segment: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  if (value === null || typeof value !== "object") throw new Error("the operator token segment is not an object");
  return value as Record<string, unknown>;
}

function encodeSegment(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function signOperatorToken(options: {
  readonly privateKey: string;
  readonly subject: string;
  readonly now?: () => number;
  readonly lifetimeSeconds?: number;
}): string {
  if (options.subject.trim() === "") throw new Error("the operator token names no operator");
  const issuedAt = Math.floor((options.now ?? Date.now)() / 1000);
  const signingInput = `${encodeSegment({ alg: "EdDSA", typ: "JWT" })}.${encodeSegment({
    iss: OPERATOR_KEY_ISSUER,
    sub: options.subject,
    iat: issuedAt,
    exp: issuedAt + (options.lifetimeSeconds ?? 600),
  })}`;
  const signature = sign(null, Buffer.from(signingInput), createPrivateKey(options.privateKey));
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function operatorPublicKey(pem: string): KeyObject {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("the operator key must be an Ed25519 public key");
  return key;
}

export function verifyOperatorToken(token: string, key: KeyObject, now: number): string {
  const [header, payload, signature, ...rest] = token.split(".");
  if (!header || !payload || !signature || rest.length > 0) throw new Error("the bearer is not a JWT");
  if (decodeSegment(header).alg !== "EdDSA") throw new Error("the operator token is not signed with EdDSA");
  if (!verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature, "base64url"))) {
    throw new Error("the operator token signature does not match the operator key");
  }
  const claims = decodeSegment(payload);
  if (claims.iss !== OPERATOR_KEY_ISSUER) throw new Error("the operator token has the wrong issuer");
  if (typeof claims.sub !== "string" || claims.sub.trim() === "") throw new Error("the operator token names no operator");
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number") throw new Error("the operator token has no lifetime");
  if (claims.exp - claims.iat > OPERATOR_TOKEN_MAX_SECONDS) throw new Error("the operator token lives longer than an hour");
  if (claims.iat * 1000 > now + OPERATOR_TOKEN_CLOCK_SKEW_MILLISECONDS) throw new Error("the operator token was issued in the future");
  if (claims.exp * 1000 <= now) throw new Error("the operator token has expired");
  return claims.sub;
}

import { OAuth2Client } from "google-auth-library";
import { OPERATOR_KEY_ISSUER, operatorPublicKey, verifyOperatorToken } from "./operator-token.js";

export interface VerifiedIdentity {
  readonly ownerId: string;
  readonly email: string | null;
  readonly operator: boolean;
}

export interface IdentityProvider {
  readonly issuers: readonly string[];
  verifyBearer(token: string): Promise<VerifiedIdentity>;
}

function unverifiedIssuer(token: string): string {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("the bearer is not a JWT");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { iss?: unknown } | null;
  if (typeof claims?.iss !== "string") throw new Error("the bearer names no issuer");
  return claims.iss;
}

export function combineIdentityProviders(providers: readonly IdentityProvider[]): IdentityProvider {
  if (providers.length === 0) throw new Error("no identity provider is configured");
  const byIssuer = new Map(providers.flatMap((provider) => provider.issuers.map((issuer) => [issuer, provider] as const)));
  return {
    issuers: [...byIssuer.keys()],
    verifyBearer: async (token) => {
      const provider = byIssuer.get(unverifiedIssuer(token));
      if (provider === undefined) throw new Error("the bearer's issuer is not trusted");
      return provider.verifyBearer(token);
    },
  };
}

export type VerifyGoogleIdToken = (idToken: string, audience: string) => Promise<Record<string, unknown> | undefined>;

function verifyWithGoogleKeys(): VerifyGoogleIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload() as Record<string, unknown> | undefined;
  };
}

export function createGoogleIdentityProvider(options: {
  readonly audience: string;
  readonly operatorEmails: readonly string[];
  readonly verify?: VerifyGoogleIdToken;
}): IdentityProvider {
  const verify = options.verify ?? verifyWithGoogleKeys();
  const operators = new Set(options.operatorEmails.map((email) => email.toLowerCase()));
  return {
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    verifyBearer: async (token) => {
      const claims = await verify(token, options.audience);
      if (typeof claims?.email !== "string" || claims.email_verified !== true) {
        throw new Error("the Google token has no verified email");
      }
      const email = claims.email.toLowerCase();
      return { ownerId: email, email, operator: operators.has(email) };
    },
  };
}

export function createOperatorKeyIdentityProvider(options: {
  readonly publicKey: string;
  readonly now?: () => number;
}): IdentityProvider {
  const key = operatorPublicKey(options.publicKey);
  const now = options.now ?? Date.now;
  return {
    issuers: [OPERATOR_KEY_ISSUER],
    verifyBearer: async (token) => {
      const subject = verifyOperatorToken(token, key, now());
      return { ownerId: `operator:${subject}`, email: null, operator: true };
    },
  };
}

export function operatorKeyIdentityFromEnvironment(env: Record<string, string | undefined>): IdentityProvider | null {
  const publicKey = env.FLEET_OPERATOR_PUBLIC_KEY?.trim() ?? "";
  return publicKey === "" ? null : createOperatorKeyIdentityProvider({ publicKey });
}

export function googleIdentityFromEnvironment(env: Record<string, string | undefined>): IdentityProvider | null {
  const audience = env.FLEET_GOOGLE_CLIENT_ID?.trim() ?? "";
  const operatorEmails = (env.FLEET_OPERATOR_EMAILS ?? "").split(",").map((email) => email.trim()).filter((email) => email !== "");
  if (audience === "" && operatorEmails.length === 0) return null;
  if (audience === "") throw new Error("FLEET_OPERATOR_EMAILS is set without FLEET_GOOGLE_CLIENT_ID");
  if (operatorEmails.length === 0) throw new Error("FLEET_GOOGLE_CLIENT_ID is set without FLEET_OPERATOR_EMAILS");
  return createGoogleIdentityProvider({ audience, operatorEmails });
}

import { OAuth2Client } from "google-auth-library";
import type { ReviewResult, Reviewer } from "./kubernetes-token-review.js";

export const GOOGLE_TOKEN_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export type VerifyGoogleIdToken = (idToken: string, audience: string) => Promise<Record<string, unknown> | null>;

export interface GatewayVmIdentityConfig {
  serviceAccountEmail: string;
  projectId: string;
  instanceId: string;
}

export interface GceIdentityReviewerOptions extends GatewayVmIdentityConfig {
  audience: string;
  namespace: string;
  verify?: VerifyGoogleIdToken;
  onRejected?: (reason: string) => void;
}

export interface ComputeInstanceIdentity {
  projectId: string;
  zone: string;
  instanceId: string;
  instanceName: string;
}

export class VmIdentityVerifierUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`VM identity verifier unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "VmIdentityVerifierUnavailableError";
  }
}

const VERIFIER_UNAVAILABLE_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
]);

export function isVerifierUnavailableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && VERIFIER_UNAVAILABLE_CODES.has(code)) return true;
  if (error.name === "AbortError" || error.name === "FetchError") return true;
  if (error.message === "fetch failed") return true;
  return error.cause !== undefined && isVerifierUnavailableError(error.cause);
}

export function jwtIssuer(token: string): string | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], "base64url").toString("utf8")) as { iss?: unknown };
    return typeof payload.iss === "string" ? payload.iss : null;
  } catch {
    return null;
  }
}

export function isGoogleIssuedJwt(token: string): boolean {
  const issuer = jwtIssuer(token);
  return issuer !== null && GOOGLE_TOKEN_ISSUERS.has(issuer);
}

export function parseGatewayVmIdentity(
  env: Record<string, string | undefined>,
): GatewayVmIdentityConfig | null {
  const serviceAccountEmail = env.GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL?.trim();
  const projectId = env.GATEWAY_COMPUTER_PROJECT_ID?.trim();
  const instanceId = env.GATEWAY_COMPUTER_INSTANCE_ID?.trim();
  if (!serviceAccountEmail && !projectId && !instanceId) return null;
  if (!serviceAccountEmail || !projectId || !instanceId) {
    throw new Error(
      "GATEWAY_COMPUTER_SERVICE_ACCOUNT_EMAIL, GATEWAY_COMPUTER_PROJECT_ID and GATEWAY_COMPUTER_INSTANCE_ID must be set together",
    );
  }
  if (!/^\d+$/.test(instanceId)) {
    throw new Error(`GATEWAY_COMPUTER_INSTANCE_ID must be the numeric Compute Engine instance id (got ${instanceId})`);
  }
  return { serviceAccountEmail, projectId, instanceId };
}

export function serviceAccountLocalPart(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

function defaultVerify(): VerifyGoogleIdToken {
  const client = new OAuth2Client();
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return (ticket.getPayload() as Record<string, unknown> | undefined) ?? null;
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function computeInstanceFromPayload(
  payload: Record<string, unknown>,
  expected: Pick<GatewayVmIdentityConfig, "projectId" | "serviceAccountEmail">,
): ComputeInstanceIdentity | null {
  if (payload.email !== expected.serviceAccountEmail || payload.email_verified !== true) return null;
  const google = payload.google as { compute_engine?: Record<string, unknown> } | undefined;
  const engine = google?.compute_engine;
  if (!engine) return null;
  const projectId = nonEmptyString(engine.project_id);
  const zone = nonEmptyString(engine.zone);
  const instanceId = nonEmptyString(engine.instance_id);
  const instanceName = nonEmptyString(engine.instance_name);
  if (!projectId || !zone || !instanceId || !instanceName) return null;
  if (projectId !== expected.projectId) return null;
  return { projectId, zone, instanceId, instanceName };
}

export function createGceIdentityReviewer(opts: GceIdentityReviewerOptions): Reviewer {
  const verify = opts.verify ?? defaultVerify();
  const saName = serviceAccountLocalPart(opts.serviceAccountEmail);
  const rejected = (reason: string): ReviewResult => {
    opts.onRejected?.(reason);
    return { authenticated: false };
  };
  return async (jwt: string): Promise<ReviewResult> => {
    let payload: Record<string, unknown> | null;
    try {
      payload = await verify(jwt, opts.audience);
    } catch (error) {
      if (isVerifierUnavailableError(error)) throw new VmIdentityVerifierUnavailableError(error);
      return rejected(`token verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!payload) return rejected("token verification returned no payload");
    if (!GOOGLE_TOKEN_ISSUERS.has(String(payload.iss))) return rejected(`issuer ${String(payload.iss)} is not Google`);
    const computeInstance = computeInstanceFromPayload(payload, opts);
    if (!computeInstance) return rejected("token is not the VM service account on a Compute Engine instance in this project");
    if (computeInstance.instanceId !== opts.instanceId) {
      return rejected(`token was minted on instance ${computeInstance.instanceName} (${computeInstance.instanceId}), not this computer (${opts.instanceId})`);
    }
    return {
      authenticated: true,
      saName,
      namespace: opts.namespace,
      audiences: [opts.audience],
    };
  };
}

export function createIssuerDispatchingReviewer(reviewers: { kubernetes: Reviewer; gce: Reviewer }): Reviewer {
  return (jwt) => (isGoogleIssuedJwt(jwt) ? reviewers.gce(jwt) : reviewers.kubernetes(jwt));
}

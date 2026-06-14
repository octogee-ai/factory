import * as crypto from "crypto";
import { readFileSync } from "node:fs";
import { operatorGatewayServiceAccountName } from "../../../shared/types/glm.js";
import {
  createKubernetesTokenReviewer,
  TOKEN_REVIEW_AUDIENCE,
  type Reviewer,
} from "./kubernetes-token-review.js";

export type BuilderShellInternalAuthMode = "platform" | "operator-service-account";

export const BUILDER_SHELL_K8S_SA_TOKEN_HEADER = "x-k8s-sa-token";
export const BUILDER_SHELL_INTERNAL_KEY_HEADER = "x-internal-service-key";
export const DEFAULT_PROJECTED_API_TOKEN_PATH =
  "/var/run/secrets/octogee-api/token";

export interface BuilderShellInternalAuthSecret {
  value: string;
  mode: BuilderShellInternalAuthMode;
  headerName: typeof BUILDER_SHELL_INTERNAL_KEY_HEADER | typeof BUILDER_SHELL_K8S_SA_TOKEN_HEADER;
}

export interface BuilderShellInternalAuthValidationOptions {
  reviewer?: Reviewer;
}

let sharedReviewer: Reviewer | null = null;

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readProjectedServiceAccountToken(env: Record<string, string | undefined>): string | undefined {
  const tokenPath = nonBlank(env.OCTOGEE_API_SA_TOKEN_PATH) ?? DEFAULT_PROJECTED_API_TOKEN_PATH;
  try {
    return nonBlank(readFileSync(tokenPath, "utf8"));
  } catch {
    return undefined;
  }
}

function getReviewer(): Reviewer {
  if (sharedReviewer === null) sharedReviewer = createKubernetesTokenReviewer();
  return sharedReviewer;
}

function expectedNamespace(env: Record<string, string | undefined>): string {
  return nonBlank(env.K8S_NAMESPACE) ?? nonBlank(env.POD_NAMESPACE) ?? "octogee";
}

function allowedOperatorServiceAccounts(env: Record<string, string | undefined>): Set<string> {
  const allowed = new Set<string>(["octogee-api"]);
  const configured = nonBlank(env.BUILDER_SHELL_ALLOWED_K8S_SERVICE_ACCOUNTS);
  if (configured) {
    for (const item of configured.split(",")) {
      const sa = nonBlank(item);
      if (sa) allowed.add(sa);
    }
  }

  const own = nonBlank(env.K8S_SERVICE_ACCOUNT_NAME);
  if (own) allowed.add(own);

  const gatewayId = nonBlank(env.GATEWAY_ID);
  if (gatewayId) allowed.add(operatorGatewayServiceAccountName(gatewayId));
  return allowed;
}

function timingSafeStringEqual(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  try {
    return (
      provided.length === expected.length &&
      crypto.timingSafeEqual(
        Buffer.from(provided, "utf8"),
        Buffer.from(expected, "utf8"),
      )
    );
  } catch {
    return false;
  }
}

export function resolveBuilderShellInternalAuthSecret(
  env: Record<string, string | undefined> = process.env,
): BuilderShellInternalAuthSecret | null {
  const platformKey = nonBlank(env.INTERNAL_SERVICE_KEY);
  if (platformKey) {
    return {
      value: platformKey,
      mode: "platform",
      headerName: BUILDER_SHELL_INTERNAL_KEY_HEADER,
    };
  }

  if (env.GATEWAY_PROFILE === "operator") {
    const serviceAccountToken = readProjectedServiceAccountToken(env);
    if (serviceAccountToken) {
      return {
        value: serviceAccountToken,
        mode: "operator-service-account",
        headerName: BUILDER_SHELL_K8S_SA_TOKEN_HEADER,
      };
    }
  }

  return null;
}

export async function isValidBuilderShellInternalAuth(
  provided: string | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: BuilderShellInternalAuthValidationOptions = {},
): Promise<boolean> {
  if (!provided) return false;
  const secret = resolveBuilderShellInternalAuthSecret(env);
  if (!secret) return false;

  if (secret.mode === "platform") {
    return timingSafeStringEqual(provided, secret.value);
  }

  const review = await (opts.reviewer ?? getReviewer())(provided);
  if (!review.authenticated) return false;
  if (!review.audiences.includes(TOKEN_REVIEW_AUDIENCE)) return false;
  if (review.namespace !== expectedNamespace(env)) return false;
  return allowedOperatorServiceAccounts(env).has(review.saName);
}

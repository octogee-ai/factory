import { isValidGatewayId } from "@octogee/shared/types/glm";
import {
  permissionSetIds,
  type GatewayPermissionSetId,
  type GatewayPrincipalAccess,
} from "@octogee/core/gateway-principal-access";

import { trustedBrokerBaseUrl } from "./automation-authorization-broker.js";
import { internalFetch } from "./internal-fetch.js";

export const COMPUTER_ACCESS_BROKER_PATH = "/internal/computer/access";
export const COMPUTER_ACCESS_TIMEOUT_MS = 5_000;

export type ComputerAccessRole = "owner" | "co-owner" | "trusted-helper" | "member";

export interface ComputerAccessGrant {
  gatewayId: string;
  workspaceSlug: string;
  role: ComputerAccessRole;
  permissionSetIds: GatewayPermissionSetId[];
  canControl: boolean;
}

export type ComputerAccessOutcome =
  | ({ kind: "allowed" } & ComputerAccessGrant)
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "not_found" };

export function computerAccessRole(access: GatewayPrincipalAccess): ComputerAccessRole | null {
  if (access.kind === "denied") return null;
  if (access.kind === "owner") return "owner";
  if (access.permissionSetIds.includes("co-owner.v1")) return "co-owner";
  if (access.kind === "member") return "member";
  if (access.permissionSetIds.includes("trusted-helper.v1")) return "trusted-helper";
  return null;
}

export function computerControlAllowed(role: ComputerAccessRole): boolean {
  return role === "owner" || role === "co-owner";
}

const ROLES: ReadonlySet<string> = new Set<ComputerAccessRole>(["owner", "co-owner", "trusted-helper", "member"]);

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function computerAccessBrokerBaseUrlFromEnv(
  env: Record<string, string | undefined> = process.env,
): string {
  const value = nonBlank(env.OPENCLAW_RUNTIME_BROKER_URL);
  if (!value) throw new Error("OPENCLAW_RUNTIME_BROKER_URL is required");
  return trustedBrokerBaseUrl(value, env);
}

function grantFromResponse(value: unknown, requestedGatewayId: string): ComputerAccessGrant | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const ids = Array.isArray(body.permissionSetIds) && body.permissionSetIds.length === 0
    ? []
    : permissionSetIds(body.permissionSetIds);
  if (
    body.gatewayId !== requestedGatewayId ||
    typeof body.workspaceSlug !== "string" ||
    body.workspaceSlug.length === 0 ||
    typeof body.role !== "string" ||
    !ROLES.has(body.role) ||
    ids === null ||
    body.canControl !== computerControlAllowed(body.role as ComputerAccessRole)
  ) return null;
  return {
    gatewayId: requestedGatewayId,
    workspaceSlug: body.workspaceSlug,
    role: body.role as ComputerAccessRole,
    permissionSetIds: ids,
    canControl: body.canControl,
  };
}

export async function resolveComputerAccess(args: {
  gatewayId: string;
  authorization?: string;
  baseUrl?: string;
  env?: Record<string, string | undefined>;
  tokenPath?: string;
  fetchImpl?: typeof fetch;
}): Promise<ComputerAccessOutcome> {
  if (!isValidGatewayId(args.gatewayId)) return { kind: "not_found" };
  if (!args.authorization?.startsWith("Bearer ")) return { kind: "unauthenticated" };
  const baseUrl = args.baseUrl
    ? trustedBrokerBaseUrl(args.baseUrl, args.env ?? process.env)
    : computerAccessBrokerBaseUrlFromEnv(args.env);
  const response = await internalFetch(
    `${baseUrl}${COMPUTER_ACCESS_BROKER_PATH}`,
    {
      method: "POST",
      headers: { authorization: args.authorization, "content-type": "application/json" },
      body: JSON.stringify({ gatewayId: args.gatewayId }),
      redirect: "error",
    },
    {
      tokenPath: args.tokenPath,
      fetchImpl: args.fetchImpl,
      requireProjectedToken: true,
      timeoutMs: COMPUTER_ACCESS_TIMEOUT_MS,
    },
  );
  if (response.status === 401) return { kind: "unauthenticated" };
  if (response.status === 403) return { kind: "forbidden" };
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) throw new Error(`computer access broker returned ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error("computer access broker returned malformed JSON", { cause: error });
  }
  const grant = grantFromResponse(body, args.gatewayId);
  if (!grant) throw new Error("computer access broker returned a malformed grant");
  return { kind: "allowed", ...grant };
}

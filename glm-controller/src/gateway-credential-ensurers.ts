import type { AgentStoreGatewayIdentity } from "@octogee/core/agent-store-credentials";
import { readGatewayAuthToken, type AuthSecretEnsurer, type KubectlSubprocess } from "./auth-secret-ensurer.js";

type GatewayIdentity = { gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null };

export function createGatewayCredentialEnsurers(deps: {
  auth: AuthSecretEnsurer;
  readGateway(gatewayId: string): Promise<GatewayIdentity | null>;
  provisionAgentStore(identity: AgentStoreGatewayIdentity): Promise<string>;
  runKubectl: KubectlSubprocess;
}) {
  const ensureGatewayCredentials: AuthSecretEnsurer["ensureAuthSecret"] = async (input) => {
    await deps.auth.ensureAuthSecret(input);
    const gateway = await deps.readGateway(input.gatewayId);
    if (!gateway || Boolean(gateway.ownerUid) !== Boolean(gateway.builderSlug)) {
      throw new Error(`Agent-store credentials require the desired owner of Gateway ${input.gatewayId}`);
    }
    const token = await readGatewayAuthToken(deps, input);
    const dsn = await deps.provisionAgentStore({
      gatewayId: input.gatewayId, gatewayClass: gateway.gatewayClass, token,
      ...(gateway.gatewayClass === "builder" && gateway.ownerUid && gateway.builderSlug
        ? { builder: { uid: gateway.ownerUid, slug: gateway.builderSlug } } : {}),
    });
    const result = await deps.runKubectl(["patch", "secret", `gateway-auth-token-${input.gatewayId}`, "-n", input.namespace, "--type=merge", "--patch-file=/dev/stdin"], {
      stdin: JSON.stringify({ data: { "agent-store-dsn": Buffer.from(dsn).toString("base64") } }),
    });
    if (result.code !== 0) throw new Error(`Agent-store credential publication failed for ${input.gatewayId} (code=${result.code})`);
  };
  return { ensureGatewayAuthSecret: deps.auth.ensureAuthSecret, ensureGatewayCredentials };
}

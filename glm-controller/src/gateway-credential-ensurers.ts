import type { AgentStoreGatewayIdentity } from "@octogee/core/agent-store-credentials";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatewayAuthToken, type AuthSecretEnsurer, type KubectlSubprocess } from "./auth-secret-ensurer.js";

type GatewayIdentity = { gatewayClass: "shared" | "builder"; ownerUid: string | null; builderSlug: string | null; desiredStatus: string; retirementClaim?: unknown };

export function createGatewayCredentialEnsurers(deps: {
  auth: AuthSecretEnsurer;
  readGateway(gatewayId: string): Promise<GatewayIdentity | null>;
  provisionAgentStore(identity: AgentStoreGatewayIdentity, assertCurrent: () => Promise<void>): Promise<string>;
  runKubectl: KubectlSubprocess;
}) {
  const ensureGatewayCredentials: AuthSecretEnsurer["ensureAuthSecret"] = async (input) => {
    await deps.auth.ensureAuthSecret(input);
    const gateway = await deps.readGateway(input.gatewayId);
    if (!gateway || Boolean(gateway.ownerUid) !== Boolean(gateway.builderSlug)) {
      throw new Error(`Agent-store credentials require the desired owner of Gateway ${input.gatewayId}`);
    }
    const assertCurrent = async () => {
      const current = await deps.readGateway(input.gatewayId);
      if (!current || current.desiredStatus === "retired" || current.retirementClaim != null
        || current.gatewayClass !== gateway.gatewayClass || current.ownerUid !== gateway.ownerUid
        || current.builderSlug !== gateway.builderSlug) {
        throw new Error(`Agent-store Gateway ${input.gatewayId} retired or changed while issuing credentials`);
      }
    };
    const token = await readGatewayAuthToken(deps, input);
    const dsn = await deps.provisionAgentStore({
      gatewayId: input.gatewayId, gatewayClass: gateway.gatewayClass, token,
      ...(gateway.gatewayClass === "builder" && gateway.ownerUid && gateway.builderSlug
        ? { builder: { uid: gateway.ownerUid, slug: gateway.builderSlug } } : {}),
    }, assertCurrent);
    await assertCurrent();
    const directory = await mkdtemp(join(tmpdir(), "octogee-agent-store-secret-"));
    try {
      const patchFile = join(directory, "patch.json");
      await writeFile(patchFile, JSON.stringify([
        { op: "test", path: "/data/token", value: Buffer.from(token).toString("base64") },
        { op: "add", path: "/data/agent-store-dsn", value: Buffer.from(dsn).toString("base64") },
      ]), { mode: 0o600 });
      await assertCurrent();
      const result = await deps.runKubectl(["patch", "secret", `gateway-auth-token-${input.gatewayId}`, "-n", input.namespace, "--type=json", `--patch-file=${patchFile}`]);
      if (result.code !== 0) throw new Error(`Agent-store credential publication failed for ${input.gatewayId} (code=${result.code})`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  return { ensureGatewayAuthSecret: deps.auth.ensureAuthSecret, ensureGatewayCredentials };
}

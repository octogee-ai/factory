import { OpenclawWireError, createGatewayRpc } from "./gateway-rpc.js";
/**
 * Writes auth-profile secrets through openclaw's own `secrets.apply` gateway
 * RPC, the only sanctioned writer of an agent's auth_profile_store.
 *
 * We used to spawn `openclaw secrets apply` per plan. The CLI bootstrap cost
 * ~60s per agent, its spawnSync blocked the provisioner's event loop (starving
 * the pod's readiness probe), and it timed out under provisioning bursts. The
 * gateway runs the same apply engine in-process; a refused or unreachable
 * apply is still a deferral the level-triggered sweep retries.
 */
const SECRET_RESOLVER_PROVIDER = "gcp-secret-manager";
export class OpenClawSecretsApplyError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.name = "OpenClawSecretsApplyError";
        this.status = status;
    }
}
export function authProfileApiKeyTarget(input) {
    return {
        type: "auth-profiles.api_key.key",
        path: `profiles.${input.profileId}.key`,
        ref: {
            source: "exec",
            provider: input.refProvider ?? SECRET_RESOLVER_PROVIDER,
            id: input.refId,
        },
        agentId: input.agentId,
        authProfileProvider: input.provider,
    };
}
export function buildOpenClawSecretsPlan(targets, now = () => new Date()) {
    return {
        version: 1,
        protocolVersion: 1,
        generatedAt: now().toISOString(),
        generatedBy: "manual",
        targets: [...targets],
    };
}
/** Applies a plan through the gateway RPC. Throws OpenClawSecretsApplyError on
 *  any transport or gateway refusal — the caller decides whether that is fatal
 *  or a deferral for the next sweep. */
export async function applyOpenClawSecretsPlan(plan, opts = {}) {
    if (plan.targets.length === 0)
        return;
    const rpc = opts.rpc ??
        createGatewayRpc({
            allowLegacyGatewayTokenFallback: true,
            connectTimeoutMs: 10_000,
            callTimeoutMs: 60_000,
        });
    try {
        await rpc.secretsApply({ plan });
    }
    catch (error) {
        if (error instanceof OpenclawWireError) {
            throw new OpenClawSecretsApplyError(`openclaw secrets.apply refused: ${error.message}`, null);
        }
        throw error;
    }
    finally {
        if (!opts.rpc)
            await rpc.close?.();
    }
}

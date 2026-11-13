import type { ManagedChannelHost } from "../channel-host/types.js";
import type { SecretsRepository } from "../platform-state/secrets.js";
import type { TimeInput } from "../platform-state/store.js";
export declare const DEFAULT_AGENT_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
export interface DefaultAgentPatMintDeps {
    channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
    secrets: Pick<SecretsRepository, "put">;
    now: () => TimeInput;
}
export declare function mintAndPersistDefaultAgentToken(deps: DefaultAgentPatMintDeps, uid: string, defaultAgentMmUserId: string): Promise<{
    token: string;
} | null>;

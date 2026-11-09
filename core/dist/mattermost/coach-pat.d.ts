import type { ManagedChannelHost } from "../channel-host/types.js";
import type { SecretsRepository } from "../platform-state/secrets.js";
export declare const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
export interface CoachPatMintDeps {
    channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
    secrets: Pick<SecretsRepository, "put">;
}
export declare function mintAndPersistCoachToken(deps: CoachPatMintDeps, uid: string, coachMmUserId: string): Promise<{
    token: string;
} | null>;

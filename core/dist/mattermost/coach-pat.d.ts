import type { ManagedChannelHost } from "../channel-host/types.js";
import type { SecretsRepository } from "../platform-state/secrets.js";
import type { TimeInput } from "../platform-state/store.js";
export declare const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
export interface CoachPatMintDeps {
    channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
    secrets: Pick<SecretsRepository, "put">;
    now: () => TimeInput;
}
export declare function mintAndPersistCoachToken(deps: CoachPatMintDeps, uid: string, coachMmUserId: string): Promise<{
    token: string;
} | null>;

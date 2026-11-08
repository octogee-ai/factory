import type { ManagedChannelHost } from "../channel-host/types.js";
export declare const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
interface MintCollectionRef {
    doc(id: string): MintDocRef;
}
interface MintDocRef {
    collection(name: string): MintCollectionRef;
    set(data: Record<string, unknown>): Promise<unknown>;
}
export interface CoachPatMintDeps {
    channelHost: Pick<ManagedChannelHost, "revokeTokens" | "issueToken">;
    db: {
        collection: (name: string) => MintCollectionRef;
    };
    now: () => unknown;
}
export declare function mintAndPersistCoachToken(deps: CoachPatMintDeps, uid: string, coachMmUserId: string): Promise<{
    token: string;
} | null>;
export {};

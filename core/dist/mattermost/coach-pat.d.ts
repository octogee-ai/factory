export declare const COACH_PAT_DESCRIPTION = "Octogee coach agent (OpenClaw)";
interface MintCollectionRef {
    doc(id: string): MintDocRef;
}
interface MintDocRef {
    collection(name: string): MintCollectionRef;
    set(data: Record<string, unknown>): Promise<unknown>;
}
export interface CoachPatMintDeps {
    mmApiCall: (method: string, endpoint: string, body?: unknown) => Promise<unknown>;
    db: {
        collection: (name: string) => MintCollectionRef;
    };
    now: () => unknown;
    log?: (msg: string) => void;
}
export declare function mintAndPersistCoachToken(deps: CoachPatMintDeps, uid: string, coachMmUserId: string): Promise<{
    token: string;
} | null>;
export {};

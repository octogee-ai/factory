import type { Firestore } from "firebase-admin/firestore";
import { type TierResolvable } from "@octogee/shared/types/billing";
export interface BuilderAccount {
    readonly uid: string;
    readonly username: string | null;
    readonly email: string | null;
    readonly displayName: string | null;
    readonly lastActive: number | null;
    readonly planInputs: TierResolvable;
    readonly byotActive: boolean;
    readonly usage: Readonly<Record<string, unknown>>;
    readonly mattermostUsername: string | null;
    readonly onboardingStep: string | null;
    readonly onboardingComplete: boolean;
    readonly stripeCustomerIds: readonly string[];
    readonly stripeSubscriptionIds: readonly string[];
}
export interface BuilderAccountReader {
    get(uid: string): Promise<BuilderAccount | null>;
    getMany(uids: readonly string[]): Promise<ReadonlyMap<string, BuilderAccount>>;
    list(): Promise<ReadonlyMap<string, BuilderAccount>>;
}
type Data = Record<string, unknown>;
export declare function builderAccountFromData(uid: string, data: Data): BuilderAccount;
export declare function firestoreBuilderAccountReader(db: Pick<Firestore, "collection" | "getAll">): BuilderAccountReader;
export {};

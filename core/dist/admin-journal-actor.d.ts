import type { UserAccountReader } from "./user-account.js";
export declare function withActorEmails<T extends Record<string, unknown>>(accounts: Pick<UserAccountReader, "getMany">, records: readonly T[]): Promise<(T & {
    actorEmail: string | null;
})[]>;

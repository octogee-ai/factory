import type { UserAccounts } from "./admin-user-router.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { UserAccountRecord } from "./platform-state/users.js";
import { type UserAccountReader } from "./user-account.js";
export declare function userAccountDocument(record: UserAccountRecord): Record<string, unknown>;
export declare function platformStateUserAccounts(store: Pick<PlatformStateStore, "transaction">): UserAccounts;
export declare function platformStateUserAccountReader(store: Pick<PlatformStateStore, "users">): UserAccountReader;

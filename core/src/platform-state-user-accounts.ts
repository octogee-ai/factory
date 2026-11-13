import type { UserAccountCreation, UserAccounts } from "./admin-user-router.js";
import { DuplicateRecordError } from "./platform-state/errors.js";
import type { PlatformStateStore } from "./platform-state/store.js";
import type { UserAccountRecord } from "./platform-state/users.js";
import { userAccountFromData, type UserAccount, type UserAccountReader } from "./user-account.js";

const SERVER_NOW = { serverNow: true } as const;

function takenField(error: unknown): "name" | "email" | null {
  if (!(error instanceof DuplicateRecordError)) return null;
  if (error.aggregate === "user-account" && (error.lookup === "name" || error.lookup === "email")) return error.lookup;
  if (error.aggregate === "builder" && error.lookup === "slug") return "name";
  return null;
}

export function userAccountDocument(record: UserAccountRecord): Record<string, unknown> {
  return { username: record.name, email: record.email, createdAt: record.createdAt };
}

function userAccountOf(record: UserAccountRecord): UserAccount {
  return userAccountFromData(record.uid, userAccountDocument(record));
}

export function platformStateUserAccounts(store: Pick<PlatformStateStore, "transaction">): UserAccounts {
  return {
    async create({ userId, name, email }): Promise<UserAccountCreation> {
      try {
        await store.transaction({ label: "users.accounts.create" }, async (transaction) => {
          await transaction.users.records.admit(userId, {
            slug: name,
            persona: null,
            createdAt: SERVER_NOW,
            provisioningStartedAt: SERVER_NOW,
          });
          await transaction.users.accounts.create({ uid: userId, name, email, createdAt: SERVER_NOW });
        });
      } catch (error) {
        const field = takenField(error);
        if (field === null) throw error;
        return { kind: "taken", field };
      }
      return { kind: "created", userId };
    },
  };
}

export function platformStateUserAccountReader(store: Pick<PlatformStateStore, "users">): UserAccountReader {
  const accounts = () => store.users.accounts;
  return {
    get: async (uid) => {
      const record = await accounts().get(uid);
      return record === null ? null : userAccountOf(record);
    },
    getMany: async (uids) =>
      new Map([...(await accounts().getMany(uids))].map(([uid, record]) => [uid, userAccountOf(record)])),
    list: async () => new Map((await accounts().listAll()).map((record) => [record.uid, userAccountOf(record)])),
  };
}

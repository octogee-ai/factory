import { DuplicateRecordError } from "./platform-state/errors.js";
import { userAccountFromData } from "./user-account.js";
const SERVER_NOW = { serverNow: true };
function takenField(error) {
    if (!(error instanceof DuplicateRecordError))
        return null;
    if (error.aggregate === "user-account" && (error.lookup === "name" || error.lookup === "email"))
        return error.lookup;
    if (error.aggregate === "builder" && error.lookup === "slug")
        return "name";
    return null;
}
export function userAccountDocument(record) {
    return { username: record.name, email: record.email, createdAt: record.createdAt };
}
function userAccountOf(record) {
    return userAccountFromData(record.uid, userAccountDocument(record));
}
export function platformStateUserAccounts(store) {
    return {
        async create({ userId, name, email }) {
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
            }
            catch (error) {
                const field = takenField(error);
                if (field === null)
                    throw error;
                return { kind: "taken", field };
            }
            return { kind: "created", userId };
        },
    };
}
export function platformStateUserAccountReader(store) {
    const accounts = () => store.users.accounts;
    return {
        get: async (uid) => {
            const record = await accounts().get(uid);
            return record === null ? null : userAccountOf(record);
        },
        getMany: async (uids) => new Map([...(await accounts().getMany(uids))].map(([uid, record]) => [uid, userAccountOf(record)])),
        list: async () => new Map((await accounts().listAll()).map((record) => [record.uid, userAccountOf(record)])),
    };
}

import type { UserAccountReader } from "./user-account.js";

const USER_ID = /^[A-Za-z0-9_-]{1,128}$/u;

function storedActor(record: Record<string, unknown>): string | null {
  return typeof record.createdBy === "string" ? record.createdBy : null;
}

export async function withActorEmails<T extends Record<string, unknown>>(
  accounts: Pick<UserAccountReader, "getMany">,
  records: readonly T[],
): Promise<(T & { actorEmail: string | null })[]> {
  const actors = records.map(storedActor);
  const userIds = [...new Set(actors.filter((actor): actor is string => actor !== null && USER_ID.test(actor)))];
  const accountsByUid = userIds.length === 0 ? new Map<string, { email: string | null }>() : await accounts.getMany(userIds);
  return records.map((record, index) => {
    const actor = actors[index];
    if (actor === null) return { ...record, actorEmail: null };
    return { ...record, actorEmail: actor.includes("@") ? actor : accountsByUid.get(actor)?.email ?? null };
  });
}

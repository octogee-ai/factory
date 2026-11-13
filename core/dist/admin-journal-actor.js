const USER_ID = /^[A-Za-z0-9_-]{1,128}$/u;
function storedActor(record) {
    return typeof record.createdBy === "string" ? record.createdBy : null;
}
export async function withActorEmails(accounts, records) {
    const actors = records.map(storedActor);
    const userIds = [...new Set(actors.filter((actor) => actor !== null && USER_ID.test(actor)))];
    const accountsByUid = userIds.length === 0 ? new Map() : await accounts.getMany(userIds);
    return records.map((record, index) => {
        const actor = actors[index];
        if (actor === null)
            return { ...record, actorEmail: null };
        return { ...record, actorEmail: actor.includes("@") ? actor : accountsByUid.get(actor)?.email ?? null };
    });
}

export function customerChannelMembers(kind, ids) {
    const nonEmpty = (s) => typeof s === "string" && s.length > 0;
    if (kind === "admin") {
        return [ids.adminMmUserId, ids.coachMmUserId].filter(nonEmpty);
    }
    return [ids.customerMmUserId, ids.coachMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

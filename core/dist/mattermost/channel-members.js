export function userChannelMembers(kind, ids) {
    const nonEmpty = (s) => typeof s === "string" && s.length > 0;
    if (kind === "admin") {
        return [ids.adminMmUserId, ids.defaultAgentMmUserId].filter(nonEmpty);
    }
    return [ids.customerMmUserId, ids.defaultAgentMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

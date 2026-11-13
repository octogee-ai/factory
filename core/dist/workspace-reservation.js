export function reserveWorkspace(store, slug, ownerUid) {
    return store.transaction({ label: "workspace.reserve" }, async (tx) => {
        const { records } = tx.workspaces;
        const existing = await records.get(slug);
        if (existing)
            return existing.ownerUid === ownerUid ? "existing" : "taken";
        await records.put({
            slug,
            id: slug,
            ownerUid,
            ownerActive: true,
            mattermostTeamId: "",
            giteaOrgName: slug,
            giteaRepoName: "workspace",
            createdAt: { serverNow: true },
            updatedAt: { serverNow: true },
        });
        return "created";
    });
}

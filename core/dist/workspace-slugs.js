function coerceString(v) {
    return typeof v === "string" && v.length > 0 ? v : null;
}
export function primaryWorkspaceSlug(data) {
    return (coerceString(data?.provisioning?.openclaw?.slug) ??
        coerceString(data?.username));
}
export function workspaceSlugsForUser(data) {
    const slug = primaryWorkspaceSlug(data);
    return slug ? [slug] : [];
}

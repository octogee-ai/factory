export function isolatedSizingTier(profile) {
    return profile?.isolation === "isolated" ? profile.sizingTier : null;
}
export function requireSizingProfile(profiles, sizingKey) {
    const profile = profiles[sizingKey];
    if (!profile)
        throw new Error(`gateway sizing profile is not configured: ${sizingKey}`);
    return profile;
}

export type CustomerChannelKind = "coach" | "general" | "admin" | "project";

export interface CustomerChannelMemberIds {
  customerMmUserId: string | null;
  coachMmUserId: string | null;
  adminMmUserId: string | null;
}

export function customerChannelMembers(
  kind: CustomerChannelKind,
  ids: CustomerChannelMemberIds,
): string[] {
  const nonEmpty = (s: string | null | undefined): s is string =>
    typeof s === "string" && s.length > 0;
  if (kind === "admin") {
    // Admin channel lists the platform operator first by convention (this
    // is the founder-to-agent channel; operator is the canonical actor).
    // Non-admin channels list customer-first. Order is immaterial at the
    // MM /channels/{id}/members call site (which loops and POSTs each
    // member independently), but the tests lock it to prevent drift.
    return [ids.adminMmUserId, ids.coachMmUserId].filter(nonEmpty);
  }
  return [ids.customerMmUserId, ids.coachMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

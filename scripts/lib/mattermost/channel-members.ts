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

return [ids.adminMmUserId, ids.coachMmUserId].filter(nonEmpty);
  }
  return [ids.customerMmUserId, ids.coachMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

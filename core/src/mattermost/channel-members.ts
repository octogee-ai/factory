export type UserChannelKind = "coach" | "general" | "admin" | "project";

export interface UserChannelMemberIds {
  customerMmUserId: string | null;
  defaultAgentMmUserId: string | null;
  adminMmUserId: string | null;
}

export function userChannelMembers(
  kind: UserChannelKind,
  ids: UserChannelMemberIds,
): string[] {
  const nonEmpty = (s: string | null | undefined): s is string =>
    typeof s === "string" && s.length > 0;
  if (kind === "admin") {

return [ids.adminMmUserId, ids.defaultAgentMmUserId].filter(nonEmpty);
  }
  return [ids.customerMmUserId, ids.defaultAgentMmUserId, ids.adminMmUserId].filter(nonEmpty);
}

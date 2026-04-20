/**
 * Pure decision fn for "who belongs in which customer channel".
 *
 * Under OpenClaw's multi-account MM plugin config (`channels.mattermost.
 * accounts.{accountId}.botToken`), each `{slug}-coach` authenticates its
 * OWN WebSocket subscription with its own PAT. MM pushes channel events
 * to the coach's WS because the coach is a member of its own channels —
 * no shared `octogee-bot` intermediary needed. The bot is no longer a
 * required channel member, and the Members panel stays clean.
 *
 * Customer channels get:
 *   - `coach`, `general`, `project` → customer + coach + admin
 *   - `admin`                         → admin + coach (customer NOT invited, #170)
 *
 * Pure function so tests lock the "never bot" invariant — any regression
 * that re-adds the bot (restoring the Members-panel wart) fails here.
 */

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

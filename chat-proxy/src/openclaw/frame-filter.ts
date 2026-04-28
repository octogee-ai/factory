/**
 * Per-user event scoping at the chat-proxy boundary (#728).
 *
 * The OpenClaw gateway's `broadcast()` is single-tenant by design: every
 * connected WS client is assumed to be a co-trusted operator. We violated
 * that assumption by inserting chat-proxy in front, where N distinct Firebase
 * users share one upstream gateway pod via N WS connections. Without
 * filtering, gateway-side broadcast for user A's run is forwarded to every
 * chat-proxy connection — including user B's.
 *
 * This filter inspects each inbound frame from the upstream gateway and
 * decides whether to forward to the connection's browser based on the frame's
 * embedded identity (`payload.sessionKey`, which the gateway constructs as
 * `agent:<agentId>:<key>` per `canonicalizeSessionKeyForAgent` in
 * src/gateway/session-store-key.ts of the OpenClaw fork).
 *
 * Rules:
 * - Per-user event classes (agent, chat, chat.side_result, *.approval.*,
 *   sessions.changed, session.message, session.tool) forward only when the
 *   sessionKey's agentId is an exact match for this connection's expected
 *   agentId. Exact match — not a slug-prefix — because hyphens are legal in
 *   usernames (`USERNAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/` in
 *   shared/types/identity.ts). A prefix on the first hyphen-token would
 *   collapse `octogee-bloom-marketing-coach` to `octogee-bloom-`, which
 *   would over-match every other `bloom-…` user — same threat model #728
 *   tries to close.
 * - System event classes (heartbeat, health, tick, cron, presence, shutdown,
 *   update.available, voicewake.changed, talk.mode, *.pair.*) forward
 *   unconditionally — gateway-wide infra signals.
 * - Non-event frames (responses, requests) forward unconditionally — they're
 *   per-connection RPC, not broadcast.
 * - Unparseable frames (binary, invalid JSON) forward as-is — gateway
 *   broadcast() doesn't carry per-user data through these paths.
 * - Unknown event classes drop with `unknown-event-class` (fail-closed) so
 *   any future leak class surfaces as a counter increment, not a silent
 *   forward.
 *
 * Known deferrals (filed for post-F&F follow-up if real traffic gets dropped):
 * - Per-user events without sessionKey drop as `missing-identity`. For F&F
 *   all activity originates from chat-send and carries sessionKey; cron- or
 *   device-pair-launched runs that produce agent stream output without a
 *   sessionKey would drop here. We chose fail-closed over a runId-tracking
 *   side channel; the counter will surface this if it actually happens.
 * - Today's Octogee architecture is single-coach-per-user (chief-of-staff
 *   model — see `project_one_agent_not_team`). Sub-agent suffixes (e.g. an
 *   `octogee-{slug}-research`) drop with identity-mismatch under exact
 *   match. If sub-agents become a real surface, add an explicit allow-list
 *   keyed off the user's slug rather than re-introducing prefix matching.
 */

export type ForwardReason =
  | "matched-identity"
  | "system-event"
  | "non-event-frame"
  | "unparseable";

export type DropReason =
  | "identity-mismatch"
  | "missing-identity"
  | "unknown-event-class";

export type FrameDecision =
  | { forward: true; reason: ForwardReason }
  | { forward: false; reason: DropReason };

export interface FilterContext {
  /**
   * Canonical agentId for the connection's user — typically
   * `octogee-{slug}-coach`. Must NOT include a trailing colon. The filter
   * derives the per-user prefix as `agent:octogee-{slug}-` so sub-agents
   * (e.g. octogee-{slug}-research) tied to the same user pass through.
   */
  expectedAgentId: string;
}

// Per-user event classes — sessionKey-scoped. If the frame's sessionKey
// doesn't carry this connection's user identity, drop.
//
// Cross-reference EVENT_SCOPE_GUARDS in the OpenClaw fork's
// `src/gateway/server-broadcast.ts`: any event listed there as
// requiring READ_SCOPE belongs here unless it's emitted exclusively
// via broadcastToConnIds() with already-scoped subscriber sets. Today
// `session.tool` is emitted via the latter, but list it anyway so that
// a future code path emitting session.tool over plain broadcast()
// doesn't bypass the filter.
const PER_USER_EVENTS = new Set<string>([
  "agent",
  "chat",
  "chat.side_result",
  "exec.approval.requested",
  "exec.approval.resolved",
  "plugin.approval.requested",
  "plugin.approval.resolved",
  "sessions.changed",
  "session.message",
  "session.tool",
]);

// System event classes — gateway-wide infra signals. Forward unconditionally.
const SYSTEM_EVENTS = new Set<string>([
  "heartbeat",
  "health",
  "tick",
  "cron",
  "presence",
  "shutdown",
  "update.available",
  "voicewake.changed",
  "talk.mode",
  "device.pair.requested",
  "device.pair.resolved",
  "node.pair.requested",
  "node.pair.resolved",
]);

export function shouldForwardFrame(
  rawFrame: string,
  ctx: FilterContext,
): FrameDecision {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFrame);
  } catch {
    return { forward: true, reason: "unparseable" };
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { type?: unknown }).type !== "event"
  ) {
    return { forward: true, reason: "non-event-frame" };
  }

  const envelope = parsed as { event?: unknown; payload?: unknown };
  const event = typeof envelope.event === "string" ? envelope.event : "";

  if (SYSTEM_EVENTS.has(event)) {
    return { forward: true, reason: "system-event" };
  }

  if (!PER_USER_EVENTS.has(event)) {
    return { forward: false, reason: "unknown-event-class" };
  }

  const payload =
    envelope.payload && typeof envelope.payload === "object" ? envelope.payload : {};
  const sessionKey = (payload as { sessionKey?: unknown }).sessionKey;

  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    return { forward: false, reason: "missing-identity" };
  }

  // sessionKey shape: `agent:<agentId>:<rest>`. Exact-match the agentId —
  // see the file header for why prefix matching would re-open the leak for
  // hyphenated slugs.
  if (sessionKey.startsWith(`agent:${ctx.expectedAgentId}:`)) {
    return { forward: true, reason: "matched-identity" };
  }

  return { forward: false, reason: "identity-mismatch" };
}

// ─── ExpectedAgentId derivation ─────────────────────────────────────────────
//
// The connection's `expectedAgentId` is computed from the user's slug — same
// formula as the trial-expiry handler in workspace-api uses for the Coach DM
// channel: `octogee-{slug}-coach` where slug = users/{uid}.username
// ?? users/{uid}.defaultWorkspaceId.
//
// Two flavors:
//   - `deriveExpectedAgentId(uid, userData)` — pure, takes a pre-fetched
//     user doc. Use this from chat-proxy's WS upgrade where
//     `resolveGatewayUrl` already returned the user data.
//   - `resolveExpectedAgentId(db, uid)` — convenience wrapper that reads
//     the doc itself. Kept for callers without a pre-fetched data view.

export class ExpectedAgentIdError extends Error {
  override readonly name = "ExpectedAgentIdError";
  constructor(message: string) {
    super(message);
  }
}

interface FirestoreLike {
  doc(path: string): {
    get(): Promise<{ exists: boolean; data: () => Record<string, unknown> | undefined }>;
  };
}

export function deriveExpectedAgentId(
  uid: string,
  userData: Record<string, unknown>,
): string {
  const username = typeof userData.username === "string" ? userData.username : "";
  const fallback =
    typeof userData.defaultWorkspaceId === "string" ? userData.defaultWorkspaceId : "";
  const slug = username || fallback;
  if (!slug) {
    throw new ExpectedAgentIdError(
      `users/${uid} has neither username nor defaultWorkspaceId set`,
    );
  }
  return `octogee-${slug}-coach`;
}

export async function resolveExpectedAgentId(
  db: FirestoreLike,
  uid: string,
): Promise<string> {
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists) {
    throw new ExpectedAgentIdError(
      `users/${uid} does not exist — cannot derive expectedAgentId`,
    );
  }
  return deriveExpectedAgentId(uid, snap.data() ?? {});
}

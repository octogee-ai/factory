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
  expectedAgentId: string;
}

export const PER_USER_EVENTS = new Set<string>([
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
  "session.approval",
  "diagnostic",
]);

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

  if (sessionKey.startsWith(`agent:${ctx.expectedAgentId}:`)) {
    return { forward: true, reason: "matched-identity" };
  }

  return { forward: false, reason: "identity-mismatch" };
}

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

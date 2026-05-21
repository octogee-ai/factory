/**
 * Server-side BYO-sub onboarding flow (Chunk C1). Pure state machine for
 * the gateway-held headless `codex login --device-auth` flow — codex
 * self-completes (it polls OpenAI); we react to its exit + the async
 * human approval window. Design: BYO-SUBSCRIPTION-OAUTH-SPEC.md §13.
 * I/O (child spawn, HTTP, capture-callback) lives in the gateway runner /
 * gateway-edge handlers and is exercised in TEST.
 */

export type FlowState =
  | { phase: "awaiting_user"; url: string; code: string; expiresAt: number }
  | { phase: "capturing" }
  | { phase: "connected" }
  | { phase: "expired" }
  | { phase: "failed"; reason: string };

export type FlowEvent =
  | { type: "childExit"; code: number; authPresent: boolean }
  | { type: "tick"; now: number }
  | { type: "captureResult"; ok: boolean; reason?: string };

/** The coach agent id for a workspace slug (per platform naming). */
export function coachAgentId(slug: string): string {
  return `octogee-${slug}-coach`;
}

export function startFlow(p: {
  url: string;
  code: string;
  expiresAt: number;
}): FlowState {
  return {
    phase: "awaiting_user",
    url: p.url,
    code: p.code,
    expiresAt: p.expiresAt,
  };
}

/**
 * Total, pure reducer. Events invalid for the current phase return the
 * state unchanged (defined reducer behaviour, test-pinned — not a
 * defensive guard). Terminal phases (connected/expired/failed) are
 * idempotent.
 */
export function nextFlowState(state: FlowState, event: FlowEvent): FlowState {
  switch (state.phase) {
    case "awaiting_user":
      if (event.type === "tick") {
        return event.now >= state.expiresAt ? { phase: "expired" } : state;
      }
      if (event.type === "childExit") {
        if (event.code === 0 && event.authPresent) return { phase: "capturing" };
        if (event.code === 0) {
          return {
            phase: "failed",
            reason: "codex exited 0 but no auth.json present",
          };
        }
        return {
          phase: "failed",
          reason: `codex device-auth exited ${event.code}`,
        };
      }
      return state;
    case "capturing":
      if (event.type === "captureResult") {
        return event.ok
          ? { phase: "connected" }
          : {
              phase: "failed",
              reason: `capture failed: ${event.reason ?? "unknown"}`,
            };
      }
      return state;
    default:
      return state; // connected / expired / failed — terminal + idempotent
  }
}

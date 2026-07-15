export function coachAgentId(slug) {
    return `octogee-${slug}-coach`;
}
export function startFlow(p) {
    return {
        phase: "awaiting_user",
        url: p.url,
        code: p.code,
        expiresAt: p.expiresAt,
    };
}
export function nextFlowState(state, event) {
    switch (state.phase) {
        case "awaiting_user":
            if (event.type === "tick") {
                return event.now >= state.expiresAt ? { phase: "expired" } : state;
            }
            if (event.type === "childExit") {
                if (event.code === 0 && event.authPresent)
                    return { phase: "capturing" };
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
            return state;
    }
}

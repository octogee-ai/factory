/**
 * Canonical OpenClaw gateway WS wire-protocol version — the single source
 * of truth for the connect handshake (`minProtocol`/`maxProtocol`). The
 * gateway sends `expectedProtocol`/`minimumProbeProtocol` and closes with
 * code 1002 (`protocol-mismatch`) against any client declaring a different
 * version. Bump this in lockstep with every OpenClaw gateway base-image
 * roll.
 *
 * `scripts/lib/gateway-rpc.ts` imports this directly. `chat-proxy/src/
 * openclaw/upstream.ts` is a hermetic Docker build and cannot reach
 * `shared/`, so it mirrors the integer; the lockstep is enforced at CI
 * time by `tests/specs/openclaw-wire-lockstep.spec.ts` rather than by a
 * hand-written "keep in sync" comment (which already drifted once — the
 * 2026.5.12 roll).
 */
export const OPENCLAW_PROTOCOL_VERSION = 4;

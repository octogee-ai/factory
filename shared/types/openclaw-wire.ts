/**
 * Canonical OpenClaw gateway WS wire-protocol version — the single source
 * of truth for the connect handshake (`minProtocol`/`maxProtocol`). The
 * gateway sends `expectedProtocol`/`minimumProbeProtocol` and closes with
 * code 1002 (`protocol-mismatch`) against any client declaring a different
 * version. Bump this in lockstep with every OpenClaw gateway base-image
 * roll.
 *
 * Both in-pod clients — `scripts/lib/gateway-rpc.ts` and
 * `chat-proxy/src/openclaw/upstream.ts` — import this directly, so the
 * value cannot drift between them (it did once, on the 2026.5.12 roll,
 * back when each hardcoded its own literal).
 */
export const OPENCLAW_PROTOCOL_VERSION = 4;

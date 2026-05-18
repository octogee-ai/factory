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
 *
 * Fork-added wire surface (re-verify field names on every base-image roll;
 * Step 5b of infra/gateway/openclaw-tarball/README.md). These are ADDITIVE +
 * env-gated default-off, so they do NOT bump the version on their own — but
 * if a future roll changes their shape, fold that into the next bump:
 *   - `OPENCLAW_BROADCAST_ALL_AGENT_RUNS` → existing `agent` broadcast
 *   - `OPENCLAW_BROADCAST_DIAGNOSTIC_EVENTS` → `diagnostic` broadcast,
 *     payload `{ sessionKey, type, ts, data }`; allowlist incl.
 *     `session.execution_phase` (fork 6ed39d7e+, Hunks A+B,
 *     ACTIVITY-HARNESS-SIGNAL-SPEC §1)
 */
export const OPENCLAW_PROTOCOL_VERSION = 4;

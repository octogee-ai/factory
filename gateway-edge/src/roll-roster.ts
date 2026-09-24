import http from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  WORKSPACE_MOVING_CODE,
  WORKSPACE_MOVING_MESSAGE,
} from "@octogee/shared/types/workspace-migration";
import {
  isAssignmentState,
  type AssignmentState,
} from "@octogee/shared/types/gateway-releases";

// Per-customer admission at the edge (GATEWAY-SIMPLE-ROLL-SPEC). One stable pod
// serves each gateway, so there is nothing to forward between revisions — the
// roster's only job is the migration quiesce gate: a customer whose assignment
// is quiescing/migrating is refused with 503 + Retry-After on EVERY surface
// until the atomic cutover stamps the target serving (no double-serve window;
// see commitCutoverAtomic in @octogee/core/fleet-state).
//
// SECURITY INVARIANTS (each pinned by roll-roster.spec.ts):
//  - The roster is READ-ONLY here (Cowboy/octogee-api are the writers) and
//    scoped to this pod's own gateway.
//  - The uid used for admission comes from an UNVERIFIED bearer decode: it only
//    selects between serving and 503-retry for a tenant this pod already
//    serves, so a forged token cannot cross any tenant boundary; real auth
//    still runs downstream.
//  - Fails CLOSED: until the first roster snapshot lands (and after a terminal
//    roster-source error) customer-state traffic answers 503 + Retry-After.

export interface RosterEntry {
  uid: string;
  state: AssignmentState;
  epoch: number;
}

export interface RollRosterStore {
  loaded: () => boolean;
  get: (uid: string) => RosterEntry | undefined;
  stop: () => void;
}

export interface RosterDocSnapshot {
  id: string;
  data: () => Record<string, unknown> | undefined;
}

export interface CreateRollRosterStoreOptions {
  // Each callback delivers the full current assignment set.
  subscribe: (
    onDocs: (docs: RosterDocSnapshot[]) => void,
    onError: (err: Error) => void,
  ) => () => void;
  log: (msg: string) => void;
  // Backoff scheduler for re-establishing the listener after a terminal error.
  // `attempt` is 0-based; `retry` re-subscribes. Test seam — production defaults
  // to an exponential-backoff setTimeout (capped, unref'd).
  scheduleReconnect?: (attempt: number, retry: () => void) => void;
}

function defaultScheduleReconnect(attempt: number, retry: () => void): void {
  const delayMs = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
  const timer = setTimeout(retry, delayMs);
  if (typeof timer.unref === "function") timer.unref();
}

function parseRosterEntry(id: string, data: Record<string, unknown> | undefined): RosterEntry | null {
  if (!data) return null;
  return {
    uid: id,
    state: isAssignmentState(data.state) ? data.state : "serving",
    epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
  };
}

// Fails CLOSED: until the first snapshot lands, loaded() is false and the gate
// answers 503 + Retry-After — an edge booting mid-migration must never default
// to serve-local for a quiescing customer (council-resolved).
//
// A terminal roster-source error is ALSO fail-closed: an edge that misses a
// quiescing/cutover update could keep admitting a customer after the migration
// target begins serving. On error readiness drops, the detached roster is
// discarded, and the edge reconnects with backoff.
export function createRollRosterStore(opts: CreateRollRosterStoreOptions): RollRosterStore {
  let loaded = false;
  let entries = new Map<string, RosterEntry>();
  let unsubscribe: () => void = () => undefined;
  let stopped = false;
  let attempt = 0;
  const scheduleReconnect = opts.scheduleReconnect ?? defaultScheduleReconnect;

  function connect(): void {
    unsubscribe = opts.subscribe(
      (docs) => {
        const next = new Map<string, RosterEntry>();
        for (const doc of docs) {
          const entry = parseRosterEntry(doc.id, doc.data());
          if (entry) next.set(entry.uid, entry);
        }
        entries = next;
        loaded = true;
        attempt = 0;
      },
      (err) => {
        loaded = false;
        entries = new Map<string, RosterEntry>();
        opts.log(
          `[roll-roster] ⚠ assignment snapshot error: ${err.message} — ` +
            `roster DETACHED; readiness dropped (service traffic answers 503) until re-subscribe`,
        );
        try {
          unsubscribe();
        } catch {
          // The listener is already torn down; nothing to release.
        }
        if (stopped) return;
        scheduleReconnect(attempt++, () => {
          if (!stopped) connect();
        });
      },
    );
  }
  connect();

  return {
    loaded: () => loaded,
    get: (uid) => entries.get(uid),
    stop: () => {
      stopped = true;
      try {
        unsubscribe();
      } catch {
        // Already torn down.
      }
    },
  };
}

export type ServiceRouteDecision =
  | { action: "serve" }
  | {
      action: "unavailable";
      reason: "roster-loading" | "customer-quiescing";
    };

export interface ServiceRouteInput {
  rosterLoaded: boolean;
  entry: RosterEntry | null;
}

export function resolveServiceRoute(input: ServiceRouteInput): ServiceRouteDecision {
  if (!input.rosterLoaded) return { action: "unavailable", reason: "roster-loading" };
  const entry = input.entry;
  // Gap user / unknown customer: this pod is the gateway's only pod — serve
  // locally, exactly like the mount driver's rule.
  if (!entry) return { action: "serve" };
  // quiescing/migrating blocks the customer until the atomic roster flip
  // stamps the migration target serving — no double-serve window.
  if (entry.state !== "serving") {
    return { action: "unavailable", reason: "customer-quiescing" };
  }
  return { action: "serve" };
}

// Routing-only uid extraction: base64url-decode the bearer's JWT payload
// WITHOUT verification (see the security invariants above for why that is
// sound here). Verification still happens downstream.
export function uidFromAuthHeader(header: string | undefined): string | null {
  if (!header || !header.startsWith("Bearer ")) return null;
  const parts = header.slice("Bearer ".length).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      user_id?: unknown;
      sub?: unknown;
    };
    const uid = typeof payload.user_id === "string" ? payload.user_id : payload.sub;
    return typeof uid === "string" && uid.length > 0 ? uid : null;
  } catch {
    return null;
  }
}

export interface CreateRollRosterGateOptions {
  store: Pick<RollRosterStore, "loaded" | "get">;
  gatewayId: string;
  // This pod's identity alias (always the bare gatewayId under simple-roll).
  // Empty = legacy/cluster surface → the gate disables itself entirely.
  selfRevisionId: string;
  resolveUid?: (req: Request) => string | null;
  retryAfterSeconds?: number;
  log: (msg: string) => void;
}

export function unavailableBody(reason: string): Record<string, unknown> {
  if (reason !== "customer-quiescing") return { error: "gateway_revision_unavailable", reason };
  return {
    error: "gateway_revision_unavailable",
    reason,
    code: WORKSPACE_MOVING_CODE,
    id: WORKSPACE_MOVING_CODE,
    status_code: 503,
    message: WORKSPACE_MOVING_MESSAGE,
  };
}

function writeUnavailable(res: Response, reason: string, retryAfterSeconds: number): void {
  res
    .status(503)
    .set("Retry-After", String(retryAfterSeconds))
    .json(unavailableBody(reason));
}

// The Express gate for the sidecar's service-addressed surface. Runs before the
// locality routers; per-request cost in steady state is one Map lookup.
export function createRollRosterGate(opts: CreateRollRosterGateOptions): RequestHandler {
  const retryAfterSeconds = opts.retryAfterSeconds ?? 2;
  const resolveUid = opts.resolveUid ?? ((req: Request) => uidFromAuthHeader(req.headers.authorization));
  return (req: Request, res: Response, next: NextFunction) => {
    if (!opts.selfRevisionId) {
      next();
      return;
    }
    if (!opts.store.loaded()) {
      writeUnavailable(res, "roster-loading", retryAfterSeconds);
      return;
    }
    const uid = resolveUid(req);
    const decision = resolveServiceRoute({
      rosterLoaded: true,
      entry: uid ? (opts.store.get(uid) ?? null) : null,
    });
    if (decision.action === "serve") {
      next();
      return;
    }
    writeUnavailable(res, decision.reason, retryAfterSeconds);
  };
}

// ---------------------------------------------------------------------------
// WebSocket upgrade gate
// ---------------------------------------------------------------------------
//
// Upgrades bypass Express, so they get their own enforcement at the upgrade
// path itself. A quiescing customer is REFUSED attach (503 + Retry-After) and
// the client reconnects after the migration cutover settles. checkRequest runs
// pre-dispatch (roster boot gate + bearer uid when resolvable); checkUid runs
// post-auth wherever a flow resolves the customer (OpenClaw ticket redemption)
// — so a stale attach is impossible even for
// flows whose identity only appears after the handshake starts.

// The single retryable "customer not admitted" WS-upgrade response: 503 + a
// Retry-After hint + a typed body the client keys on to reconnect after the
// migration settles (NEVER an opaque 500).
export function revisionUnavailableUpgradeResponse(
  retryAfterSeconds: number,
  reason: string,
): string {
  return (
    "HTTP/1.1 503 Service Unavailable\r\n" +
    `Retry-After: ${retryAfterSeconds}\r\n` +
    "Content-Type: application/json\r\n" +
    "Connection: close\r\n\r\n" +
    JSON.stringify(unavailableBody(reason))
  );
}

export type UpgradeGateVerdict = { allow: true } | { allow: false; reason: string };

export interface RollRosterUpgradeGate {
  checkRequest: (req: http.IncomingMessage) => UpgradeGateVerdict;
  checkUid: (uid: string | null) => UpgradeGateVerdict;
  // An authenticated identity that resolves to NO roster uid (a missing/stale
  // mattermost.userId→Firebase mapping). This is DISTINCT from checkUid(null),
  // which is the gap-user/legacy path that serves locally: here we KNOW the
  // client authenticated but cannot place it, so the pod REFUSES (retryable)
  // rather than attaching a stale mapping mid-migration. A legacy pod (no
  // roster gate) still allows.
  checkUnmappedIdentity: () => UpgradeGateVerdict;
  refuse: (socket: { write: (s: string) => void; destroy: () => void }, verdict: { reason: string }) => void;
}

export interface CreateRollRosterUpgradeGateOptions {
  store: Pick<RollRosterStore, "loaded" | "get">;
  gatewayId: string;
  selfRevisionId: string;
  resolveUid?: (req: http.IncomingMessage) => string | null;
  retryAfterSeconds?: number;
  log: (msg: string) => void;
}

export function createRollRosterUpgradeGate(
  opts: CreateRollRosterUpgradeGateOptions,
): RollRosterUpgradeGate {
  const retryAfterSeconds = opts.retryAfterSeconds ?? 2;
  const resolveUid =
    opts.resolveUid ??
    ((req: http.IncomingMessage) => uidFromAuthHeader(req.headers.authorization));

  const checkUid = (uid: string | null): UpgradeGateVerdict => {
    if (!opts.selfRevisionId) return { allow: true };
    if (!opts.store.loaded()) return { allow: false, reason: "roster-loading" };
    const decision = resolveServiceRoute({
      rosterLoaded: true,
      entry: uid ? (opts.store.get(uid) ?? null) : null,
    });
    if (decision.action === "serve") return { allow: true };
    return { allow: false, reason: decision.reason };
  };

  const checkUnmappedIdentity = (): UpgradeGateVerdict => {
    if (!opts.selfRevisionId) return { allow: true };
    if (!opts.store.loaded()) return { allow: false, reason: "roster-loading" };
    return { allow: false, reason: "identity-unmapped" };
  };

  return {
    checkUid,
    checkUnmappedIdentity,
    checkRequest: (req) => checkUid(resolveUid(req)),
    refuse: (socket, verdict) => {
      opts.log(
        `[roll-roster] refused WS upgrade on ${opts.selfRevisionId || "legacy"}: ${verdict.reason}`,
      );
      try {
        socket.write(revisionUnavailableUpgradeResponse(retryAfterSeconds, verdict.reason));
      } finally {
        socket.destroy();
      }
    },
  };
}

// Pre-dispatch guard for a shared `server.on("upgrade")` handler. Returns true
// when the request was refused (socket already answered + destroyed) — the
// caller must return without dispatching. Null gate (legacy pod, cluster
// surface) never refuses.
export function guardUpgradeRequest(
  gate: RollRosterUpgradeGate | null | undefined,
  req: http.IncomingMessage,
  socket: { write: (s: string) => void; destroy: () => void },
): boolean {
  if (!gate) return false;
  const verdict = gate.checkRequest(req);
  if (verdict.allow) return false;
  gate.refuse(socket, verdict);
  return true;
}

// Map an authenticated MM identity to the shared roster verdict (the auth-late
// MM WS seam). A null mmUserId (no MM identity resolved — legacy pod / cluster
// surface) is the gap-user path (checkUid(null)). A resolved identity whose
// Firebase uid cannot be looked up (missing/stale mattermost.userId mapping) is
// REFUSED via checkUnmappedIdentity — NOT served locally, which would attach a
// stale mapping mid-migration. A lookup that THROWS propagates so the caller
// (the bridge) fails closed.
export async function mmRosterVerdictFor(
  gate: RollRosterUpgradeGate,
  mmUserId: string | null,
  lookupUid: (mmUserId: string) => Promise<string | null>,
): Promise<UpgradeGateVerdict> {
  if (!mmUserId) return gate.checkUid(null);
  const uid = await lookupUid(mmUserId);
  if (uid === null) return gate.checkUnmappedIdentity();
  return gate.checkUid(uid);
}

// Wrap a ticket-redemption fn so the redeemed customer's roster verdict gates
// the attach: a refused customer's redeem throws, and
// the bridge closes the WS with its standard retry semantics.
export function wrapRedeemWithRosterGate<T extends { uid: string }>(
  redeem: (ticket: string) => Promise<T>,
  gate: RollRosterUpgradeGate | null | undefined,
): (ticket: string) => Promise<T> {
  if (!gate) return redeem;
  return async (ticket: string) => {
    const session = await redeem(ticket);
    const verdict = gate.checkUid(session.uid);
    if (!verdict.allow) {
      throw new Error(`roll roster refuses attach: ${verdict.reason}`);
    }
    return session;
  };
}

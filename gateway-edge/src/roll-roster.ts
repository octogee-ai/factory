import http from "node:http";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  ASSIGNMENT_EPOCH_HEADER,
  INTRA_FAMILY_HOP_HEADER,
  gatewayEdgeServiceName,
  isAssignmentState,
  type AssignmentState,
} from "@octogee/shared/types/gateway-releases";

// Mid-roll per-customer routing at the edge (GATEWAY-RELEASES-SPEC, "Inbound
// routing across rolls", council-resolved). During a roll the per-gateway
// Service selector still points at ONE revision, but individual customers cut
// over one at a time — so each revision's edge sidecar consults the durable
// roster (gateways/{gw}/assignments) and either serves, forwards ONE
// intra-family hop to the serving revision, or answers 503 + Retry-After for a
// customer mid-flip (quiescing blocks the source BEFORE the target serves —
// no double-serve window).
//
// SECURITY INVARIANTS (each pinned by roll-roster.spec.ts):
//  - The forward target is derived ONLY from this pod's bound GATEWAY_ID plus
//    the roster entry's revision — never from request content; an out-of-family
//    roster entry is refused, so a forward can never leave the gateway family.
//  - The hop/epoch headers are INTERNAL: the public gateway-router strips them
//    from every inbound request, and a request already carrying the hop header
//    is never forwarded again (one hop max, by construction).
//  - The roster is READ-ONLY here (Cowboy is the sole writer) and scoped to
//    this pod's own gateway.
//  - The uid used for routing comes from an UNVERIFIED bearer decode: it only
//    selects between two revisions serving the identical tenant set, so a
//    forged token cannot cross any tenant boundary; real auth still runs on
//    whichever revision serves the request.

export interface RosterEntry {
  uid: string;
  revisionId: string;
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
  // Snapshot subscription over gateways/{GATEWAY_ID}/assignments. Each callback
  // delivers the FULL current assignment set (Firestore onSnapshot semantics).
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
  if (!data || typeof data.revisionId !== "string") return null;
  return {
    uid: id,
    revisionId: data.revisionId,
    state: isAssignmentState(data.state) ? data.state : "serving",
    epoch: typeof data.epoch === "number" && data.epoch >= 0 ? data.epoch : 0,
  };
}

// Fails CLOSED: until the first snapshot lands, loaded() is false and the gate
// answers 503 + Retry-After — an edge booting mid-roll must never default to
// serve-local (council-resolved).
//
// A terminal listener error is ALSO fail-closed: Firestore has torn the listener
// down, so a source edge that then misses a quiescing/cutover update would keep
// admitting a customer after the target begins serving — defeating no-double-
// serve. On error we drop readiness (loaded → false, so the gate 503s), release
// the dead subscription, and re-subscribe with backoff. A detached stale roster
// must never remain authoritative.
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

// Strict membership check: {gatewayId}-r{n} for a positive integer n. Anchored
// so neither another gateway nor a crafted "-r" suffix chain can pass.
export function isIntraFamilyRevision(gatewayId: string, revisionId: string): boolean {
  if (!revisionId.startsWith(`${gatewayId}-r`)) return false;
  return /^[1-9]\d*$/.test(revisionId.slice(gatewayId.length + 2));
}

export type ServiceRouteDecision =
  | { action: "serve" }
  | {
      action: "unavailable";
      reason:
        | "roster-loading"
        | "customer-quiescing"
        | "forward-loop"
        | "stale-forward"
        | "out-of-family";
    }
  | { action: "forward"; targetRevisionId: string; epoch: number };

export interface ServiceRouteInput {
  rosterLoaded: boolean;
  entry: RosterEntry | null;
  selfRevisionId: string;
  gatewayId: string;
  isForwardedHop: boolean;
  forwardedEpoch: number | null;
}

export function resolveServiceRoute(input: ServiceRouteInput): ServiceRouteDecision {
  if (!input.rosterLoaded) return { action: "unavailable", reason: "roster-loading" };
  const entry = input.entry;
  // Gap user / unknown customer: the per-gateway Service selector already chose
  // the live revision — serve locally, exactly like the mount driver's rule.
  if (!entry) return { action: "serve" };
  // quiescing/migrating blocks EVERY revision for this customer until the
  // atomic roster flip stamps the target serving — no double-serve window.
  if (entry.state !== "serving") {
    return { action: "unavailable", reason: "customer-quiescing" };
  }
  if (entry.revisionId === input.selfRevisionId) return { action: "serve" };
  if (input.isForwardedHop) {
    // One hop max. A forwarded request that would forward AGAIN means the two
    // edges disagree (stale roster / mid-flip race) — 503 and let the client
    // retry against the fresh state, never bounce.
    return {
      action: "unavailable",
      reason:
        input.forwardedEpoch != null && input.forwardedEpoch < entry.epoch
          ? "stale-forward"
          : "forward-loop",
    };
  }
  if (!isIntraFamilyRevision(input.gatewayId, entry.revisionId)) {
    return { action: "unavailable", reason: "out-of-family" };
  }
  return { action: "forward", targetRevisionId: entry.revisionId, epoch: entry.epoch };
}

// Routing-only uid extraction: base64url-decode the bearer's JWT payload
// WITHOUT verification (see the security invariants above for why that is
// sound here). Verification still happens downstream on the serving revision.
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
  // This pod's revision ({gw}-r{n}). Empty = legacy pod → the gate disables
  // itself entirely (single-revision behavior, byte-identical to today).
  selfRevisionId: string;
  namespace?: string;
  edgePort?: number;
  // Test seam: origin for a forward target. Production default is the
  // revision's own edge Service DNS name.
  targetOriginForRevision?: (revisionId: string) => string;
  resolveUid?: (req: Request) => string | null;
  retryAfterSeconds?: number;
  log: (msg: string) => void;
}

function defaultForwardOrigin(revisionId: string, namespace: string, port: number): string {
  return `http://${gatewayEdgeServiceName(revisionId)}.${namespace}.svc.cluster.local:${port}`;
}

function writeUnavailable(res: Response, reason: string, retryAfterSeconds: number): void {
  res
    .status(503)
    .set("Retry-After", String(retryAfterSeconds))
    .json({ error: "gateway_revision_unavailable", reason });
}

function forwardIntraFamily(
  req: Request,
  res: Response,
  input: { origin: string; selfRevisionId: string; epoch: number; log: (msg: string) => void },
): void {
  const origin = new URL(input.origin);
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers.connection;
  headers.host = origin.host;
  headers[INTRA_FAMILY_HOP_HEADER] = input.selfRevisionId;
  headers[ASSIGNMENT_EPOCH_HEADER] = String(input.epoch);
  const proxyReq = http.request(
    {
      protocol: origin.protocol,
      hostname: origin.hostname,
      port: origin.port,
      method: req.method,
      path: req.originalUrl,
      headers,
    },
    (proxyRes) => {
      res.status(proxyRes.statusCode ?? 502);
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value !== undefined) res.setHeader(name, value);
      }
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", (err) => {
    input.log(`[roll-roster] ⚠ intra-family forward failed: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: "intra_family_forward_failed" });
    } else {
      res.destroy();
    }
  });
  res.on("close", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

// The Express gate for the sidecar's service-addressed surface. Runs before the
// locality routers; per-request cost in steady state is one Map lookup.
export function createRollRosterGate(opts: CreateRollRosterGateOptions): RequestHandler {
  const retryAfterSeconds = opts.retryAfterSeconds ?? 2;
  const namespace = opts.namespace ?? "octogee";
  const edgePort = opts.edgePort ?? 3001;
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
    const hopHeader = req.headers[INTRA_FAMILY_HOP_HEADER];
    const epochHeader = req.headers[ASSIGNMENT_EPOCH_HEADER];
    const forwardedEpoch =
      typeof epochHeader === "string" && /^\d+$/.test(epochHeader) ? Number(epochHeader) : null;
    const decision = resolveServiceRoute({
      rosterLoaded: true,
      entry: uid ? (opts.store.get(uid) ?? null) : null,
      selfRevisionId: opts.selfRevisionId,
      gatewayId: opts.gatewayId,
      isForwardedHop: hopHeader != null,
      forwardedEpoch,
    });
    switch (decision.action) {
      case "serve":
        next();
        return;
      case "unavailable":
        if (decision.reason === "out-of-family") {
          opts.log(
            `[roll-roster] ⛔ roster entry for uid=${uid} points OUT of the ${opts.gatewayId} family — refusing to forward`,
          );
        }
        writeUnavailable(res, decision.reason, retryAfterSeconds);
        return;
      case "forward": {
        const origin =
          opts.targetOriginForRevision?.(decision.targetRevisionId) ??
          defaultForwardOrigin(decision.targetRevisionId, namespace, edgePort);
        forwardIntraFamily(req, res, {
          origin,
          selfRevisionId: opts.selfRevisionId,
          epoch: decision.epoch,
          log: opts.log,
        });
        return;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// WebSocket upgrade gate (Codex review P0)
// ---------------------------------------------------------------------------
//
// Upgrades bypass Express, so they get their own enforcement at the upgrade
// path itself. WS cannot be transparently hop-forwarded like HTTP — a customer
// serving on another revision is REFUSED attach (503 + Retry-After) and the
// client reconnects via /api/mattermost/token + /g/<gw>/… which resolves to
// the current serving revision (the routing section's reconnect model).
// checkRequest runs pre-dispatch (roster boot gate + bearer uid when
// resolvable); checkUid runs post-auth wherever a flow resolves the customer
// (OpenClaw ticket redemption, builder-shell ticket redemption) — so a stale
// attach is impossible even for flows whose identity only appears after the
// handshake starts.

// The single retryable "revision not serving" WS-upgrade response: 503 + a
// Retry-After hint + a typed body the client keys on to reconnect after the roll
// settles (NEVER an opaque 500). Both the roster refusal (customer quiescing /
// serving-elsewhere / roster-loading) and the runtime-broker 502
// (gateway-url-unresolved / dead revision) surface through this ONE shape, so the
// client sees one consistent retryable signal at the upgrade surface.
export function revisionUnavailableUpgradeResponse(
  retryAfterSeconds: number,
  reason: string,
): string {
  return (
    "HTTP/1.1 503 Service Unavailable\r\n" +
    `Retry-After: ${retryAfterSeconds}\r\n` +
    "Content-Type: application/json\r\n" +
    "Connection: close\r\n\r\n" +
    JSON.stringify({ error: "gateway_revision_unavailable", reason })
  );
}

export type UpgradeGateVerdict = { allow: true } | { allow: false; reason: string };

export interface RollRosterUpgradeGate {
  checkRequest: (req: http.IncomingMessage) => UpgradeGateVerdict;
  checkUid: (uid: string | null) => UpgradeGateVerdict;
  // An authenticated identity that resolves to NO roster uid (a missing/stale
  // mattermost.userId→Firebase mapping). This is DISTINCT from checkUid(null),
  // which is the gap-user/legacy path that serves locally: here we KNOW the
  // client authenticated but cannot place it on a revision, so a revision pod
  // REFUSES (retryable) rather than serving the local revision during a roll. A
  // legacy pod (no roster gate) still allows.
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
      selfRevisionId: opts.selfRevisionId,
      gatewayId: opts.gatewayId,
      isForwardedHop: false,
      forwardedEpoch: null,
    });
    if (decision.action === "serve") return { allow: true };
    if (decision.action === "forward") return { allow: false, reason: "serving-elsewhere" };
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
// stale mapping to the local revision during a roll. A lookup that THROWS
// propagates so the caller (the bridge) fails closed.
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
// the attach (the builder-shell site): a refused customer's redeem throws, and
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

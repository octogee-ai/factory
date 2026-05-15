import type { RawData, WebSocket } from "ws";

export interface MmWsProxyDeps {
  /** Internal MM WS URL (e.g. ws://mattermost.octogee-test.svc.cluster.local:8065/api/v4/websocket). */
  mmInternalWsUrl: string;
  log: (msg: string) => void;
  /**
   * Resolve the MM user id for a given MM personal access / session token.
   * Used to gate the octogee_ack injection: only the user's own `posted`
   * events should trigger an ack frame.
   *
   * Implementations may cache by token. Returning null disables ack
   * injection for this connection (other frames still forward unchanged).
   */
  resolveMmUserId: (mmToken: string) => Promise<string | null>;
  /** Factory for the upstream WS — injected so tests can supply a fake. */
  openUpstream: (url: string) => WebSocket;
  now?: () => number;
  /**
   * Max time to wait for the mmUserId resolution before forwarding an
   * inbound `posted` event without ack injection. Defaults to 2_000.
   */
  ackResolutionTimeoutMs?: number;
}

export interface MmWsBridge {
  /** Detach + close both sides. */
  close: () => void;
}

export interface AckFrame {
  event: "octogee_ack";
  data: {
    postId: string;
    channelId: string;
    receivedAt: number;
  };
}

/**
 * Wires up a single browser ↔ MM WS bridge. Raw byte forward in both
 * directions, with one tap on the MM → browser side: when a `posted` event
 * arrives whose author matches the connected user's MM id, inject a
 * synthetic `octogee_ack` frame on the same WS *before* forwarding the
 * original. The app subscribes to `event === "octogee_ack"` to drive its
 * thinking-state UI.
 */
export function attachMmWsBridge(
  deps: MmWsProxyDeps,
  browserWs: WebSocket,
): MmWsBridge {
  const now = deps.now ?? Date.now;
  const ackResolutionTimeoutMs = deps.ackResolutionTimeoutMs ?? 2_000;
  const upstream = deps.openUpstream(deps.mmInternalWsUrl);
  let mmUserId: string | null = null;
  let pendingMmUserId: Promise<string | null> | null = null;
  let closed = false;
  let upstreamOpen = false;
  const browserOutbox: Array<{ frame: RawData; binary: boolean }> = [];
  let inboundChain: Promise<void> = Promise.resolve();

  const close = () => {
    if (closed) return;
    closed = true;
    safeClose(browserWs);
    safeClose(upstream);
  };

  const flushOutbox = () => {
    if (!upstreamOpen) return;
    while (browserOutbox.length > 0) {
      const queued = browserOutbox.shift();
      if (queued === undefined) break;
      try {
        upstream.send(queued.frame, { binary: queued.binary });
      } catch (err) {
        deps.log(`[mm-proxy/ws] flushOutbox send failed: ${(err as Error).message}`);
        return;
      }
    }
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    flushOutbox();
  });

  // `isBinary` MUST be preserved end to end. `ws` delivers every message
  // as a Buffer; `ws.send(Buffer)` defaults to a binary frame. The MM
  // client sends its `authentication_challenge` (and all actions) as
  // text — forwarding them as binary makes Mattermost close the socket
  // with `UnauthBinary: binary frames require authentication`, which the
  // app sees as a 1 Hz connect/close reconnect loop.
  browserWs.on("message", (data: RawData, isBinary: boolean) => {
    if (!mmUserId && !pendingMmUserId) {
      pendingMmUserId = maybeCaptureMmTokenForAuth(data, deps.resolveMmUserId)
        .then((resolvedId) => {
          if (resolvedId && !mmUserId) mmUserId = resolvedId;
          return resolvedId ?? null;
        })
        .catch((err: Error) => {
          deps.log(`[mm-proxy/ws] resolveMmUserId rejected: ${err.message}`);
          return null;
        })
        .finally(() => {
          pendingMmUserId = null;
        });
    }
    if (upstreamOpen && upstream.readyState === 1 /* OPEN */) {
      upstream.send(data, { binary: isBinary });
    } else {
      browserOutbox.push({ frame: data, binary: isBinary });
    }
  });

  upstream.on("message", (data: RawData, isBinary: boolean) => {
    inboundChain = inboundChain.then(async () => {
      let effectiveUserId = mmUserId;
      if (!effectiveUserId && pendingMmUserId) {
        try {
          effectiveUserId = await Promise.race<string | null>([
            pendingMmUserId,
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), ackResolutionTimeoutMs),
            ),
          ]);
        } catch {
          effectiveUserId = null;
        }
      }
      if (closed || browserWs.readyState !== 1) return;
      const ack = buildAckIfUserPost(data, effectiveUserId ?? mmUserId, now);
      if (ack) {
        try {
          browserWs.send(JSON.stringify(ack));
        } catch (err) {
          deps.log(`[mm-proxy/ws] ack inject failed: ${(err as Error).message}`);
        }
      }
      try {
        browserWs.send(data, { binary: isBinary });
      } catch (err) {
        deps.log(`[mm-proxy/ws] downstream forward failed: ${(err as Error).message}`);
      }
    });
  });

  browserWs.on("close", () => close());
  upstream.on("close", () => close());
  browserWs.on("error", (err: Error) =>
    deps.log(`[mm-proxy/ws] browser error: ${err.message}`),
  );
  upstream.on("error", (err: Error) =>
    deps.log(`[mm-proxy/ws] upstream error: ${err.message}`),
  );

  return { close };
}

/**
 * Inspects an outbound (browser → MM) frame. If it's the
 * `authentication_challenge` action, extracts the token and resolves the
 * MM user id via the supplied lookup. Returns the resolved user id or null.
 */
export async function maybeCaptureMmTokenForAuth(
  data: RawData | string,
  resolveMmUserId: (token: string) => Promise<string | null>,
): Promise<string | null> {
  const frame = parseJsonFrame(data);
  if (!frame) return null;
  if (frame.action !== "authentication_challenge") return null;
  const token =
    frame.data && typeof frame.data === "object"
      ? (frame.data as { token?: unknown }).token
      : undefined;
  if (typeof token !== "string" || token.length === 0) return null;
  return resolveMmUserId(token);
}

/**
 * Inspects an inbound (MM → browser) frame. If it's a `posted` event whose
 * author matches the connected user's MM id, returns the synthetic ack
 * frame to send first. Otherwise returns null.
 */
export function buildAckIfUserPost(
  data: RawData | string,
  mmUserId: string | null,
  now: () => number,
): AckFrame | null {
  if (!mmUserId) return null;
  const frame = parseJsonFrame(data);
  if (!frame) return null;
  if (frame.event !== "posted") return null;
  const post = parsePostField(frame.data);
  if (!post) return null;
  if (post.user_id !== mmUserId) return null;
  return {
    event: "octogee_ack",
    data: {
      postId: post.id,
      channelId: post.channel_id,
      receivedAt: now(),
    },
  };
}

interface PartialMmFrame {
  event?: unknown;
  action?: unknown;
  data?: unknown;
}

function parseJsonFrame(data: RawData | string): PartialMmFrame | null {
  try {
    const str = rawDataToString(data);
    if (str.length === 0 || str[0] !== "{") return null;
    const parsed = JSON.parse(str) as unknown;
    if (parsed && typeof parsed === "object") return parsed as PartialMmFrame;
    return null;
  } catch {
    return null;
  }
}

interface MmPostShape {
  id: string;
  user_id: string;
  channel_id: string;
}

function rawDataToString(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf-8");
  return Buffer.from(data as ArrayBuffer).toString("utf-8");
}

function parsePostField(eventData: unknown): MmPostShape | null {
  if (!eventData || typeof eventData !== "object") return null;
  const postField = (eventData as { post?: unknown }).post;
  let post: unknown = postField;
  if (typeof postField === "string") {
    try {
      post = JSON.parse(postField);
    } catch {
      return null;
    }
  }
  if (!post || typeof post !== "object") return null;
  const p = post as { id?: unknown; user_id?: unknown; channel_id?: unknown };
  if (typeof p.id !== "string" || typeof p.user_id !== "string" || typeof p.channel_id !== "string") {
    return null;
  }
  return { id: p.id, user_id: p.user_id, channel_id: p.channel_id };
}

function safeClose(ws: WebSocket): void {
  try {
    if (ws.readyState !== 3 /* CLOSED */) ws.close();
  } catch {
    /* ignore */
  }
}

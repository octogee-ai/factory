import type { RawData, WebSocket } from "ws";

export interface MmWsProxyDeps {
  
  mmInternalWsUrl: string;
  log: (msg: string) => void;

resolveMmUserId: (mmToken: string) => Promise<string | null>;
  
  openUpstream: (url: string) => WebSocket;

registry?: MmWsRegistry;
  now?: () => number;

ackResolutionTimeoutMs?: number;
}

export interface MmWsBridge {
  
  close: () => void;
}

interface RegistryConn {
  send: (frame: string) => void;
  getMmUserId: () => string | null;
}

export interface MmWsRegistry {
  add: (send: (frame: string) => void, getMmUserId: () => string | null) => () => void;

broadcast: (frame: unknown, isAllowed?: (mmUserId: string | null) => boolean) => void;
}

export function createMmWsRegistry(): MmWsRegistry {
  const conns = new Set<RegistryConn>();
  return {
    add(send, getMmUserId) {
      const conn: RegistryConn = { send, getMmUserId };
      conns.add(conn);
      return () => conns.delete(conn);
    },
    broadcast(frame, isAllowed) {
      const json = JSON.stringify(frame);
      for (const conn of conns) {
        if (isAllowed) {
          const uid = conn.getMmUserId();

if (uid === null || !isAllowed(uid)) continue;
        }
        try {
          conn.send(json);
        } catch {
          // a dead socket must not abort the fan-out
        }
      }
    },
  };
}

export interface AckFrame {
  event: "octogee_ack";
  data: {
    postId: string;
    channelId: string;
    receivedAt: number;
  };
}

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

  const unregister = deps.registry?.add(
    (frame: string) => {
      if (closed || browserWs.readyState !== 1) return;
      browserWs.send(frame);
    },
    () => mmUserId,
  );

  const close = () => {
    if (closed) return;
    closed = true;
    unregister?.();
    safeClose(browserWs);
    safeClose(upstream);
  };

const logClose = (side: "browser" | "upstream", code: number, reason: unknown) => {
    if (closed) return;
    deps.log(
      `[mm-proxy/ws] ${side} close code=${code ?? "?"} reason=${reasonToStr(reason)} mmUserId=${mmUserId ?? "unknown"}`,
    );
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
    deps.log(`[mm-proxy/ws] upstream open (mmUserId=${mmUserId ?? "unknown"})`);
    flushOutbox();
  });

browserWs.on("message", (data: RawData, isBinary: boolean) => {
    if (!mmUserId && !pendingMmUserId) {
      pendingMmUserId = maybeCaptureMmTokenForAuth(data, deps.resolveMmUserId)
        .then((resolvedId) => {
          if (resolvedId && !mmUserId) {
            mmUserId = resolvedId;
            deps.log(`[mm-proxy/ws] authenticated mmUserId=${resolvedId}`);
          }
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
    if (upstreamOpen && upstream.readyState === 1 ) {
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

  browserWs.on("close", (code: number, reason: unknown) => {
    logClose("browser", code, reason);
    close();
  });
  upstream.on("close", (code: number, reason: unknown) => {
    logClose("upstream", code, reason);
    close();
  });
  browserWs.on("error", (err: Error) =>
    deps.log(`[mm-proxy/ws] browser error: ${err.message}`),
  );
  upstream.on("error", (err: Error) =>
    deps.log(`[mm-proxy/ws] upstream error: ${err.message}`),
  );

  return { close };
}

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

function reasonToStr(reason: unknown): string {
  if (reason == null) return "";
  const str = Buffer.isBuffer(reason) ? reason.toString("utf-8") : String(reason);
  return str.length > 120 ? `${str.slice(0, 120)}…` : str;
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
    if (ws.readyState !== 3 ) ws.close();
  } catch {
    /* ignore */
  }
}

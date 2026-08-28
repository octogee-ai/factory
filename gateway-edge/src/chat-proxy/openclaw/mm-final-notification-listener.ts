import type { WebSocket } from "ws";
import type { BridgeLog } from "../bridge-log.js";

export interface CoachDmEventPayload {
  coachMmUserId: string;
  channelId: string;
  postId: string;
  message: string;
  createdAt: number;
}

export interface CoachWsSubject {
  coachMmUserId: string;
  coachToken: string;
}

export interface MmFinalNotificationListenerDeps {
  log: BridgeLog;
  openWebSocket: () => WebSocket;
  onCoachDm: (payload: CoachDmEventPayload) => void;
  backoffSchedule?: ReadonlyArray<number>;
  postSettleMs?: number;
}

export interface MmFinalNotificationListenerManager {
  addCoach(subject: CoachWsSubject): void;
  removeCoach(coachMmUserId: string): void;
  stop(): void;
}

const DEFAULT_BACKOFF = [1_000, 5_000, 15_000, 30_000] as const;
const DEFAULT_POST_SETTLE_MS = 750;
const MAX_TRACKED_POSTS = 500;

interface CoachConnection {
  token: string;
  stopped: boolean;
  attempt: number;
  currentWs: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface BufferedCoachPost extends CoachDmEventPayload {
  fingerprint: string;
}

function parseCoachPost(data: unknown, coachMmUserId: string): BufferedCoachPost | null {
  const envelope = data as Record<string, unknown> | undefined;
  if (!envelope || typeof envelope.post !== "string") return null;
  let post: Record<string, unknown>;
  try {
    const parsed = JSON.parse(envelope.post) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    post = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const props = post.props;
  if (props !== null && typeof props === "object" && "octogee" in props) return null;
  const postId = typeof post.id === "string" ? post.id : "";
  const channelId = typeof post.channel_id === "string" ? post.channel_id : "";
  const authorId = typeof post.user_id === "string" ? post.user_id : "";
  if (!postId || !channelId || authorId !== coachMmUserId) return null;
  const message = typeof post.message === "string" ? post.message : "";
  const createdAt = typeof post.create_at === "number" ? post.create_at : Date.now();
  const updatedAt = typeof post.update_at === "number" ? post.update_at : createdAt;
  return {
    coachMmUserId,
    channelId,
    postId,
    message,
    createdAt,
    fingerprint: `${updatedAt}:${message}`,
  };
}

function safeToString(data: unknown): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return typeof data === "string" ? data : "";
}

export function startMmFinalNotificationListeners(
  deps: MmFinalNotificationListenerDeps,
): MmFinalNotificationListenerManager {
  const backoff = deps.backoffSchedule ?? DEFAULT_BACKOFF;
  const settleMs = deps.postSettleMs ?? DEFAULT_POST_SETTLE_MS;
  const connections = new Map<string, CoachConnection>();
  const posts = new Map<string, BufferedCoachPost>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const notifiedPostIds = new Set<string>();
  let managerStopped = false;

  const cancelPost = (postId: string): void => {
    const timer = timers.get(postId);
    if (timer) clearTimeout(timer);
    timers.delete(postId);
  };

  const flushPost = (postId: string, fingerprint: string): void => {
    timers.delete(postId);
    const post = posts.get(postId);
    if (!post || post.fingerprint !== fingerprint || notifiedPostIds.has(postId)) return;
    if (!post.message.trim()) return;
    notifiedPostIds.add(postId);
    try {
      deps.onCoachDm({
        coachMmUserId: post.coachMmUserId,
        channelId: post.channelId,
        postId: post.postId,
        message: post.message,
        createdAt: post.createdAt,
      });
    } catch (error) {
      deps.log(
        `[mm-event-listener] onCoachDm handler threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
    }
  };

  const rememberPost = (data: unknown, coachMmUserId: string): void => {
    const post = parseCoachPost(data, coachMmUserId);
    if (!post || notifiedPostIds.has(post.postId)) return;
    cancelPost(post.postId);
    posts.delete(post.postId);
    posts.set(post.postId, post);
    while (posts.size > MAX_TRACKED_POSTS) {
      const oldestPostId = posts.keys().next().value as string | undefined;
      if (!oldestPostId) break;
      cancelPost(oldestPostId);
      posts.delete(oldestPostId);
      notifiedPostIds.delete(oldestPostId);
    }
    if (!post.message.trim()) return;
    if (settleMs <= 0) {
      flushPost(post.postId, post.fingerprint);
      return;
    }
    const timer = setTimeout(() => flushPost(post.postId, post.fingerprint), settleMs);
    timer.unref?.();
    timers.set(post.postId, timer);
  };

  const scheduleReconnect = (coachMmUserId: string, conn: CoachConnection): void => {
    if (conn.stopped || managerStopped || conn.reconnectTimer) return;
    const delayMs = backoff[Math.min(conn.attempt, backoff.length - 1)] ?? 30_000;
    conn.attempt += 1;
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null;
      connect(coachMmUserId, conn);
    }, delayMs);
    conn.reconnectTimer.unref?.();
  };

  const connect = (coachMmUserId: string, conn: CoachConnection): void => {
    if (conn.stopped || managerStopped) return;
    let ws: WebSocket;
    try {
      ws = deps.openWebSocket();
    } catch (error) {
      deps.log(
        `[mm-event-listener] openWebSocket threw for coach ${coachMmUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "warn",
      );
      scheduleReconnect(coachMmUserId, conn);
      return;
    }
    conn.currentWs = ws;
    ws.on("open", () => {
      try {
        ws.send(JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token: conn.token },
        }));
      } catch (error) {
        deps.log(
          `[mm-event-listener] auth send failed for coach ${coachMmUserId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warn",
        );
      }
    });
    ws.on("message", (data: unknown) => {
      const raw = safeToString(data);
      if (!raw) return;
      try {
        const envelope = JSON.parse(raw) as { event?: unknown; data?: unknown };
        if (envelope.event === "posted" || envelope.event === "post_edited") {
          rememberPost(envelope.data, coachMmUserId);
        }
      } catch {
        return;
      }
    });
    ws.on("close", () => {
      conn.currentWs = null;
      scheduleReconnect(coachMmUserId, conn);
    });
    ws.on("error", () => undefined);
  };

  const teardown = (conn: CoachConnection): void => {
    conn.stopped = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try {
      conn.currentWs?.close();
    } catch {
      return;
    }
  };

  return {
    addCoach(subject) {
      if (managerStopped || !subject.coachMmUserId || !subject.coachToken) return;
      const existing = connections.get(subject.coachMmUserId);
      if (existing?.token === subject.coachToken) return;
      if (existing) teardown(existing);
      const conn: CoachConnection = {
        token: subject.coachToken,
        stopped: false,
        attempt: 0,
        currentWs: null,
        reconnectTimer: null,
      };
      connections.set(subject.coachMmUserId, conn);
      connect(subject.coachMmUserId, conn);
    },
    removeCoach(coachMmUserId) {
      const conn = connections.get(coachMmUserId);
      if (!conn) return;
      teardown(conn);
      connections.delete(coachMmUserId);
      for (const [postId, post] of posts) {
        if (post.coachMmUserId !== coachMmUserId) continue;
        cancelPost(postId);
        posts.delete(postId);
        notifiedPostIds.delete(postId);
      }
    },
    stop() {
      managerStopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      posts.clear();
      notifiedPostIds.clear();
      for (const conn of connections.values()) teardown(conn);
      connections.clear();
    },
  };
}

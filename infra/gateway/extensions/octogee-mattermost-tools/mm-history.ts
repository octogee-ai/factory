/**
 * `mattermost_history` HTTP layer — channel browsing in time order.
 * Spec §4.2.
 */

import type { MmClient } from "./mm-client.js";
import type { MmChannelMeta, MmPostsBundle } from "./shape.js";

export type Direction = "latest" | "before" | "after" | "unread" | "around";

export interface HistoryParams {
  /** Resolved channel id (caller does name → id resolution). */
  channelId: string;
  /** Coach's MM user id — required by `unread` endpoint. */
  coachMmUserId: string;
  direction?: Direction;
  /** Required for `before`, `after`, `around`. Post id. */
  cursor?: string;
  /** 1-50, default 25. For `around`, splits roughly half/half. */
  limit?: number;
  /** Filter to posts by this MM username (no `@`); applied client-side. */
  fromUsername?: string;
  /** Map of MM users for fromUsername filter resolution; supplied by caller. */
  userIndex?: Map<string, string>; // username → user_id
}

export interface HistoryResponse {
  bundle: MmPostsBundle;
  channelMeta?: MmChannelMeta;
  /** Post id at the oldest end of the page — pass as cursor with direction=before to page back. */
  nextCursor: string | null;
  /** Post id at the newest end of the page. */
  prevCursor: string | null;
  /** Hint, not guaranteed — MM doesn't always tell us. */
  hasMore: boolean;
  raw: { tookMs: number };
}

export class HistoryParamError extends Error {
  constructor(
    public readonly code: "missing-cursor" | "missing-channel" | "invalid-direction",
    message: string,
  ) {
    super(message);
    this.name = "HistoryParamError";
  }
}

export async function mmHistory(
  client: MmClient,
  pat: string,
  params: HistoryParams,
): Promise<HistoryResponse> {
  const direction: Direction = params.direction ?? "latest";
  const limit = clamp(params.limit ?? 25, 1, 50);
  const path = endpointFor(direction, params.channelId, params.coachMmUserId, params.cursor, limit);

  const t0 = Date.now();
  const raw = await client.get(path, pat);
  const tookMs = Date.now() - t0;

  let bundle: MmPostsBundle = {
    posts: (raw && typeof raw === "object" ? raw.posts : null) ?? {},
    order: Array.isArray(raw?.order) ? raw.order : [],
  };

  // Apply from_user filter (spec §4.2 — client-side).
  if (params.fromUsername && params.userIndex) {
    const userId = params.userIndex.get(params.fromUsername);
    if (userId) {
      bundle = filterByUser(bundle, userId);
    } else {
      // Unknown username → empty result. Do NOT silently drop the filter,
      // that would mislead the agent into thinking the user has zero posts
      // when really we just couldn't resolve them.
      bundle = { posts: {}, order: [] };
    }
  }

  // MM returns posts NEWEST-first in `order`; spec §4.2 ships them
  // OLDEST-first to the agent so it reads chronologically. Reverse here.
  const orderOldestFirst = [...bundle.order].reverse();
  const oldest = orderOldestFirst[0] ?? null;
  const newest = orderOldestFirst[orderOldestFirst.length - 1] ?? null;

  return {
    bundle: { posts: bundle.posts, order: orderOldestFirst },
    channelMeta: undefined,
    nextCursor: oldest, // pass with direction=before to page further back
    prevCursor: newest,
    hasMore: typeof raw?.has_next === "boolean" ? raw.has_next : orderOldestFirst.length >= limit,
    raw: { tookMs },
  };
}

function endpointFor(
  direction: Direction,
  channelId: string,
  coachMmUserId: string,
  cursor: string | undefined,
  limit: number,
): string {
  switch (direction) {
    case "latest":
      return `/api/v4/channels/${channelId}/posts?per_page=${limit}`;
    case "before":
      requireCursor(cursor, "before");
      return `/api/v4/channels/${channelId}/posts?before=${encodeURIComponent(cursor!)}&per_page=${limit}`;
    case "after":
      requireCursor(cursor, "after");
      return `/api/v4/channels/${channelId}/posts?after=${encodeURIComponent(cursor!)}&per_page=${limit}`;
    case "unread":
      // MM API: ?limit_before=0 says "no posts older than last_viewed_at",
      // ?limit_after={N} says "up to N posts newer than last_viewed_at".
      // Side effect: this endpoint advances last_viewed_at as a documented
      // MM behavior (spec §6 acceptance — matches human client semantics).
      return `/api/v4/users/${coachMmUserId}/channels/${channelId}/posts/unread?limit_before=0&limit_after=${limit}`;
    case "around": {
      requireCursor(cursor, "around");
      // Symmetric split (spec §10 #6). Min 1 each side; if limit is odd,
      // the extra goes to `after` (more weight to newer context).
      const half = Math.max(1, Math.floor(limit / 2));
      const limitBefore = half;
      const limitAfter = Math.max(1, limit - half);
      return `/api/v4/channels/${channelId}/posts/${encodeURIComponent(cursor!)}/around?limit_before=${limitBefore}&limit_after=${limitAfter}`;
    }
    default: {
      const _exhaustive: never = direction;
      throw new HistoryParamError("invalid-direction", `unknown direction: ${_exhaustive}`);
    }
  }
}

function requireCursor(cursor: string | undefined, direction: Direction): void {
  if (!cursor) {
    throw new HistoryParamError(
      "missing-cursor",
      `direction "${direction}" requires a cursor (post id)`,
    );
  }
}

function filterByUser(bundle: MmPostsBundle, userId: string): MmPostsBundle {
  const order: string[] = [];
  const posts: Record<string, any> = {};
  for (const id of bundle.order) {
    const p = bundle.posts[id];
    if (p && p.user_id === userId) {
      order.push(id);
      posts[id] = p;
    }
  }
  return { order, posts };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Shape Mattermost API responses into the per-post objects the Coach sees.
 *
 * Boundary rule (spec §2.3.8): coach-authored posts are filtered out here.
 * Reasons:
 *   - Prevents echo (Coach searches → finds its own past replies → cites them).
 *   - Keeps the agent's "evidence from the team" honest — what others said,
 *     not what the Coach itself wrote earlier.
 * The filter is a hard rule, not a config switch.
 */

export interface MmPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number; // ms
  root_id?: string;
  delete_at?: number;
  type?: string;
}

/** Subset of `posts` + `order` returned by GET /channels/{id}/posts and POST /search. */
export interface MmPostsBundle {
  posts: Record<string, MmPost>;
  order: string[];
}

export interface MmChannelMeta {
  id: string;
  name: string;
  display_name: string;
  team_id?: string;
}

export interface MmUserMeta {
  id: string;
  username: string;
  first_name?: string;
  last_name?: string;
  nickname?: string;
}

export interface ShapeContext {
  /** Coach's own MM user id. Posts authored by this id are filtered out. */
  coachMmUserId: string;
  /** Public site URL for permalink construction, e.g. https://mattermost.octogee.com */
  siteUrl: string;
  /** MM team name (== customer slug). Used in permalink path. */
  teamName: string;
  /** Optional preloaded channel/user lookups (search returns these inline; history needs separate fetch). */
  channels?: Map<string, MmChannelMeta>;
  users?: Map<string, MmUserMeta>;
  /** Search query — used to choose snippet anchor. Empty → snippet from start. */
  query?: string;
}

export interface CoachPost {
  post_id: string;
  channel: { name: string; display_name: string };
  author:  { username: string; display_name: string };
  created_at: string; // ISO 8601 UTC
  permalink: string;
  snippet: string;
  thread_root_id: string | null;
}

const SNIPPET_LEN = 200;

function displayName(u: MmUserMeta | undefined): string {
  if (!u) return "(unknown)";
  if (u.nickname) return u.nickname;
  const full = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim();
  return full || u.username || "(unknown)";
}

function buildPermalink(siteUrl: string, teamName: string, postId: string): string {
  // Strip ONE trailing slash if present. siteUrl is operator-controlled config,
  // not user input — pathological inputs like "//" aren't a realistic concern.
  // Avoid `/\/+$/` here (eslint's sonarjs/slow-regex flags it as
  // backtracking-prone even though the anchor makes it linear).
  const base = siteUrl.endsWith("/") ? siteUrl.slice(0, -1) : siteUrl;
  // MM permalink convention: <site>/<team_name>/pl/<post_id>
  return `${base}/${teamName}/pl/${postId}`;
}

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeSnippet(message: string, query?: string): string {
  const text = (message ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= SNIPPET_LEN) return text;
  if (!query) return text.slice(0, SNIPPET_LEN) + "…";

  // Find the longest token from the query and anchor the snippet around it.
  // Strip MM search operators (from:, in:, before:, after:) before tokenizing.
  const stripped = query
    .replace(/\b(?:from|in|before|after):\S+/gi, " ")
    .toLowerCase();
  const tokens = stripped
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);

  const lower = text.toLowerCase();
  for (const tok of tokens) {
    const idx = lower.indexOf(tok);
    if (idx === -1) continue;
    const start = Math.max(0, idx - Math.floor(SNIPPET_LEN / 3));
    const end = Math.min(text.length, start + SNIPPET_LEN);
    const prefix = start > 0 ? "…" : "";
    const suffix = end < text.length ? "…" : "";
    return prefix + text.slice(start, end) + suffix;
  }
  return text.slice(0, SNIPPET_LEN) + "…";
}

export interface ShapedBundle {
  posts: CoachPost[];
  /** Total returned by MM after coach-author filter applied. */
  total: number;
}

/**
 * Order-preserving shape. Drops:
 *   - Coach-authored posts (boundary §2.3.8).
 *   - Soft-deleted posts (`delete_at > 0`).
 *   - System messages (`type` non-empty — joins, leaves, etc.).
 *   - Posts whose channel/author can't be hydrated (defensive — should not happen).
 */
export function shapeBundle(
  bundle: MmPostsBundle,
  ctx: ShapeContext,
): ShapedBundle {
  const out: CoachPost[] = [];
  for (const id of bundle.order ?? []) {
    const post = bundle.posts?.[id];
    if (!shouldShapePost(post, ctx)) continue;
    const shaped = shapePost(post, ctx);
    if (shaped) out.push(shaped);
  }
  return { posts: out, total: out.length };
}

function shouldShapePost(post: MmPost | undefined, ctx: ShapeContext): post is MmPost {
  if (!post) return false;
  if (post.user_id === ctx.coachMmUserId) return false;
  if ((post.delete_at ?? 0) > 0) return false;
  if (post.type && post.type !== "") return false;
  return true;
}

function shapePost(post: MmPost, ctx: ShapeContext): CoachPost | null {
  const channel = ctx.channels?.get(post.channel_id);
  if (!channel) return null;
  const author = ctx.users?.get(post.user_id);
  return {
    post_id: post.id,
    channel: {
      name: channel.name,
      display_name: channel.display_name,
    },
    author: {
      username: author?.username ?? "(unknown)",
      display_name: displayName(author),
    },
    created_at: isoFromMs(post.create_at),
    permalink: buildPermalink(ctx.siteUrl, ctx.teamName, post.id),
    snippet: makeSnippet(post.message, ctx.query),
    thread_root_id: post.root_id && post.root_id !== "" ? post.root_id : null,
  };
}

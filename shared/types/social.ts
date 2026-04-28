/**
 * Social edges — Star + Follow target types and doc-id derivation.
 *
 * Per BUILDER-SOCIAL-SPEC §10.1:
 *
 *   stars/{actorUid}_{type}_{targetId}     ← Builder · Project · Post
 *   follows/{actorUid}_{type}_{targetId}   ← Builder · Project (no Post)
 *
 * The doc id is computed from the actor + target so the optimistic-toggle
 * pattern can hit `getDoc(stars/{key})` without a query. The id is opaque
 * to readers — `targetType`, `targetId`, and `targetOwnerUid` live as
 * fields on the doc for query and CF-aggregator use.
 */

// ── Target discriminated unions ──────────────────────────────────────────

export interface StarTargetBuilder {
  type: 'builder';
  /** Firebase UID of the Builder being starred. */
  ownerUid: string;
  /** Username (= workspace slug) — denormed for cheap UI lookups. */
  username: string;
}

export interface StarTargetProject {
  type: 'project';
  /** Workspace slug = the owner's username. Same as `workspaceId` in v3.1 — the URL slug. */
  workspaceSlug: string;
  /** Project slug — unique within the workspace. */
  projectSlug: string;
  /** Firebase UID of the project's owner — denormed for owner-attribution + notifications. */
  ownerUid: string;
}

export interface StarTargetPost {
  type: 'post';
  /** Post doc id — `posts/{postId}`. */
  postId: string;
  /** Firebase UID of the post author. */
  ownerUid: string;
}

export type StarTarget = StarTargetBuilder | StarTargetProject | StarTargetPost;

/** Follow targets are a subset — Posts are not Followable (use Star instead). */
export type FollowTarget = StarTargetBuilder | StarTargetProject;

// ── Doc id derivation ────────────────────────────────────────────────────

/**
 * Stable doc id for a star edge. Deterministic over (actor, target) so the
 * optimistic toggle can read/write `stars/{starDocId(...)}` directly.
 *
 * Format: `{actorUid}_{shortType}_{targetSlug}`
 *   - shortType: 'b' (builder), 'p' (project), 'post' (post)
 *   - targetSlug:
 *     - builder  → ownerUid
 *     - project  → ${workspaceSlug}_${projectSlug}
 *     - post     → postId
 */
export function starDocId(actorUid: string, target: StarTarget): string {
  switch (target.type) {
    case 'builder':
      return `${actorUid}_b_${target.ownerUid}`;
    case 'project':
      return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
    case 'post':
      return `${actorUid}_post_${target.postId}`;
  }
}

/** Same shape as star (Posts excluded — type system enforces). */
export function followDocId(actorUid: string, target: FollowTarget): string {
  switch (target.type) {
    case 'builder':
      return `${actorUid}_b_${target.ownerUid}`;
    case 'project':
      return `${actorUid}_p_${target.workspaceSlug}_${target.projectSlug}`;
  }
}

// ── Type guards (for runtime validation, e.g. CF doc payload checks) ─────

export function isStarTarget(v: unknown): v is StarTarget {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  if (t === 'builder') {
    const b = v as Partial<StarTargetBuilder>;
    return typeof b.ownerUid === 'string' && typeof b.username === 'string';
  }
  if (t === 'project') {
    const p = v as Partial<StarTargetProject>;
    return typeof p.workspaceSlug === 'string'
      && typeof p.projectSlug === 'string'
      && typeof p.ownerUid === 'string';
  }
  if (t === 'post') {
    const p = v as Partial<StarTargetPost>;
    return typeof p.postId === 'string' && typeof p.ownerUid === 'string';
  }
  return false;
}

export function isFollowTarget(v: unknown): v is FollowTarget {
  if (!v || typeof v !== 'object') return false;
  const t = (v as { type?: unknown }).type;
  if (t === 'post') return false; // Posts aren't followable
  return isStarTarget(v);
}


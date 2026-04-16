/**
 * Workspace slug resolution — workspace-api helper.
 *
 * Per docs/DATA-MODEL-REVIEW.md §11 (v3 §6.8 finalized): username IS the
 * workspace slug. The user doc's `username` field is the single source of
 * truth. Callers fan out reads via this helper to stay forward-compatible
 * with a future multi-workspace model — today the list is always 0 or 1
 * entry.
 *
 * The prior `provisioning.openclaw.slug` fallback is retired; no writer in
 * the codebase has emitted that field separately from `username` since v3.
 */

export interface WorkspaceSlugSource {
  username?: string | null;
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function primaryWorkspaceSlug(
  data: WorkspaceSlugSource | null | undefined,
): string | null {
  return coerceString(data?.username);
}

/**
 * Returns the set of workspace slugs owned by this user. 0 or 1 entries
 * today; shaped as a list so callers stay forward-compatible with
 * multi-workspace users. Callers fan out reads via Promise.all — an empty
 * list collapses cleanly to zero reads.
 */
export function workspaceSlugsForUser(
  data: WorkspaceSlugSource | null | undefined,
): string[] {
  const slug = primaryWorkspaceSlug(data);
  return slug ? [slug] : [];
}

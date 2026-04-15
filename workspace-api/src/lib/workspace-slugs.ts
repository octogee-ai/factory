/**
 * Workspace slug resolution — workspace-api mirror (pure).
 *
 * SOURCE OF TRUTH: shared/types/workspaceSlug.ts. Like channelNames.ts, we
 * mirror the pure helpers locally because workspace-api has its own rootDir
 * / Docker build context and cannot import `shared/` directly. The drift
 * test at tests/specs/workspace-slug-drift.spec.ts pins both mirrors
 * together — any divergence fails CI.
 *
 * This file is pure (no logger, no Firestore) so it can be imported from
 * the cross-package drift test without dragging workspace-api's Express /
 * middleware dependency graph into the root tests package. Callers that
 * want to emit a warning when no slug is available should do so at the
 * call site — they already have the uid and the per-request logger
 * handy.
 *
 * Post-v3.1 everything workspace-scoped (usage_*, channels, projects,
 * canvas) lives under `workspaces/{slug}/...`. This file is the canonical
 * way to resolve a user's slug before fanning out any such read.
 */

export interface WorkspaceSlugSource {
  provisioning?: { openclaw?: { slug?: string | null } | null } | null;
  username?: string | null;
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function primaryWorkspaceSlug(
  data: WorkspaceSlugSource | null | undefined,
): string | null {
  const fromProvisioning = coerceString(data?.provisioning?.openclaw?.slug);
  if (fromProvisioning) return fromProvisioning;
  return coerceString(data?.username);
}

/**
 * Returns the set of v3.1 workspace slugs owned by this user. 0 or 1
 * entries today; shaped as a list so callers stay forward-compatible with
 * multi-workspace users. Callers fan out reads via Promise.all — an empty
 * list collapses cleanly to zero reads.
 */
export function workspaceSlugsForUser(
  data: WorkspaceSlugSource | null | undefined,
): string[] {
  const slug = primaryWorkspaceSlug(data);
  return slug ? [slug] : [];
}

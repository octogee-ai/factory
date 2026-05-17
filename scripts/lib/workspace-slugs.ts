export interface WorkspaceSlugSource {
  username?: string | null;
  provisioning?: {
    openclaw?: {
      slug?: string | null;
    } | null;
  } | null;
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function primaryWorkspaceSlug(
  data: WorkspaceSlugSource | null | undefined,
): string | null {
  return (
    coerceString(data?.provisioning?.openclaw?.slug) ??
    coerceString(data?.username)
  );
}

export function workspaceSlugsForUser(
  data: WorkspaceSlugSource | null | undefined,
): string[] {
  const slug = primaryWorkspaceSlug(data);
  return slug ? [slug] : [];
}
